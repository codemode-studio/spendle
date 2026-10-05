import * as Context from 'effect/Context'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'

import { Bucket, Categories } from '../categories/Categories.ts'
import { Categorizer } from '../categories/Categorizer.ts'
import { KnowledgeStore } from '../categories/KnowledgeStore.ts'
import type { ImportedPattern } from '../categories/Store.ts'
import * as Reactor from '../events/Reactor.ts'
import { Accounts } from '../ledger/Accounts.ts'
import { Entries, entriesResolved } from '../ledger/Entries.ts'
import type { LedgerEntry } from '../ledger/Entries.ts'
import {
  Reconciliation,
  relationsChanged,
} from '../reconciliation/Reconciliation.ts'
import {
  accountPlan,
  cardPlan,
  formatCents,
  ownerKind,
  planDecisions,
  recognise,
} from './Plan.ts'
import type { AccountPlan, Movement, Target, Unmapped } from './Plan.ts'
import type { V1Category, V1Snapshot } from './V1Database.ts'

/** How many records of one kind moved, were already there, or stayed behind. */
export interface Tally {
  readonly migrated: number
  readonly already: number
  readonly skipped: number
}

export interface PendingTally {
  readonly applied: number
  readonly pending: number
  readonly superseded: number
  readonly refused: number
}

/** A decision still waiting for its movement, and why. */
export interface Waiting {
  readonly kind: 'category_decision' | 'relation_decision'
  readonly v1Id: string
  readonly label: string
  readonly reason: 'not_observed' | 'ambiguous' | 'no_suggestion'
}

export interface Summary {
  readonly owners: Tally
  readonly accounts: Tally
  readonly cards: Tally
  readonly categories: Tally
  readonly knowledge: Tally
  readonly categoryDecisions: Tally
  readonly relationDecisions: Tally
  readonly unmapped: ReadonlyArray<Unmapped>
  /** V1 data V2 has no place for, by what it is. */
  readonly notMigrated: ReadonlyArray<{
    readonly what: string
    readonly count: number
  }>
  readonly coveredByKnowledge: number
  readonly pending: {
    readonly categories: PendingTally
    readonly relations: PendingTally
    readonly waiting: ReadonlyArray<Waiting>
  }
}

export interface Applied {
  readonly categories: PendingTally
  readonly relations: PendingTally
  readonly waiting: ReadonlyArray<Waiting>
}

const MapKind = Schema.Literals(['owner', 'account', 'card', 'category'])
type MapKind = typeof MapKind.Type

const MovementRow = Schema.Struct({
  v1TransactionId: Schema.String,
  accountId: Schema.String,
  bookedOn: Schema.String,
  amountCents: Schema.Int,
  descriptionKey: Schema.String,
  description: Schema.String,
  uniqueByDescription: Schema.BooleanFromBit,
  uniqueByAmount: Schema.BooleanFromBit,
})

const Status = Schema.Literals(['pending', 'applied', 'superseded', 'refused'])

const tally = () => ({ migrated: 0, already: 0, skipped: 0 })
const pendingTally = () => ({
  applied: 0,
  pending: 0,
  superseded: 0,
  refused: 0,
})

// Parents before their children, so each parent exists when a child names it.
const parentsFirst = (categories: ReadonlyArray<V1Category>) => {
  const byId = new Map(categories.map((category) => [category.id, category]))
  const ordered: Array<V1Category> = []
  const seen = new Set<string>()
  const visit = (category: V1Category, path: ReadonlySet<string>) => {
    if (seen.has(category.id) || path.has(category.id)) return
    const parent =
      category.parentId === null ? undefined : byId.get(category.parentId)
    if (parent) visit(parent, new Set([...path, category.id]))
    seen.add(category.id)
    ordered.push(category)
  }
  for (const category of categories) visit(category, new Set())
  return ordered
}

