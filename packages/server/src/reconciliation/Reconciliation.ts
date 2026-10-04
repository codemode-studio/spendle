import * as Context from 'effect/Context'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'

import { EventLog } from '../events/EventLog.ts'
import * as Reactor from '../events/Reactor.ts'
import { entriesResolved } from '../ledger/Entries.ts'
import { followDecisions } from './Decisions.ts'
import { matchRelations, parseRelationKey, relationKey } from './Matching.ts'
import type { Decision, MatchedRelation } from './Matching.ts'

export const relationsChanged = 'RelationsChanged'

export class Relation extends Schema.Class<Relation>('Relation')({
  key: Schema.String,
  kind: Schema.Literals(['internal_transfer', 'card_payment']),
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
})

const RelationRow = Schema.Struct({
  key: Schema.String,
  kind: Schema.Literals(['internal_transfer', 'card_payment']),
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

  const findEntries = SqlSchema.findAll({
    Request: Schema.Void,
    Result: EntryRow,
    execute: () => sql`
      SELECT e.id, e.account_id AS accountId, a.kind AS accountKind, e.booked_on AS bookedOn,
        e.amount_cents AS amountCents, e.currency, e.status, e.description, i.name AS institution
      FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
      JOIN institutions i ON i.id = a.institution_id
      WHERE a.archived_at IS NULL
    `,
  })
  const findEntry = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: EntryRow,
    execute: (id) => sql`
      SELECT e.id, e.account_id AS accountId, a.kind AS accountKind, e.booked_on AS bookedOn,
        e.amount_cents AS amountCents, e.currency, e.status, e.description, i.name AS institution
      FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
      JOIN institutions i ON i.id = a.institution_id WHERE e.id = ${id}
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
  // The entries now holding the observations each decided side had.
  const findHolders = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({
      key: Schema.String,
      side: Schema.Literals(['outflow', 'inflow']),
      entryId: Schema.String,
    }),
    execute: () => sql`
      SELECT DISTINCT p.key, p.side, v.entry_id AS entryId
      FROM relation_decision_endpoints p
      JOIN entry_evidence v ON v.source_id = p.source_id AND v.account_id = p.account_id
        AND v.external_id = p.external_id
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
    const entries = yield* findEntries(undefined)
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
    return { relations: matching.relations, orphaned }
  })

  /** Confirmations that no longer hold their entries, for the person to resolve. */
  const orphanedDecisions = match.pipe(
    Effect.map((matching) => matching.orphaned),
    Effect.withSpan('Reconciliation.orphanedDecisions'),
  )

  /** Recomputes every relation from entries and decisions; emits `RelationsChanged` on change. */
  const rebuild = Effect.fn('Reconciliation.rebuild')(function* () {
    const sequence = yield* log.latestSequence
    const matched = (yield* match).relations
    if (sameRelations(yield* relations, matched)) {
      yield* markRebuilt(sequence)
      return false
    }
    yield* sql.withTransaction(
      Effect.gen(function* () {
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
      }),
    )
    return true
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

  // Stores the decision with the observations its entries have now. A side
  // whose entry is gone keeps the observations recorded earlier.
  const write = Effect.fnUntraced(function* (key: string, decision: Decision) {
    const decidedAt = DateTime.formatIso(yield* DateTime.now)
    yield* sql`
      INSERT INTO relation_decisions (key, decision, decided_at, revision)
      VALUES (${key}, ${decision}, ${decidedAt},
        (SELECT coalesce(max(revision), 0) + 1 FROM relation_decisions))
      ON CONFLICT (key) DO UPDATE SET decision = excluded.decision,
        decided_at = excluded.decided_at, revision = excluded.revision
    `
    const { outflowId, inflowId } = parseRelationKey(key)
    for (const [side, entryId] of [
      ['outflow', outflowId],
      ['inflow', inflowId],
    ] as const) {
      yield* sql`
        DELETE FROM relation_decision_endpoints WHERE key = ${key} AND side = ${side}
          AND EXISTS (SELECT 1 FROM entry_evidence WHERE entry_id = ${entryId})
      `
      yield* sql`
        INSERT OR IGNORE INTO relation_decision_endpoints (key, side, source_id, account_id, external_id)
        SELECT ${key}, ${side}, source_id, account_id, external_id
        FROM entry_evidence WHERE entry_id = ${entryId}
      `
    }
  })

  // The decision and the relations it changes commit together: a failed
  // rebuild leaves no decision behind that relations do not reflect.
  const record = (key: string, decision: Decision) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* write(key, decision)
        yield* rebuild()
      }),
    )

  /**
   * The person confirms or rejects a suggested or automatic relation, or
   * rejects an orphaned confirmation to release the entry it reserves.
   */
  const decide = Effect.fn('Reconciliation.decide')(function* (
    key: string,
    decision: Decision,
  ) {
    const known = (yield* relations).some((relation) => relation.key === key)
    if (!known) {
      const orphan = (yield* orphanedDecisions).find(
        (found) => found.key === key,
      )
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
    }
    yield* record(key, decision)
  })

  /**
   * The person pairs two entries the matcher missed: an outflow and an
   * inflow of the same amount on different accounts.
   */
  const link = Effect.fn('Reconciliation.link')(function* (input: {
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
    const out = outflow.value
    const into = inflow.value
    if (
      out.amountCents >= 0 ||
      into.amountCents !== -out.amountCents ||
      out.currency !== into.currency ||
      out.accountId === into.accountId ||
      out.accountKind === 'credit_card'
    ) {
      return yield* new ReconciliationError({ reason: 'not_a_pair' })
    }
    // A link never silently loses to an earlier confirmation of either entry.
    const held = (yield* relations).find(
      (relation) =>
        relation.origin === 'person' &&
        [relation.outflowEntryId, relation.inflowEntryId].some(
          (id) => id === out.id || id === into.id,
        ),
    )
    if (held)
      return yield* new ReconciliationError({
        reason: 'already_linked',
        detail: held.key,
      })
    const kind =
      into.accountKind === 'credit_card' ? 'card_payment' : 'internal_transfer'
    const key = relationKey(kind, out.id, into.id)
    // The link supersedes orphaned confirmations that reserve either entry,
    // and must show up as the person's relation, or nothing is stored.
    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (const orphan of yield* orphanedDecisions) {
          if (orphan.reserved.some((id) => id === out.id || id === into.id))
            yield* write(orphan.key, 'rejected')
        }
        yield* write(key, 'confirmed')
        yield* rebuild()
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
 * Re-matches relations whenever an account's entries change, or the account
 * itself (a new kind turns a transfer into a card payment, or invalidates a
 * confirmation).
 */
export const reactor = Reactor.layer({
  name: 'reconciliation',
  types: [entriesResolved, 'AccountUpdated'],
  handle: (event) =>
    Effect.gen(function* () {
      const reconciliation = yield* Reconciliation
      if (yield* reconciliation.rebuiltThrough(event.sequence)) return
      yield* reconciliation.rebuild()
    }),
})
