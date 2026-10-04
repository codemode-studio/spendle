import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'

import { EventLog } from '../events/EventLog.ts'
import * as Reactor from '../events/Reactor.ts'
import { Accounts } from './Accounts.ts'
import { proveBalances, resolveEntries } from './Resolution.ts'
import type {
  BalanceInterval,
  Checkpoint,
  ResolvedEntry,
} from './Resolution.ts'

export const entriesResolved = 'EntriesResolved'

export class LedgerEntry extends Schema.Class<LedgerEntry>('LedgerEntry')({
  id: Schema.String,
  accountId: Schema.String,
  bookedOn: Schema.String,
  amountCents: Schema.Int,
  currency: Schema.String,
  description: Schema.String,
  status: Schema.Literals(['pending', 'posted']),
  /** How many observations confirm this movement. */
  sources: Schema.Int,
}) {}

/** Two sources that report different balances for the same account and day. */
export interface CheckpointConflict {
  readonly asOf: string
  readonly balances: ReadonlyArray<{
    readonly sourceId: string
    readonly balanceCents: number
  }>
}

export type BalanceProof =
  | {
      readonly supported: true
      readonly intervals: ReadonlyArray<BalanceInterval>
      readonly conflicts: ReadonlyArray<CheckpointConflict>
    }
  /** Card balances follow statement cycles, proven in the reconciliation phase. */
  | { readonly supported: false; readonly reason: 'credit_card' }

const ObservedRow = Schema.Struct({
  anchorId: Schema.String,
  sequence: Schema.Int,
  previousEntryId: Schema.NullOr(Schema.String),
  sourceId: Schema.String,
  externalId: Schema.String,
  bookedOn: Schema.String,
  amountCents: Schema.Int,
  description: Schema.String,
  status: Schema.Literals(['pending', 'posted']),
})

const CheckpointRow = Schema.Struct({
  sourceId: Schema.String,
  asOf: Schema.String,
  balanceCents: Schema.Int,
  received: Schema.Int,
})

const EvidenceRow = Schema.Struct({
  entryId: Schema.String,
  sourceId: Schema.String,
  externalId: Schema.String,
  bookedOn: Schema.String,
})

const evidenceKey = (sourceId: string, externalId: string) =>
  `${sourceId}\u0000${externalId}`

