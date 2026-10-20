import * as Context from 'effect/Context'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as Semaphore from 'effect/Semaphore'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'

import { EventLog } from '../events/EventLog.ts'
import * as Reactor from '../events/Reactor.ts'
import { oncePerDeployment } from '../events/Startup.ts'
import { entriesResolved } from '../ledger/Entries.ts'
import { followDecisions } from './Decisions.ts'
import {
  parseRelationKey,
  relationKey,
  supersedingDecisionKey,
} from './Keys.ts'
import { matchRelations } from './Matching.ts'
import type { Decision, MatchedRelation } from './Matching.ts'
import { validRefund } from './Refunds.ts'

export const relationsChanged = 'RelationsChanged'

export class Relation extends Schema.Class<Relation>('Relation')({
  key: Schema.String,
  kind: Schema.Literals(['internal_transfer', 'card_payment', 'refund']),
  outflowEntryId: Schema.String,
  inflowEntryId: Schema.String,
  status: Schema.Literals(['suggested', 'confirmed', 'conflict']),
  origin: Schema.Literals(['auto', 'person']),
  score: Schema.Int,
  reasons: Schema.Array(Schema.String),
}) {}

export class ReconciliationError extends Schema.TaggedError<ReconciliationError>()(
  'ReconciliationError',
  {
    reason: Schema.Literals([
      'relation_not_found',
      'entry_not_found',
      'not_a_pair',
      'already_linked',
      'exceeds_purchase',
      'link_not_applied',
    ]),
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return this.detail ? `${this.reason}: ${this.detail}` : this.reason
  }
}

/**
 * A person's confirmation that no longer holds its entries: one vanished
 * (`entry_missing`), its observations now sit in several entries
 * (`entry_split`), or entries merged so another confirmation holds one of
 * them (`overlapping_confirmation`). The entries it still reserves stay out
 * of automatic pairing until the person rejects it or links them elsewhere.
 */
export interface OrphanedDecision {
  readonly key: string
  readonly missing: ReadonlyArray<string>
  readonly reason: 'entry_missing' | 'entry_split' | 'overlapping_confirmation'
  /** The entries it still reserves. */
  readonly reserved: ReadonlyArray<string>
}

const EntryRow = Schema.Struct({
  id: Schema.String,
  accountId: Schema.String,
  accountKind: Schema.Literals([
    'checking',
    'savings',
    'cash',
    'investment',
    'credit_card',
  ]),
  bookedOn: Schema.String,
  amountCents: Schema.Int,
  currency: Schema.String,
  status: Schema.Literals(['pending', 'posted']),
  description: Schema.String,
  institution: Schema.String,
  ownerName: Schema.String,
  operationTypes: Schema.fromJsonString(Schema.Array(Schema.String)),
})

// An entry with what each of its sources currently reports: the latest
// version of every observation it holds.
const MatchableRow = Schema.Struct({
  ...EntryRow.fields,
  observedDescriptions: Schema.fromJsonString(Schema.Array(Schema.String)),
})

const RelationRow = Schema.Struct({
  key: Schema.String,
  kind: Schema.Literals(['internal_transfer', 'card_payment', 'refund']),
  outflowEntryId: Schema.String,
  inflowEntryId: Schema.String,
  status: Schema.Literals(['suggested', 'confirmed', 'conflict']),
  origin: Schema.Literals(['auto', 'person']),
  score: Schema.Int,
  reasons: Schema.fromJsonString(Schema.Array(Schema.String)),
}).pipe(Schema.decodeTo(Relation))

const encodeReasons = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(Schema.String)),
)

