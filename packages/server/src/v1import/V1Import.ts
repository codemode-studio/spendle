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
import { Investments } from '../investments/Investments.ts'
import { Accounts } from '../ledger/Accounts.ts'
import { Entries, entriesResolved } from '../ledger/Entries.ts'
import type { LedgerEntry } from '../ledger/Entries.ts'
import { ManualEntries } from '../ledger/Manual.ts'
import { Notes } from '../ledger/Notes.ts'
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
import { today } from '../domain/LocalDate.ts'

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
  readonly kind:
    | 'category_decision'
    | 'relation_decision'
    | 'recurrence_link'
    | 'note'
    | 'investment_movement'
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
  readonly manualTransactions: Tally
  readonly checkpoints: Tally
  readonly positions: Tally
  readonly notes: Tally
  readonly investmentMovements: Tally
  readonly unmapped: ReadonlyArray<Unmapped>
  /** V1 data V2 has no place for, by what it is. */
  readonly notMigrated: ReadonlyArray<{
    readonly what: string
    readonly count: number
  }>
  readonly coveredByKnowledge: number
  readonly pending: Applied
}

export interface Applied {
  readonly categories: PendingTally
  readonly relations: PendingTally
  readonly notes: PendingTally
  readonly investmentMovements: PendingTally
  readonly waiting: ReadonlyArray<Waiting>
}