const isBucket = Schema.is(Bucket)

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const accounts = yield* Accounts
  const categories = yield* Categories
  const store = yield* KnowledgeStore
  const categorizer = yield* Categorizer
  const reconciliation = yield* Reconciliation
  const entries = yield* Entries

  const now = Effect.map(DateTime.now, DateTime.formatIso)

  const findMapped = SqlSchema.findAll({
    Request: MapKind,
    Result: Schema.Struct({ v1Id: Schema.String, v2Id: Schema.String }),
    execute: (kind) =>
      sql`SELECT v1_id AS v1Id, v2_id AS v2Id FROM v1_import_map WHERE kind = ${kind}`,
  })
  const mapped = (kind: MapKind) =>
    Effect.map(
      findMapped(kind),
      (rows) => new Map(rows.map((row) => [row.v1Id, row.v2Id])),
    )
  const remember = (kind: MapKind, v1Id: string, v2Id: string) =>
    Effect.gen(function* () {
      yield* sql`
        INSERT INTO v1_import_map (kind, v1_id, v2_id, imported_at)
        VALUES (${kind}, ${v1Id}, ${v2Id}, ${yield* now})
        ON CONFLICT (kind, v1_id) DO NOTHING
      `
    })

  const findMovements = SqlSchema.findAll({
    Request: Schema.Void,
    Result: MovementRow,
    execute: () => sql`
      SELECT v1_transaction_id AS v1TransactionId, account_id AS accountId,
        booked_on AS bookedOn, amount_cents AS amountCents,
        description_key AS descriptionKey, description,
        unique_by_description AS uniqueByDescription, unique_by_amount AS uniqueByAmount
      FROM v1_import_movements
    `,
  })
  const findCategoryDecisions = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({
      v1TransactionId: Schema.String,
      categoryId: Schema.String,
      status: Status,
    }),
    execute: () => sql`
      SELECT v1_transaction_id AS v1TransactionId, category_id AS categoryId, status
      FROM v1_import_category_decisions ORDER BY v1_transaction_id
    `,
  })
  const findRelationDecisions = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({
      v1GroupId: Schema.String,
      kind: Schema.Literals(['internal_transfer', 'card_payment', 'refund']),
      decision: Schema.Literals(['confirmed', 'rejected']),
      outflow: Schema.String,
      inflow: Schema.String,
      status: Status,
    }),
    execute: () => sql`
      SELECT v1_group_id AS v1GroupId, kind, decision,
        outflow_v1_transaction_id AS outflow, inflow_v1_transaction_id AS inflow, status
      FROM v1_import_relation_decisions ORDER BY v1_group_id
    `,
  })
  // Whether a stored category decision already covers the entry: the
  // person decided it in V2, or an earlier import did.
  const findDecided = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({ key: Schema.String }),
    execute: (entryId) => sql`
      SELECT DISTINCT p.key FROM category_decision_endpoints p
      JOIN entry_evidence v ON v.source_id = p.source_id AND v.account_id = p.account_id
        AND v.external_id = p.external_id
      WHERE v.entry_id = ${entryId}
    `,
  })

  const resolveCategory = (
    v1TransactionId: string,
    status: 'applied' | 'superseded' | 'refused',
    entryId: string | null,
    detail: string | null,
  ) =>
    Effect.gen(function* () {
      yield* sql`
        UPDATE v1_import_category_decisions SET status = ${status}, entry_id = ${entryId},
          detail = ${detail}, resolved_at = ${yield* now}
        WHERE v1_transaction_id = ${v1TransactionId}
      `
    })
  const resolveRelation = (
    v1GroupId: string,
    status: 'applied' | 'superseded' | 'refused',
    relationKey: string | null,
    detail: string | null,
  ) =>
    Effect.gen(function* () {
      yield* sql`
        UPDATE v1_import_relation_decisions SET status = ${status},
          relation_key = ${relationKey}, detail = ${detail}, resolved_at = ${yield* now}
        WHERE v1_group_id = ${v1GroupId}
      `
    })

  /**
   * Applies every waiting V1 decision whose movements V2 now recognises as
   * exactly one entry each. A category goes through `Categorizer.decide`
   * without teaching the store (its pattern came over with the knowledge
   * base); a verdict through reconciliation. Decisions the person made in
   * V2 meanwhile win.
   */
  const applyPending = Effect.fn('V1Import.applyPending')(function* () {
    const categoryRows = yield* findCategoryDecisions(undefined)
    const relationRows = yield* findRelationDecisions(undefined)
    const categoryTally = pendingTally()
    const relationTally = pendingTally()
    const waiting: Array<Waiting> = []
    const open =
      categoryRows.some((row) => row.status === 'pending') ||
      relationRows.some((row) => row.status === 'pending')
    const movements = open
      ? new Map(
          (yield* findMovements(undefined)).map((row) => [
            row.v1TransactionId,
            row satisfies Movement,
          ]),
        )
      : new Map<string, Movement>()
    const entriesOf = new Map<string, ReadonlyArray<LedgerEntry>>()
    const find = (movement: Movement) =>
      Effect.gen(function* () {
        let list = entriesOf.get(movement.accountId)
        if (list === undefined) {
          list = yield* entries.entries(movement.accountId)
          entriesOf.set(movement.accountId, list)
        }
        return recognise(movement, list)
      })
    const label = (movement: Movement | undefined) =>
      movement
        ? `${movement.bookedOn} ${formatCents(movement.amountCents)} ${movement.description}`
        : ''

    for (const row of categoryRows) {
      if (row.status !== 'pending') {
        categoryTally[row.status]++
        continue
      }
      const movement = movements.get(row.v1TransactionId)!
      const found = yield* find(movement)
      if (found._tag !== 'Entry') {
        categoryTally.pending++
        waiting.push({
          kind: 'category_decision',
          v1Id: row.v1TransactionId,
          label: label(movement),
          reason: found._tag === 'Missing' ? 'not_observed' : 'ambiguous',
        })
        continue
      }
      if ((yield* findDecided(found.entryId)).length > 0) {
        yield* resolveCategory(
          row.v1TransactionId,
          'superseded',
          found.entryId,
          null,
        )
        categoryTally.superseded++
        continue
      }
      const outcome = yield* categorizer
        .decide(found.entryId, row.categoryId, {
          learn: false,
          origin: 'v1_import',
        })
        .pipe(
          Effect.as(Option.none<string>()),
          Effect.catchTag('CategorizerError', (error) =>
            Effect.succeed(Option.some(error.message)),
          ),
        )
      if (Option.isSome(outcome)) {
        yield* resolveCategory(
          row.v1TransactionId,
          'refused',
          found.entryId,
          outcome.value,
        )
        categoryTally.refused++
      } else {
        yield* resolveCategory(
          row.v1TransactionId,
          'applied',
          found.entryId,
          null,
        )
        categoryTally.applied++
      }
    }

    for (const row of relationRows) {
      if (row.status !== 'pending') {
        relationTally[row.status]++
        continue
      }
      const outflow = movements.get(row.outflow)!
      const inflow = movements.get(row.inflow)!
      const sides = [yield* find(outflow), yield* find(inflow)] as const
      const groupLabel = `${row.kind} ${row.decision}: ${label(outflow)} → ${label(inflow)}`
      if (sides[0]._tag !== 'Entry' || sides[1]._tag !== 'Entry') {
        relationTally.pending++
        waiting.push({
          kind: 'relation_decision',
          v1Id: row.v1GroupId,
          label: groupLabel,
          reason: sides.some((side) => side._tag === 'Ambiguous')
            ? 'ambiguous'
            : 'not_observed',
        })
        continue
      }
      const outflowEntryId = sides[0].entryId
      const inflowEntryId = sides[1].entryId
      const relation = (yield* reconciliation.relations).find(
        (found) =>
          found.outflowEntryId === outflowEntryId &&
          found.inflowEntryId === inflowEntryId,
      )
      const personConfirmed =
        relation?.status === 'confirmed' && relation.origin === 'person'
      if (row.decision === 'rejected' && relation === undefined) {
        // Nothing to reject until the matcher suggests the pair.
        relationTally.pending++
        waiting.push({
          kind: 'relation_decision',
          v1Id: row.v1GroupId,
          label: groupLabel,
          reason: 'no_suggestion',
        })
        continue
      }
      if (personConfirmed) {
        const status = row.decision === 'confirmed' ? 'applied' : 'superseded'
        yield* resolveRelation(row.v1GroupId, status, relation.key, null)
        relationTally[status]++
        continue
      }
      const outcome = yield* (
        relation !== undefined
          ? reconciliation
              .decide(relation.key, row.decision)
              .pipe(Effect.as(relation.key))
          : reconciliation.link({ outflowEntryId, inflowEntryId })
      ).pipe(
        Effect.map((key) => ({ ok: true as const, key })),
        Effect.catchTag('ReconciliationError', (error) =>
          Effect.succeed({ ok: false as const, error }),
        ),
      )
      if (outcome.ok) {
        yield* resolveRelation(row.v1GroupId, 'applied', outcome.key, null)
        relationTally.applied++
      } else {
        // Another confirmation already holds one side: the person's V2 call.
        const status =
          outcome.error.reason === 'already_linked' ? 'superseded' : 'refused'
        yield* resolveRelation(
          row.v1GroupId,
          status,
          null,
          outcome.error.message,
        )
        relationTally[status]++
      }
    }
    return {
      categories: categoryTally,
      relations: relationTally,
      waiting,
    } satisfies Applied
  })

  const openAccounts = Effect.fnUntraced(function* (
    kind: 'account' | 'card',
    items: ReadonlyArray<{ readonly id: string; readonly name: string }>,
    plan: (item: number, ownerId: string) => AccountPlan,
    owners: ReadonlyMap<string, string>,
    ownerOf: (item: number) => string,
    unmapped: Array<Unmapped>,
  ) {
    const counts = tally()
    const known = yield* mapped(kind)
    for (const [index, item] of items.entries()) {
      if (known.has(item.id)) {
        counts.already++
        continue
      }
      const ownerId = owners.get(ownerOf(index))
      if (ownerId === undefined) {
        counts.skipped++
        unmapped.push({
          kind,
          v1Id: item.id,
          label: item.name,
          reason: 'its owner was not migrated',
        })
        continue
      }
      const planned = plan(index, ownerId)
      if (planned._tag === 'Skip') {
        counts.skipped++
        unmapped.push({
          kind,
          v1Id: item.id,
          label: item.name,
          reason: planned.reason,
        })
        continue
      }
      const opened = yield* accounts.open(planned.input)
      if (planned.archived) yield* accounts.setArchived(opened.id, true)
      yield* remember(kind, item.id, opened.id)
      counts.migrated++
    }
    return counts
  })

  /**
   * Moves the V1 snapshot's configuration and human decisions into V2,
   * then applies the decisions whose movements V2 already holds. Running
   * it again with the same snapshot changes nothing.
   */
  const run = Effect.fn('V1Import.run')(function* (snapshot: V1Snapshot) {
    const unmapped: Array<Unmapped> = []

    const owners = tally()
    const knownOwners = yield* mapped('owner')
    for (const owner of snapshot.owners) {
      if (knownOwners.has(owner.id)) {
        owners.already++
        continue
      }
      const created = yield* accounts.createOwner({
        name: owner.name.trim() || 'Titular',
        kind: ownerKind(owner.type),
      })
      yield* remember('owner', owner.id, created.id)
      owners.migrated++
    }
    const ownerIds = yield* mapped('owner')

    const accountTally = yield* openAccounts(
      'account',
      snapshot.accounts,
      (index, ownerId) => accountPlan(snapshot.accounts[index]!, ownerId),
      ownerIds,
      (index) => snapshot.accounts[index]!.ownerId,
      unmapped,
    )
    const cardTally = yield* openAccounts(
      'card',
      snapshot.cards,
      (index, ownerId) => cardPlan(snapshot.cards[index]!, ownerId),
      ownerIds,
      (index) => snapshot.cards[index]!.ownerId,
      unmapped,
    )

    const categoryTally = tally()
    const knownCategories = yield* mapped('category')
    for (const category of parentsFirst(snapshot.categories)) {
      if (knownCategories.has(category.id)) {
        categoryTally.already++
        continue
      }
      if (!isBucket(category.bucket)) {
        categoryTally.skipped++
        unmapped.push({
          kind: 'category',
          v1Id: category.id,
          label: category.name,
          reason: `unknown bucket ${category.bucket}`,
        })
        continue
      }
      const outcome = yield* categories
        .importV1({ ...category, bucket: category.bucket })
        .pipe(
          Effect.map((result) => ({ ok: true as const, result })),
          Effect.catchTag('CategoriesError', (error) =>
            Effect.succeed({ ok: false as const, error }),
          ),
        )
      if (!outcome.ok) {
        categoryTally.skipped++
        unmapped.push({
          kind: 'category',
          v1Id: category.id,
          label: category.name,
          reason: outcome.error.message,
        })
        continue
      }
      yield* remember('category', category.id, category.id)
      categoryTally.migrated++
    }

    const knowledgeTally = tally()
    const patterns: Array<ImportedPattern> = []
    const patternLabels: Array<{ id: string; label: string }> = []
    let recurrencePatterns = 0
    for (const row of snapshot.knowledge) {
      if (row.kind !== 'category') {
        recurrencePatterns++
        continue
      }
      const label = `${row.pattern} (${row.matchMode}, ${row.direction})`
      if (
        row.categoryId === null ||
        (row.matchMode !== 'exact' && row.matchMode !== 'prefix') ||
        (row.direction !== 'income' && row.direction !== 'expense')
      ) {
        knowledgeTally.skipped++
        unmapped.push({
          kind: 'knowledge',
          v1Id: row.id,
          label,
          reason: 'malformed row',
        })
        continue
      }
      patterns.push({
        id: row.id,
        pattern: row.pattern,
        matchMode: row.matchMode,
        direction: row.direction,
        categoryId: row.categoryId,
        signature: row.signature,
        sampleDescription: row.sampleDescription,
        confirmations: row.confirmations,
        corrections: row.corrections,
        lastLearnedAt: DateTime.formatIso(
          DateTime.makeUnsafe(row.lastLearnedAt * 1000),
        ),
      })
      patternLabels.push({ id: row.id, label })
    }
    const outcomes = yield* store.importV1(patterns)
    outcomes.forEach((outcome, index) => {
      const { id, label } = patternLabels[index]!
      if (outcome === 'added') knowledgeTally.migrated++
      else if (outcome === 'present') knowledgeTally.already++
      else {
        knowledgeTally.skipped++
        unmapped.push({
          kind: 'knowledge',
          v1Id: id,
          label,
          reason:
            outcome === 'taken'
              ? 'V2 already has a pattern with this text, mode and direction'
              : outcome === 'invalid_pattern'
                ? 'pattern too short or without a letter'
                : 'its category is archived, a system one or uncategorized in V2',
        })
      }
    })

    // Where each V1 account or card lives in V2 now.
    const targets = new Map<string, Target>()
    for (const kind of ['account', 'card'] as const) {
      for (const [v1Id, v2Id] of yield* mapped(kind)) {
        const account = yield* accounts.get(v2Id)
        targets.set(`${kind}:${v1Id}`, {
          accountId: account.id,
          currency: account.currency,
        })
      }
    }
    const plan = planDecisions({
      snapshot,
      targets,
      store: yield* store.rows,
      categories: yield* categories.list,
    })
    unmapped.push(...plan.unmapped)

    const categoryDecisionTally = tally()
    const relationDecisionTally = tally()
    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (const movement of plan.movements.values()) {
          yield* sql`
            INSERT INTO v1_import_movements (v1_transaction_id, account_id, booked_on,
              amount_cents, description_key, description, unique_by_description, unique_by_amount)
            VALUES (${movement.v1TransactionId}, ${movement.accountId}, ${movement.bookedOn},
              ${movement.amountCents}, ${movement.descriptionKey}, ${movement.description},
              ${movement.uniqueByDescription ? 1 : 0}, ${movement.uniqueByAmount ? 1 : 0})
            ON CONFLICT (v1_transaction_id) DO NOTHING
          `
        }
        for (const decision of plan.categories) {
          const inserted = yield* sql`
            INSERT INTO v1_import_category_decisions (v1_transaction_id, category_id, status)
            VALUES (${decision.v1TransactionId}, ${decision.categoryId}, 'pending')
            ON CONFLICT (v1_transaction_id) DO NOTHING
            RETURNING v1_transaction_id
          `
          if (inserted.length > 0) categoryDecisionTally.migrated++
          else categoryDecisionTally.already++
        }
        for (const decision of plan.relations) {
          const inserted = yield* sql`
            INSERT INTO v1_import_relation_decisions (v1_group_id, kind, decision,
              outflow_v1_transaction_id, inflow_v1_transaction_id, status)
            VALUES (${decision.v1GroupId}, ${decision.kind}, ${decision.decision},
              ${decision.outflow}, ${decision.inflow}, 'pending')
            ON CONFLICT (v1_group_id) DO NOTHING
            RETURNING v1_group_id
          `
          if (inserted.length > 0) relationDecisionTally.migrated++
          else relationDecisionTally.already++
        }
      }),
    )
    categoryDecisionTally.skipped = plan.unmapped.filter(
      (item) => item.kind === 'category_decision',
    ).length
    relationDecisionTally.skipped = plan.unmapped.filter(
      (item) => item.kind === 'relation_decision',
    ).length

    const applied = yield* applyPending()
    const { uncovered } = snapshot
    const notMigrated = [
      { what: 'transactions typed in by hand', count: plan.manualTransactions },
      { what: 'recurrences', count: uncovered.recurrences },
      {
        what: 'recurrence patterns in the knowledge base',
        count: recurrencePatterns,
      },
      { what: 'transaction splits', count: uncovered.splits },
      {
        what: 'card instruments (physical or virtual cards)',
        count: uncovered.cardInstruments,
      },
      { what: 'categorization rules', count: uncovered.categorizationRules },
      { what: 'monthly budgets', count: uncovered.budgets },
      { what: 'investment goals', count: uncovered.goals },
      { what: 'investment positions', count: uncovered.investmentPositions },
    ].filter((item) => item.count > 0)

    return {
      owners,
      accounts: accountTally,
      cards: cardTally,
      categories: categoryTally,
      knowledge: knowledgeTally,
      categoryDecisions: categoryDecisionTally,
      relationDecisions: relationDecisionTally,
      unmapped,
      notMigrated,
      coveredByKnowledge: plan.coveredByKnowledge,
      pending: applied,
    } satisfies Summary
  })

  return { run, applyPending }
})

export class V1Import extends Context.Service<
  V1Import,
  Effect.Success<typeof make>
>()('@spendle/server/v1import/V1Import') {
  static readonly layer = Layer.effect(V1Import, make)
}

/**
 * Applies waiting V1 decisions as their movements resolve into entries, and
 * waiting rejections once the matcher suggests their pair.
 */
export const reactor = Reactor.layer({
  name: 'v1-import',
  types: [entriesResolved, relationsChanged],
  handle: () =>
    Effect.gen(function* () {
      yield* (yield* V1Import).applyPending()
    }),
})