// Equal only when every stored relation matches in full: kind, legs, status,
// origin, score and reasons all reach readers.
const sameRelations = (
  stored: ReadonlyArray<Relation>,
  matched: ReadonlyArray<MatchedRelation>,
) => {
  if (stored.length !== matched.length) return false
  const byKey = new Map(stored.map((relation) => [relation.key, relation]))
  return matched.every((relation) => {
    const found = byKey.get(relation.key)
    return (
      found !== undefined &&
      found.kind === relation.kind &&
      found.outflowEntryId === relation.outflowId &&
      found.inflowEntryId === relation.inflowId &&
      found.status === relation.status &&
      found.origin === relation.origin &&
      found.score === relation.score &&
      found.reasons.join('|') === relation.reasons.join('|')
    )
  })
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const log = yield* EventLog
  // Rebuilds and decisions run one at a time, each from reading entries and
  // decisions to replacing relations: a rebuild never writes relations
  // computed before a decision that committed meanwhile.
  const lock = yield* Semaphore.make(1)
  const serialized = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    lock.withPermit(effect).pipe(Effect.withSpan('Reconciliation.serialize'))

  // What the current version of each observation of the entry says its
  // provider operation was; sources may disagree, so every one is kept.
  const operationTypes = sql.literal(`(
    SELECT json_group_array(DISTINCT json_extract(t.raw, '$.operationType'))
    FROM entry_evidence v JOIN transaction_observations t
      ON t.source_id = v.source_id AND t.account_id = v.account_id AND t.external_id = v.external_id
    WHERE v.entry_id = e.id AND json_type(t.raw, '$.operationType') = 'text'
      AND t.version = (
        SELECT max(version) FROM transaction_observations l
        WHERE l.source_id = t.source_id AND l.account_id = t.account_id
          AND l.external_id = t.external_id
      ))`)

  const findEntries = SqlSchema.findAll({
    Request: Schema.Void,
    Result: MatchableRow,
    execute: () => sql`
      SELECT e.id, e.account_id AS accountId, a.kind AS accountKind, e.booked_on AS bookedOn,
        e.amount_cents AS amountCents, e.currency, e.status, e.description, i.name AS institution,
        o.name AS ownerName,
        (
          SELECT json_group_array(t.description)
          FROM entry_evidence v JOIN transaction_observations t ON t.source_id = v.source_id
            AND t.account_id = v.account_id AND t.external_id = v.external_id
          WHERE v.entry_id = e.id AND t.status <> 'removed'
            AND t.version = (
              SELECT max(version) FROM transaction_observations l
              WHERE l.source_id = t.source_id AND l.account_id = t.account_id
                AND l.external_id = t.external_id
            )
        ) AS observedDescriptions,
        ${operationTypes} AS operationTypes
      FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
      JOIN institutions i ON i.id = a.institution_id JOIN owners o ON o.id = a.owner_id
      WHERE a.archived_at IS NULL
    `,
  })
  const findEntry = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: EntryRow,
    execute: (id) => sql`
      SELECT e.id, e.account_id AS accountId, a.kind AS accountKind, e.booked_on AS bookedOn,
        e.amount_cents AS amountCents, e.currency, e.status, e.description, i.name AS institution,
        o.name AS ownerName, ${operationTypes} AS operationTypes
      FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
      JOIN institutions i ON i.id = a.institution_id JOIN owners o ON o.id = a.owner_id WHERE e.id = ${id}
    `,
  })
  const findDecisions = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({
      key: Schema.String,
      decision: Schema.Literals(['confirmed', 'rejected']),
      revision: Schema.Int,
    }),
    execute: () => sql`SELECT key, decision, revision FROM relation_decisions`,
  })
  // The entries now holding the observations each decided side had. An
  // observation withdrawn since points to the entry it last belonged to, or
  // the one that entry merged into later (see `Entries.resolveAccount`), so
  // the decision keeps the side it can still hold.
  const findHolders = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({
      key: Schema.String,
      side: Schema.Literals(['outflow', 'inflow']),
      entryId: Schema.String,
    }),
    execute: () => sql`
      SELECT DISTINCT p.key, p.side, e.id AS entryId
      FROM relation_decision_endpoints p
      LEFT JOIN entry_evidence v ON v.source_id = p.source_id AND v.account_id = p.account_id
        AND v.external_id = p.external_id
      LEFT JOIN entry_identity i ON i.source_id = p.source_id AND i.account_id = p.account_id
        AND i.external_id = p.external_id
      JOIN ledger_entries e ON e.id = coalesce(v.entry_id, i.entry_id)
    `,
  })
  const findRelations = SqlSchema.findAll({
    Request: Schema.Void,
    Result: RelationRow,
    execute: () => sql`
      SELECT key, kind, outflow_entry_id AS outflowEntryId, inflow_entry_id AS inflowEntryId,
        status, origin, score, reasons
      FROM relations ORDER BY key
    `,
  })

  const relations = findRelations(undefined).pipe(
    Effect.withSpan('Reconciliation.relations'),
  )

  const match = Effect.gen(function* () {
    // Every source's description counts: one naming a third party keeps a
    // pair suggested even when another source's speaks for the entry.
    const entries = (yield* findEntries(undefined)).map(
      ({ observedDescriptions, ...entry }) => ({
        ...entry,
        descriptions: [
          ...new Set([entry.description, ...observedDescriptions.toSorted()]),
        ],
      }),
    )
    const holders = new Map<string, Array<string>>()
    for (const row of yield* findHolders(undefined)) {
      const list = holders.get(`${row.side}:${row.key}`) ?? []
      list.push(row.entryId)
      holders.set(`${row.side}:${row.key}`, list)
    }
    const holdersOf = (key: string, side: 'outflow' | 'inflow') =>
      holders.get(`${side}:${key}`) ?? []
    const followed = followDecisions(
      (yield* findDecisions(undefined)).map((row) => ({
        ...row,
        outflowHolders: holdersOf(row.key, 'outflow'),
        inflowHolders: holdersOf(row.key, 'inflow'),
      })),
      new Set(entries.map((entry) => entry.id)),
    )
    const matching = matchRelations(
      entries,
      followed.decisions,
      new Set(followed.split.flatMap((split) => split.reserved)),
    )
    const orphaned = [
      ...matching.orphaned.map((orphan): OrphanedDecision => ({
        ...orphan,
        key: followed.storedKeys.get(orphan.key) ?? orphan.key,
      })),
      ...followed.split.map((split): OrphanedDecision => ({
        ...split,
        reason: 'entry_split',
      })),
    ].sort((a, b) => a.key.localeCompare(b.key))
    return { relations: matching.relations, orphaned, followed }
  })

  /** Confirmations that no longer hold their entries, for the person to resolve. */
  const orphanedDecisions = match.pipe(
    Effect.map((matching) => matching.orphaned),
    Effect.withSpan('Reconciliation.orphanedDecisions'),
  )

  // Callers hold `lock`. Reads and the replacement share one transaction.
  const replaceRelations = sql.withTransaction(
    Effect.gen(function* () {
      const sequence = yield* log.latestSequence
      const matched = (yield* match).relations
      if (sameRelations(yield* relations, matched)) {
        yield* markRebuilt(sequence)
        return false
      }
      yield* sql`DELETE FROM relations`
      for (const relation of matched) {
        yield* sql`
          INSERT INTO relations (key, kind, outflow_entry_id, inflow_entry_id, status, origin, score, reasons)
          VALUES (${relation.key}, ${relation.kind}, ${relation.outflowId}, ${relation.inflowId},
            ${relation.status}, ${relation.origin}, ${relation.score}, ${yield* encodeReasons(relation.reasons)})
        `
      }
      yield* log.append([
        {
          type: relationsChanged,
          streamId: 'relations',
          payload: { relations: matched.length },
        },
      ])
      yield* markRebuilt(sequence)
      return true
    }),
  )

  /** Recomputes every relation from entries and decisions; emits `RelationsChanged` on change. */
  const rebuild = Effect.fn('Reconciliation.rebuild')(function* () {
    return yield* serialized(replaceRelations)
  })

  /** Whether relations already reflect events up to `sequence`. */
  const rebuiltThrough = Effect.fn('Reconciliation.rebuiltThrough')(function* (
    sequence: number,
  ) {
    const rows = yield* sql<{
      sequence: number
    }>`SELECT sequence FROM reconciliation_state WHERE id = 1`
    return (rows[0]?.sequence ?? -1) >= sequence
  })

  const markRebuilt = (sequence: number) =>
    sql`
      INSERT INTO reconciliation_state (id, sequence) VALUES (1, ${sequence})
      ON CONFLICT (id) DO UPDATE SET sequence = excluded.sequence
    `

  // Stores the decision with the observations the entries of `current` have
  // now, adding to those recorded earlier, never replacing them: a verdict
  // changed after an entry split, merged or vanished still covers every
  // observation first decided.
  const write = Effect.fnUntraced(function* (
    key: string,
    decision: Decision,
    current: string = key,
  ) {
    const decidedAt = DateTime.formatIso(yield* DateTime.now)
    yield* sql`
      INSERT INTO relation_decisions (key, decision, decided_at, revision)
      VALUES (${key}, ${decision}, ${decidedAt},
        (SELECT coalesce(max(revision), 0) + 1 FROM relation_decisions))
      ON CONFLICT (key) DO UPDATE SET decision = excluded.decision,
        decided_at = excluded.decided_at, revision = excluded.revision
    `
    const { outflowId, inflowId } = parseRelationKey(current)
    for (const [side, entryId] of [
      ['outflow', outflowId],
      ['inflow', inflowId],
    ] as const) {
      yield* sql`
        INSERT OR IGNORE INTO relation_decision_endpoints (key, side, source_id, account_id, external_id)
        SELECT ${key}, ${side}, source_id, account_id, external_id
        FROM entry_evidence WHERE entry_id = ${entryId}
      `
    }
  })

  // A decision about a current relation updates the stored decisions it
  // comes from, when they apply to that relation alone, instead of sitting
  // beside them: the stored one keeps its observations, so its old verdict
  // cannot resurface once entries diverge again. A relation no stored
  // decision maps to alone gets its own, under a superseding key when an
  // earlier decision already has the relation's: that one keeps every
  // observation it covered and its verdict on them, so reusing it would
  // decide the other branches too (a link would split again).
  const writeDecision = Effect.fnUntraced(function* (
    key: string,
    decision: Decision,
  ) {
    const { followed } = yield* match
    const sources = [...followed.currentKeys]
      .filter(([, keys]) => keys.length === 1 && keys[0] === key)
      .map(([stored]) => stored)
    if (sources.length > 0) {
      for (const stored of sources) yield* write(stored, decision, key)
      return
    }
    const [taken] = yield* sql<{ revision: number }>`
      SELECT (SELECT max(revision) FROM relation_decisions) + 1 AS revision
      FROM relation_decisions WHERE key = ${key}
    `
    yield* taken
      ? write(supersedingDecisionKey(key, taken.revision), decision, key)
      : write(key, decision)
  })

  // The decision and the relations it changes commit together: a failed
  // rebuild leaves no decision behind that relations do not reflect.
  const record = <E, R>(decided: Effect.Effect<void, E, R>) =>
    sql.withTransaction(
      Effect.andThen(decided, Effect.asVoid(replaceRelations)),
    )

  /**
   * The person confirms or rejects a suggested or automatic relation, or
   * rejects an orphaned confirmation to release the entry it reserves.
   */
  const decide = Effect.fn('Reconciliation.decide')(
    (key: string, decision: Decision) =>
      serialized(decideUnlocked(key, decision)),
  )

  const decideUnlocked = Effect.fnUntraced(function* (
    key: string,
    decision: Decision,
  ) {
    const known = (yield* relations).some((relation) => relation.key === key)
    if (known) return yield* record(writeDecision(key, decision))
    const orphan = (yield* orphanedDecisions).find((found) => found.key === key)
    if (!orphan)
      return yield* new ReconciliationError({
        reason: 'relation_not_found',
        detail: key,
      })
    if (decision === 'confirmed')
      return yield* orphan.reason === 'overlapping_confirmation'
        ? new ReconciliationError({ reason: 'already_linked', detail: key })
        : new ReconciliationError({
            reason: 'entry_not_found',
            detail: orphan.missing.join(', '),
          })
    // An orphan is a stored decision: the person's verdict replaces its own.
    yield* record(write(key, decision))
  })

  /**
   * The person pairs two entries the matcher missed: an outflow and an
   * inflow of the same amount on different accounts (a transfer or card
   * payment), or a purchase and a later credit on the same account that
   * gives back part or all of it (a refund). A purchase may take several
   * refunds, never more than its amount.
   */
  const link = Effect.fn('Reconciliation.link')(
    (input: {
      readonly outflowEntryId: string
      readonly inflowEntryId: string
    }) => serialized(linkUnlocked(input)),
  )

  const linkUnlocked = Effect.fnUntraced(function* (input: {
    readonly outflowEntryId: string
    readonly inflowEntryId: string
  }) {
    const [outflow, inflow] = yield* Effect.all([
      findEntry(input.outflowEntryId),
      findEntry(input.inflowEntryId),
    ])
    if (Option.isNone(outflow))
      return yield* new ReconciliationError({
        reason: 'entry_not_found',
        detail: input.outflowEntryId,
      })
    if (Option.isNone(inflow))
      return yield* new ReconciliationError({
        reason: 'entry_not_found',
        detail: input.inflowEntryId,
      })
    const out = { ...outflow.value, descriptions: [outflow.value.description] }
    const into = { ...inflow.value, descriptions: [inflow.value.description] }
    const refund = out.accountId === into.accountId && validRefund(out, into)
    const pair =
      out.amountCents < 0 &&
      into.amountCents === -out.amountCents &&
      out.currency === into.currency &&
      out.accountId !== into.accountId &&
      out.accountKind !== 'credit_card'
    if (!refund && !pair) {
      return yield* new ReconciliationError({ reason: 'not_a_pair' })
    }
    const kind = refund
      ? 'refund'
      : into.accountKind === 'credit_card'
        ? 'card_payment'
        : 'internal_transfer'
    // A link never silently loses to an earlier confirmation of either entry;
    // only refunds may share their purchase.
    const held = (yield* relations).filter(
      (relation) => relation.origin === 'person',
    )
    const taken = held.find(
      (relation) =>
        relation.inflowEntryId === out.id ||
        relation.inflowEntryId === into.id ||
        relation.outflowEntryId === into.id ||
        (relation.outflowEntryId === out.id &&
          (kind !== 'refund' || relation.kind !== 'refund')),
    )
    if (taken)
      return yield* new ReconciliationError({
        reason: 'already_linked',
        detail: taken.key,
      })
    if (kind === 'refund') {
      const earlier = held.filter(
        (relation) =>
          relation.kind === 'refund' &&
          relation.status === 'confirmed' &&
          relation.outflowEntryId === out.id,
      )
      let refunded = into.amountCents
      for (const relation of earlier) {
        const credit = yield* findEntry(relation.inflowEntryId)
        if (Option.isSome(credit)) refunded += credit.value.amountCents
      }
      if (refunded > -out.amountCents)
        return yield* new ReconciliationError({
          reason: 'exceeds_purchase',
          detail: `${refunded} of ${-out.amountCents}`,
        })
    }
    const key = relationKey(kind, out.id, into.id)
    // The link supersedes orphaned confirmations that reserve either entry,
    // and must show up as the person's relation, or nothing is stored.
    // Refunds share their purchase: a refund never supersedes another refund
    // only for holding the same purchase.
    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (const orphan of yield* orphanedDecisions) {
          const shared = orphan.reserved.filter(
            (id) => id === out.id || id === into.id,
          )
          const sharesPurchase =
            kind === 'refund' &&
            parseRelationKey(orphan.key).kind === 'refund' &&
            shared.every((id) => id === out.id)
          if (shared.length > 0 && !sharesPurchase)
            yield* write(orphan.key, 'rejected')
        }
        yield* writeDecision(key, 'confirmed')
        yield* replaceRelations
        const linked = (yield* relations).some(
          (relation) => relation.key === key && relation.origin === 'person',
        )
        if (!linked)
          return yield* new ReconciliationError({
            reason: 'link_not_applied',
            detail: key,
          })
      }),
    )
    return key
  })

  return { relations, orphanedDecisions, rebuild, rebuiltThrough, decide, link }
})