const LedgerKind = Schema.Literals([
  'position',
  'asset_class',
  'manual_transaction',
  'checkpoint',
  'valuation',
])
type LedgerKind = typeof LedgerKind.Type

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
  const manualEntries = yield* ManualEntries
  const notes = yield* Notes
  const investments = yield* Investments

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

  const findLedgerMapped = SqlSchema.findAll({
    Request: LedgerKind,
    Result: Schema.Struct({ v1Id: Schema.String, v2Id: Schema.String }),
    execute: (kind) =>
      sql`SELECT v1_id AS v1Id, v2_id AS v2Id FROM v1_import_ledger_map WHERE kind = ${kind}`,
  })
  const ledgerMapped = (kind: LedgerKind) =>
    Effect.map(
      findLedgerMapped(kind),
      (rows) => new Map(rows.map((row) => [row.v1Id, row.v2Id])),
    )
  const rememberLedger = (kind: LedgerKind, v1Id: string, v2Id: string) =>
    Effect.gen(function* () {
      yield* sql`
        INSERT INTO v1_import_ledger_map (kind, v1_id, v2_id, imported_at)
        VALUES (${kind}, ${v1Id}, ${v2Id}, ${yield* now})
        ON CONFLICT (kind, v1_id) DO NOTHING
      `
    })
  const findLedgerDecisions = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({
      kind: Schema.Literals(['note', 'investment_movement']),
      v1Id: Schema.String,
      v1TransactionId: Schema.String,
      value: Schema.String,
      status: Status,
    }),
    execute: () => sql`
      SELECT kind, v1_id AS v1Id, v1_transaction_id AS v1TransactionId, value, status
      FROM v1_import_ledger_decisions ORDER BY kind, v1_id
    `,
  })
  const resolveLedger = (
    kind: 'note' | 'investment_movement',
    v1Id: string,
    status: 'applied' | 'superseded' | 'refused',
    entryId: string,
    detail: string | null,
  ) =>
    Effect.gen(function* () {
      yield* sql`
        UPDATE v1_import_ledger_decisions SET status = ${status}, entry_id = ${entryId},
          detail = ${detail}, resolved_at = ${yield* now}
        WHERE kind = ${kind} AND v1_id = ${v1Id}
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
    const ledgerRows = yield* findLedgerDecisions(undefined)
    const categoryTally = pendingTally()
    const relationTally = pendingTally()
    const noteTally = pendingTally()
    const investmentTally = pendingTally()
    const waiting: Array<Waiting> = []
    const open =
      categoryRows.some((row) => row.status === 'pending') ||
      relationRows.some((row) => row.status === 'pending') ||
      ledgerRows.some((row) => row.status === 'pending')
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
    // Notes and investment classifications: the person's V2 call wins.
    for (const row of ledgerRows) {
      const counts = row.kind === 'note' ? noteTally : investmentTally
      if (row.status !== 'pending') {
        counts[row.status]++
        continue
      }
      const movement = movements.get(row.v1TransactionId)!
      const found = yield* find(movement)
      if (found._tag !== 'Entry') {
        counts.pending++
        waiting.push({
          kind: row.kind,
          v1Id: row.v1Id,
          label: label(movement),
          reason: found._tag === 'Missing' ? 'not_observed' : 'ambiguous',
        })
        continue
      }
      const taken =
        row.kind === 'note'
          ? (yield* notes.of(found.entryId)) !== null
          : Option.isSome(yield* investments.positionOf(found.entryId))
      if (taken) {
        yield* resolveLedger(
          row.kind,
          row.v1Id,
          'superseded',
          found.entryId,
          null,
        )
        counts.superseded++
        continue
      }
      const outcome =
        row.kind === 'note'
          ? yield* notes.set(found.entryId, row.value).pipe(
              Effect.as(Option.none<string>()),
              Effect.catchTag('NotesError', (error) =>
                Effect.succeed(Option.some(error.message)),
              ),
            )
          : yield* investments
              .classify(
                { entryId: found.entryId, positionId: row.value },
                'v1_import',
              )
              .pipe(
                Effect.as(Option.none<string>()),
                Effect.catchTag('InvestmentsError', (error) =>
                  Effect.succeed(Option.some(error.message)),
                ),
              )
      const status = Option.isSome(outcome) ? 'refused' : 'applied'
      yield* resolveLedger(
        row.kind,
        row.v1Id,
        status,
        found.entryId,
        Option.getOrNull(outcome),
      )
      counts[status]++
    }
    return {
      categories: categoryTally,
      relations: relationTally,
      notes: noteTally,
      investmentMovements: investmentTally,
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
      // The account and its mapping commit together, so an interrupted run
      // never opens the same account twice.
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const opened = yield* accounts.open(planned.input)
          if (planned.archived) yield* accounts.setArchived(opened.id, true)
          yield* remember(kind, item.id, opened.id)
        }),
      )
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
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const created = yield* accounts.createOwner({
            name: owner.name.trim() || 'Titular',
            kind: ownerKind(owner.type),
          })
          yield* remember('owner', owner.id, created.id)
        }),
      )
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
    for (const row of snapshot.knowledge) {
      // Recurrence signatures come over with their recurrences.
      if (row.kind !== 'category') continue
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

    // Transactions typed in by hand become manual facts again, before the
    // decisions about them look for their entries.
    const manualTally = tally()
    const knownManual = yield* ledgerMapped('manual_transaction')
    for (const typed of plan.manual) {
      if (knownManual.has(typed.v1TransactionId)) {
        manualTally.already++
        continue
      }
      const outcome = yield* manualEntries
        .createTransaction({
          accountId: typed.accountId,
          externalId: `v1:${typed.v1TransactionId}`,
          transaction: {
            bookedOn: typed.bookedOn,
            amountCents: typed.amountCents,
            description: typed.description,
          },
        })
        .pipe(
          Effect.map((receipt) => ({ ok: true as const, receipt })),
          Effect.catchTag('ManualEntryError', (error) =>
            Effect.succeed({ ok: false as const, error }),
          ),
        )
      if (!outcome.ok) {
        manualTally.skipped++
        unmapped.push({
          kind: 'manual_transaction',
          v1Id: typed.v1TransactionId,
          label: `${typed.bookedOn} ${formatCents(typed.amountCents)} ${typed.description}`,
          reason: outcome.error.message,
        })
        continue
      }
      yield* rememberLedger(
        'manual_transaction',
        typed.v1TransactionId,
        outcome.receipt.externalId,
      )
      manualTally.migrated++
    }

    // Balances the person informed, on accounts: cards follow statement cycles.
    const checkpointTally = tally()
    const knownCheckpoints = yield* ledgerMapped('checkpoint')
    for (const checkpoint of snapshot.checkpoints) {
      if (knownCheckpoints.has(checkpoint.id)) {
        checkpointTally.already++
        continue
      }
      const label = `${checkpoint.asOf.slice(0, 10)} ${formatCents(checkpoint.balanceCents)}`
      const skip = (reason: string) => {
        checkpointTally.skipped++
        unmapped.push({
          kind: 'checkpoint',
          v1Id: checkpoint.id,
          label,
          reason,
        })
      }
      if (checkpoint.accountId === null) {
        skip('a card statement balance; V2 checks cards by their cycles')
        continue
      }
      const target = targets.get(`account:${checkpoint.accountId}`)
      if (target === undefined) {
        skip('its account was not migrated')
        continue
      }
      const outcome = yield* manualEntries
        .recordCheckpoint({
          accountId: target.accountId,
          asOf: checkpoint.asOf.slice(0, 10),
          balanceCents: checkpoint.balanceCents,
        })
        .pipe(
          Effect.map((recorded) => ({ ok: true as const, recorded })),
          Effect.catchTag('ManualEntryError', (error) =>
            Effect.succeed({ ok: false as const, error }),
          ),
        )
      if (!outcome.ok) {
        skip(outcome.error.message)
        continue
      }
      yield* rememberLedger('checkpoint', checkpoint.id, outcome.recorded.id)
      checkpointTally.migrated++
    }

    // Asset classes and positions, with their opening amount and the value
    // the person last entered.
    for (const assetClass of snapshot.assetClasses) {
      yield* sql`
        INSERT INTO investment_asset_classes (id, name, color, sort_order, active)
        VALUES (${assetClass.id}, ${assetClass.name}, ${assetClass.color},
          ${assetClass.sortOrder}, ${assetClass.active ? 1 : 0})
        ON CONFLICT DO NOTHING
      `
    }
    const positionTally = tally()
    const knownPositions = yield* ledgerMapped('position')
    for (const position of snapshot.positions) {
      if (knownPositions.has(position.id)) {
        positionTally.already++
        continue
      }
      const skip = (reason: string) => {
        positionTally.skipped++
        unmapped.push({
          kind: 'position',
          v1Id: position.id,
          label: position.name,
          reason,
        })
      }
      const target = targets.get(`account:${position.accountId}`)
      if (target === undefined) {
        skip('its account was not migrated')
        continue
      }
      if (target.currency !== position.currency) {
        skip(`in ${position.currency}, its account in ${target.currency}`)
        continue
      }
      const outcome = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const created = yield* investments.createPosition({
              accountId: target.accountId,
              assetClassId: position.assetClassId,
              name: position.name,
              symbol: position.symbol,
              reserve: position.reserve,
              openingCents: position.initialAmountMinor,
              archived: !position.active,
            })
            if (position.manualCurrentAmountMinor !== null)
              yield* investments.recordValuation(
                {
                  positionId: created.id,
                  asOf: (position.manualCurrentAt ?? (yield* today)).slice(
                    0,
                    10,
                  ),
                  amountCents: position.manualCurrentAmountMinor,
                },
                'v1_import',
              )
            yield* rememberLedger('position', position.id, created.id)
          }),
        )
        .pipe(
          Effect.as(Option.none<string>()),
          Effect.catchTag('InvestmentsError', (error) =>
            Effect.succeed(Option.some(error.message)),
          ),
        )
      if (Option.isSome(outcome)) skip(outcome.value)
      else positionTally.migrated++
    }
    const positionIds = yield* ledgerMapped('position')

    const categoryDecisionTally = tally()
    const relationDecisionTally = tally()
    const noteTally = tally()
    const investmentTally = tally()
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
        const ledgerDecision = (
          kind: 'note' | 'investment_movement',
          v1Id: string,
          v1TransactionId: string,
          value: string,
          counts: Tally & { migrated: number; already: number },
        ) =>
          Effect.gen(function* () {
            const inserted = yield* sql`
              INSERT INTO v1_import_ledger_decisions (kind, v1_id, v1_transaction_id, value, status)
              VALUES (${kind}, ${v1Id}, ${v1TransactionId}, ${value}, 'pending')
              ON CONFLICT (kind, v1_id) DO NOTHING
              RETURNING v1_id
            `
            if (inserted.length > 0) counts.migrated++
            else counts.already++
          })
        for (const note of plan.notes)
          yield* ledgerDecision(
            'note',
            note.v1TransactionId,
            note.v1TransactionId,
            note.note,
            noteTally,
          )
        for (const row of plan.investmentMovements) {
          const positionId = positionIds.get(row.v1PositionId)
          if (positionId === undefined) {
            investmentTally.skipped++
            unmapped.push({
              kind: 'investment_movement',
              v1Id: row.v1MovementId,
              label: row.v1TransactionId,
              reason: 'its position was not migrated',
            })
            continue
          }
          yield* ledgerDecision(
            'investment_movement',
            row.v1MovementId,
            row.v1TransactionId,
            positionId,
            investmentTally,
          )
        }
      }),
    )
    noteTally.skipped = plan.unmapped.filter(
      (item) => item.kind === 'note',
    ).length
    investmentTally.skipped += plan.unmapped.filter(
      (item) => item.kind === 'investment_movement',
    ).length
    manualTally.skipped += plan.unmapped.filter(
      (item) => item.kind === 'manual_transaction',
    ).length
    categoryDecisionTally.skipped = plan.unmapped.filter(
      (item) => item.kind === 'category_decision',
    ).length
    relationDecisionTally.skipped = plan.unmapped.filter(
      (item) => item.kind === 'relation_decision',
    ).length

    const applied = yield* applyPending()
    const { uncovered } = snapshot
    const notMigrated = [
      { what: 'transaction splits', count: uncovered.splits },
      {
        what: 'card instruments (physical or virtual cards)',
        count: uncovered.cardInstruments,
      },
      { what: 'categorization rules', count: uncovered.categorizationRules },
      {
        what: 'goal contributions (already in each goal’s current amount)',
        count: uncovered.goalContributions,
      },
    ].filter((item) => item.count > 0)

    return {
      owners,
      accounts: accountTally,
      cards: cardTally,
      categories: categoryTally,
      knowledge: knowledgeTally,
      categoryDecisions: categoryDecisionTally,
      relationDecisions: relationDecisionTally,
      manualTransactions: manualTally,
      checkpoints: checkpointTally,
      positions: positionTally,
      notes: noteTally,
      investmentMovements: investmentTally,
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
