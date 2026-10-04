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
import { matchRelations, relationKey } from './Matching.ts'
import type { Decision, MatchedRelation } from './Matching.ts'

export const relationsChanged = 'RelationsChanged'

export class Relation extends Schema.Class<Relation>('Relation')({
  key: Schema.String,
  kind: Schema.Literals(['internal_transfer', 'card_payment']),
  outflowEntryId: Schema.String,
  inflowEntryId: Schema.String,
  status: Schema.Literals(['suggested', 'confirmed']),
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
    ]),
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return this.detail ? `${this.reason}: ${this.detail}` : this.reason
  }
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
  description: Schema.String,
})

const RelationRow = Schema.Struct({
  key: Schema.String,
  kind: Schema.Literals(['internal_transfer', 'card_payment']),
  outflowEntryId: Schema.String,
  inflowEntryId: Schema.String,
  status: Schema.Literals(['suggested', 'confirmed']),
  origin: Schema.Literals(['auto', 'person']),
  score: Schema.Int,
  reasons: Schema.fromJsonString(Schema.Array(Schema.String)),
}).pipe(Schema.decodeTo(Relation))

const encodeReasons = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(Schema.String)),
)

const sameRelations = (
  stored: ReadonlyArray<Relation>,
  matched: ReadonlyArray<MatchedRelation>,
) =>
  stored.length === matched.length &&
  matched.every((relation) => {
    const found = stored.find((candidate) => candidate.key === relation.key)
    return (
      found !== undefined &&
      found.status === relation.status &&
      found.score === relation.score
    )
  })

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const log = yield* EventLog

  const findEntries = SqlSchema.findAll({
    Request: Schema.Void,
    Result: EntryRow,
    execute: () => sql`
      SELECT e.id, e.account_id AS accountId, a.kind AS accountKind, e.booked_on AS bookedOn,
        e.amount_cents AS amountCents, e.description
      FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
      WHERE a.archived_at IS NULL
    `,
  })
  const findEntry = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: EntryRow,
    execute: (id) => sql`
      SELECT e.id, e.account_id AS accountId, a.kind AS accountKind, e.booked_on AS bookedOn,
        e.amount_cents AS amountCents, e.description
      FROM ledger_entries e JOIN accounts a ON a.id = e.account_id WHERE e.id = ${id}
    `,
  })
  const findDecisions = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({
      key: Schema.String,
      decision: Schema.Literals(['confirmed', 'rejected']),
    }),
    execute: () => sql`SELECT key, decision FROM relation_decisions`,
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

  /** Recomputes every relation from entries and decisions; emits `RelationsChanged` on change. */
  const rebuild = Effect.fn('Reconciliation.rebuild')(function* () {
    const decisions = new Map<string, Decision>(
      (yield* findDecisions(undefined)).map((row) => [row.key, row.decision]),
    )
    const matched = matchRelations(yield* findEntries(undefined), decisions)
    if (sameRelations(yield* relations, matched)) return false
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
      }),
    )
    return true
  })

  const record = (key: string, decision: Decision) =>
    Effect.gen(function* () {
      const decidedAt = DateTime.formatIso(yield* DateTime.now)
      yield* sql`
        INSERT INTO relation_decisions (key, decision, decided_at) VALUES (${key}, ${decision}, ${decidedAt})
        ON CONFLICT (key) DO UPDATE SET decision = excluded.decision, decided_at = excluded.decided_at
      `
      yield* rebuild()
    })

  /** The person confirms or rejects a suggested or automatic relation. */
  const decide = Effect.fn('Reconciliation.decide')(function* (
    key: string,
    decision: Decision,
  ) {
    const known = (yield* relations).some((relation) => relation.key === key)
    if (!known)
      return yield* new ReconciliationError({
        reason: 'relation_not_found',
        detail: key,
      })
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
      out.accountId === into.accountId ||
      out.accountKind === 'credit_card'
    ) {
      return yield* new ReconciliationError({ reason: 'not_a_pair' })
    }
    const kind =
      into.accountKind === 'credit_card' ? 'card_payment' : 'internal_transfer'
    yield* record(relationKey(kind, out.id, into.id), 'confirmed')
    return relationKey(kind, out.id, into.id)
  })

  return { relations, rebuild, decide, link }
})

export class Reconciliation extends Context.Service<
  Reconciliation,
  Effect.Success<typeof make>
>()('@spendle/server/reconciliation/Reconciliation') {
  static readonly layer = Layer.effect(Reconciliation, make)
}

/** Re-matches relations whenever an account's entries change. */
export const reactor = Reactor.layer({
  name: 'reconciliation',
  types: [entriesResolved],
  handle: () =>
    Effect.gen(function* () {
      yield* (yield* Reconciliation).rebuild()
    }),
})