export class Reconciliation extends Context.Service<
  Reconciliation,
  Effect.Success<typeof make>
>()('@spendle/server/reconciliation/Reconciliation') {
  static readonly layer = Layer.effect(Reconciliation, make)
}

/**
 * Re-matches relations whenever an account's entries change, the account
 * itself (a new kind turns a transfer into a card payment, or invalidates a
 * confirmation), or an observation: matching reads every source's latest
 * description and operation type, so a correction that leaves entries alone
 * (a secondary source now naming a third party) still changes relations. A
 * rebuild reads current state, so one that runs before the entries resolve
 * is followed by another on their `EntriesResolved`.
 */
export const reactor = Reactor.layer({
  name: 'reconciliation',
  types: [entriesResolved, 'AccountUpdated', 'TransactionObserved'],
  handle: (event) =>
    Effect.gen(function* () {
      const reconciliation = yield* Reconciliation
      if (yield* reconciliation.rebuiltThrough(event.sequence)) return
      yield* reconciliation.rebuild()
    }),
})

/**
 * Rebuilds relations when the server starts, so a matcher change applies to
 * the whole history without waiting for new entries. Once per deployment,
 * since the matcher only changes with one.
 */
export const startup = Layer.effectDiscard(
  oncePerDeployment(
    'reconciliation',
    Effect.gen(function* () {
      yield* (yield* Reconciliation).rebuild()
    }),
  ),
)