// Equal when every entry has the same fields and the same evidence: a swap of
// which observation confirms which entry is a change too.
const sameEntries = (
  stored: ReadonlyArray<LedgerEntry>,
  storedEvidence: ReadonlyArray<typeof EvidenceRow.Type>,
  resolved: ReadonlyArray<ResolvedEntry>,
) => {
  if (
    stored.length !== resolved.length ||
    storedEvidence.length !==
      resolved.reduce((n, e) => n + e.evidence.length, 0)
  ) {
    return false
  }
  const byId = new Map(stored.map((entry) => [entry.id, entry]))
  const owner = new Map(
    storedEvidence.map((row) => [
      evidenceKey(row.sourceId, row.externalId),
      row.entryId,
    ]),
  )
  return resolved.every((entry) => {
    const match = byId.get(entry.id)
    return (
      match !== undefined &&
      match.bookedOn === entry.bookedOn &&
      match.amountCents === entry.amountCents &&
      match.description === entry.description &&
      match.status === entry.status &&
      entry.evidence.every(
        (evidence) =>
          owner.get(evidenceKey(evidence.sourceId, evidence.externalId)) ===
          entry.id,
      )
    )
  })
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const log = yield* EventLog
  const accounts = yield* Accounts

  const findObserved = SqlSchema.findAll({
    Request: Schema.String,
    Result: ObservedRow,
    execute: (accountId) => sql`
      SELECT f.id AS anchorId, f.rowid AS sequence, i.entry_id AS previousEntryId,
        l.source_id AS sourceId, l.external_id AS externalId, l.booked_on AS bookedOn,
        l.amount_cents AS amountCents, l.description, l.status
      FROM transaction_observations l
      JOIN transaction_observations f ON f.source_id = l.source_id AND f.account_id = l.account_id
        AND f.external_id = l.external_id AND f.version = 1
      LEFT JOIN entry_identity i ON i.source_id = l.source_id AND i.account_id = l.account_id
        AND i.external_id = l.external_id
      WHERE l.account_id = ${accountId} AND l.status <> 'removed'
        AND l.version = (
          SELECT max(version) FROM transaction_observations v
          WHERE v.source_id = l.source_id AND v.account_id = l.account_id
            AND v.external_id = l.external_id
        )
    `,
  })
  const findEntries = SqlSchema.findAll({
    Request: Schema.String,
    Result: LedgerEntry,
    execute: (accountId) => sql`
      SELECT e.id, e.account_id AS accountId, e.booked_on AS bookedOn, e.amount_cents AS amountCents,
        e.currency, e.description, e.status,
        (SELECT count(*) FROM entry_evidence v WHERE v.entry_id = e.id) AS sources
      FROM ledger_entries e WHERE e.account_id = ${accountId}
      ORDER BY e.booked_on, e.id
    `,
  })
  const findResolved = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ sequence: Schema.Int }),
    execute: (accountId) =>
      sql`SELECT sequence FROM entry_resolution WHERE account_id = ${accountId}`,
  })
  const findCheckpoints = SqlSchema.findAll({
    Request: Schema.String,
    Result: CheckpointRow,
    execute: (accountId) => sql`
      SELECT source_id AS sourceId, as_of AS asOf, balance_cents AS balanceCents,
        rowid AS received
      FROM balance_observations
      WHERE account_id = ${accountId} AND kind IN ('booked', 'statement')
      ORDER BY as_of, rowid
    `,
  })
  // The evidence of each stored entry, with the date each source gave it.
  const findEvidence = SqlSchema.findAll({
    Request: Schema.String,
    Result: EvidenceRow,
    execute: (accountId) => sql`
      SELECT v.entry_id AS entryId, v.source_id AS sourceId, v.external_id AS externalId,
        o.booked_on AS bookedOn
      FROM entry_evidence v
      JOIN transaction_observations o ON o.source_id = v.source_id AND o.account_id = v.account_id
        AND o.external_id = v.external_id
        AND o.version = (
          SELECT max(version) FROM transaction_observations l
          WHERE l.source_id = o.source_id AND l.account_id = o.account_id
            AND l.external_id = o.external_id
        )
      WHERE v.account_id = ${accountId}
    `,
  })

  const entries = Effect.fn('Entries.entries')((accountId: string) =>
    findEntries(accountId),
  )

  /**
   * Rebuilds the account's entries from its current observations. Entry ids
   * come from observations, so a rebuild keeps them. Emits `EntriesResolved`
   * only when the entries changed.
   */
  const resolveAccount = Effect.fn('Entries.resolveAccount')(function* (
    accountId: string,
  ) {
    const account = yield* accounts.get(accountId)
    const sequence = yield* log.latestSequence
    const resolved = resolveEntries(yield* findObserved(accountId))
    const changed = !sameEntries(
      yield* findEntries(accountId),
      yield* findEvidence(accountId),
      resolved,
    )
    yield* sql.withTransaction(
      Effect.gen(function* () {
        if (changed) {
          yield* sql`DELETE FROM ledger_entries WHERE account_id = ${accountId}`
          for (const entry of resolved) {
            yield* sql`
              INSERT INTO ledger_entries (id, account_id, booked_on, amount_cents, currency, description, status)
              VALUES (${entry.id}, ${accountId}, ${entry.bookedOn}, ${entry.amountCents},
                ${account.currency}, ${entry.description}, ${entry.status})
            `
            for (const evidence of entry.evidence) {
              yield* sql`
                INSERT INTO entry_evidence (source_id, account_id, external_id, entry_id)
                VALUES (${evidence.sourceId}, ${accountId}, ${evidence.externalId}, ${entry.id})
              `
              yield* sql`
                INSERT INTO entry_identity (source_id, account_id, external_id, entry_id)
                VALUES (${evidence.sourceId}, ${accountId}, ${evidence.externalId}, ${entry.id})
                ON CONFLICT (source_id, account_id, external_id) DO UPDATE SET entry_id = excluded.entry_id
              `
            }
          }
          yield* log.append([
            {
              type: entriesResolved,
              streamId: accountId,
              payload: { accountId, entries: resolved.length },
            },
          ])
        }
        yield* sql`
          INSERT INTO entry_resolution (account_id, sequence) VALUES (${accountId}, ${sequence})
          ON CONFLICT (account_id) DO UPDATE SET sequence = excluded.sequence
        `
      }),
    )
    return changed
  })

  /** Whether the account's entries already reflect events up to `sequence`. */
  const resolvedThrough = Effect.fn('Entries.resolvedThrough')(function* (
    accountId: string,
    sequence: number,
  ) {
    const resolved = yield* findResolved(accountId)
    return Option.isSome(resolved) && resolved.value.sequence >= sequence
  })

  /**
   * Checks the account's posted entries against its booked and statement
   * balances. For each day, the latest balance reported by each source is
   * used; sources that disagree on a day are listed as conflicts and the
   * latest observed of them is the checkpoint.
   */
  const balanceProof = Effect.fn('Entries.balanceProof')(function* (
    accountId: string,
  ) {
    const account = yield* accounts.get(accountId)
    if (account.kind === 'credit_card') {
      return { supported: false, reason: 'credit_card' } satisfies BalanceProof
    }
    const rows = yield* findCheckpoints(accountId)
    // Per day: each source's latest report, then the latest of those overall.
    const byDay = new Map<string, Map<string, (typeof rows)[number]>>()
    for (const row of rows) {
      const day = byDay.get(row.asOf) ?? new Map()
      day.set(row.sourceId, row)
      byDay.set(row.asOf, day)
    }
    const checkpoints: Array<Checkpoint> = []
    const conflicts: Array<CheckpointConflict> = []
    for (const [asOf, bySource] of byDay) {
      const reports = [...bySource.values()].sort(
        (a, b) => a.received - b.received,
      )
      if (new Set(reports.map((report) => report.balanceCents)).size > 1) {
        conflicts.push({
          asOf,
          balances: reports.map((report) => ({
            sourceId: report.sourceId,
            balanceCents: report.balanceCents,
          })),
        })
      }
      const latest = reports.at(-1)!
      checkpoints.push({
        asOf,
        balanceCents: latest.balanceCents,
        sourceId: latest.sourceId,
      })
    }
    const evidence = yield* findEvidence(accountId)
    const evidenceOf = new Map<
      string,
      Array<{ sourceId: string; bookedOn: string }>
    >()
    for (const row of evidence) {
      const list = evidenceOf.get(row.entryId) ?? []
      list.push({ sourceId: row.sourceId, bookedOn: row.bookedOn })
      evidenceOf.set(row.entryId, list)
    }
    const stored = (yield* findEntries(accountId)).map((entry) => ({
      bookedOn: entry.bookedOn,
      amountCents: entry.amountCents,
      status: entry.status,
      evidence: evidenceOf.get(entry.id) ?? [],
    }))
    return {
      supported: true,
      intervals: proveBalances(stored, checkpoints),
      conflicts,
    } satisfies BalanceProof
  })

  return { entries, resolveAccount, resolvedThrough, balanceProof }
})

export class Entries extends Context.Service<
  Entries,
  Effect.Success<typeof make>
>()('@spendle/server/ledger/Entries') {
  static readonly layer = Layer.effect(Entries, make)
}

const ObservedPayload = Schema.Struct({ accountId: Schema.String })
const decodeObserved = Schema.decodeUnknownEffect(ObservedPayload)

/** Re-resolves an account when new observations arrive; a burst resolves it once. */
export const reactor = Reactor.layer({
  name: 'entry-resolution',
  types: ['TransactionObserved'],
  handle: (event) =>
    Effect.gen(function* () {
      const { accountId } = yield* decodeObserved(event.payload)
      const service = yield* Entries
      if (yield* service.resolvedThrough(accountId, event.sequence)) return
      yield* service.resolveAccount(accountId)
    }),
})
