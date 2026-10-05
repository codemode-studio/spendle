import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'

import type {
  Checkpoint,
  MonthAccount,
  MonthEntry,
  MonthRelation,
} from './Month.ts'
import type { RecurrenceEntry } from './RecurrencePolicy.ts'

const EntryRow = Schema.Struct({
  id: Schema.String,
  accountId: Schema.String,
  bookedOn: Schema.String,
  amountCents: Schema.Int,
  currency: Schema.String,
  description: Schema.String,
  status: Schema.Literals(['pending', 'posted']),
  categoryId: Schema.NullOr(Schema.String),
  bucket: Schema.NullOr(Schema.String),
  categoryStatus: Schema.Literals(['applied', 'review', 'none']),
  excludedFromSpending: Schema.BooleanFromBit,
  company: Schema.BooleanFromBit,
})

const AccountRow = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: Schema.String,
  purpose: Schema.Literals(['operating', 'reserve', 'investment']),
  currency: Schema.String,
  archived: Schema.BooleanFromBit,
  company: Schema.BooleanFromBit,
  closingDay: Schema.NullOr(Schema.Int),
  dueDay: Schema.NullOr(Schema.Int),
})

const RelationRow = Schema.Struct({
  kind: Schema.Literals(['internal_transfer', 'card_payment', 'refund']),
  status: Schema.Literals(['suggested', 'confirmed', 'conflict']),
  outflowEntryId: Schema.String,
  inflowEntryId: Schema.String,
})

const CheckpointRow = Schema.Struct({
  accountId: Schema.String,
  sourceId: Schema.String,
  asOf: Schema.String,
  balanceCents: Schema.Int,
  received: Schema.Int,
  invalidated: Schema.Int,
})

const CategoryRow = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  bucket: Schema.String,
  color: Schema.String,
  active: Schema.BooleanFromBit,
  system: Schema.BooleanFromBit,
})

/** An entry with everything planning reads about it. */
export interface PlanningEntry extends MonthEntry {
  readonly currency: string
  readonly company: boolean
}

/**
 * The ledger as planning reads it: entries with their current category,
 * accounts, relations and balance checkpoints. Read-only; every table
 * belongs to its own module.
 */
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  const findEntries = SqlSchema.findAll({
    Request: Schema.Void,
    Result: EntryRow,
    execute: () => sql`
      SELECT e.id, e.account_id AS accountId, e.booked_on AS bookedOn,
        e.amount_cents AS amountCents, e.currency, e.description, e.status,
        CASE WHEN c.status = 'applied' THEN c.category_id END AS categoryId,
        CASE WHEN c.status = 'applied' THEN k.bucket END AS bucket,
        coalesce(c.status, 'none') AS categoryStatus,
        coalesce(c.excluded_from_spending, 0) AS excludedFromSpending,
        CASE WHEN o.kind = 'company' THEN 1 ELSE 0 END AS company
      FROM ledger_entries e
      JOIN accounts a ON a.id = e.account_id
      JOIN owners o ON o.id = a.owner_id
      LEFT JOIN category_inferences c ON c.entry_id = e.id
      LEFT JOIN categories k ON k.id = c.category_id
      ORDER BY e.booked_on, e.id
    `,
  })
  const findAccounts = SqlSchema.findAll({
    Request: Schema.Void,
    Result: AccountRow,
    execute: () => sql`
      SELECT a.id, a.name, a.kind, a.purpose, a.currency,
        CASE WHEN a.archived_at IS NULL THEN 0 ELSE 1 END AS archived,
        CASE WHEN o.kind = 'company' THEN 1 ELSE 0 END AS company,
        t.closing_day AS closingDay, t.due_day AS dueDay
      FROM accounts a
      JOIN owners o ON o.id = a.owner_id
      LEFT JOIN credit_card_terms t ON t.account_id = a.id
      ORDER BY a.created_at, a.id
    `,
  })
  const findRelations = SqlSchema.findAll({
    Request: Schema.Void,
    Result: RelationRow,
    execute: () => sql`
      SELECT kind, status, outflow_entry_id AS outflowEntryId, inflow_entry_id AS inflowEntryId
      FROM relations ORDER BY key
    `,
  })
  const findCheckpoints = SqlSchema.findAll({
    Request: Schema.Void,
    Result: CheckpointRow,
    execute: () => sql`
      SELECT b.account_id AS accountId, b.source_id AS sourceId, b.as_of AS asOf,
        b.balance_cents AS balanceCents, b.rowid AS received,
        COALESCE((
          SELECT i.withdrawn FROM open_finance_checkpoint_invalidations i
          WHERE i.balance_observation_id = b.id ORDER BY i.rowid DESC LIMIT 1
        ), 0) AS invalidated
      FROM balance_observations b
      WHERE b.kind IN ('booked', 'statement')
      ORDER BY b.account_id, b.as_of, b.rowid
    `,
  })
  const findCategories = SqlSchema.findAll({
    Request: Schema.Void,
    Result: CategoryRow,
    execute: () =>
      sql`SELECT id, name, bucket, color, active, system FROM categories`,
  })

  const entries = findEntries(undefined).pipe(
    Effect.map((rows): ReadonlyArray<PlanningEntry> => rows),
    Effect.withSpan('LedgerReads.entries'),
  )

  const accounts = findAccounts(undefined).pipe(
    Effect.map((rows) =>
      rows.map(({ closingDay, dueDay, ...account }): MonthAccount => ({
        ...account,
        card:
          closingDay !== null && dueDay !== null
            ? { closingDay, dueDay }
            : null,
      })),
    ),
    Effect.withSpan('LedgerReads.accounts'),
  )

  const relations = findRelations(undefined).pipe(
    Effect.map((rows): ReadonlyArray<MonthRelation> => rows),
  )

  /**
   * Per account and day, the latest balance each source reported, unless a
   * later read withdrew it; when sources disagree on a day, the latest wins.
   */
  const checkpoints = findCheckpoints(undefined).pipe(
    Effect.map((rows) => {
      const byDay = new Map<string, Map<string, (typeof rows)[number]>>()
      for (const row of rows) {
        const key = `${row.accountId}|${row.asOf}`
        const day = byDay.get(key) ?? new Map()
        day.set(row.sourceId, row)
        byDay.set(key, day)
      }
      const result: Array<Checkpoint> = []
      for (const reports of byDay.values()) {
        const standing = [...reports.values()]
          .filter((report) => report.invalidated === 0)
          .sort((a, b) => a.received - b.received)
        const latest = standing.at(-1)
        if (latest)
          result.push({
            accountId: latest.accountId,
            asOf: latest.asOf,
            balanceCents: latest.balanceCents,
          })
      }
      return result
    }),
  )

  const categories = findCategories(undefined)

  /** Entries as recurrence matching reads them; the move between own accounts never pays a recurrence. */
  const recurrenceEntries = Effect.fn('LedgerReads.recurrenceEntries')(
    function* (
      all?: ReadonlyArray<PlanningEntry>,
      relationRows?: ReadonlyArray<MonthRelation>,
    ) {
      const list = all ?? (yield* entries)
      const rels = relationRows ?? (yield* relations)
      const internal = new Set(
        rels
          .filter((relation) => relation.kind !== 'refund')
          .flatMap((relation) => [
            relation.outflowEntryId,
            relation.inflowEntryId,
          ]),
      )
      return list.map((entry): RecurrenceEntry => ({
        id: entry.id,
        accountId: entry.accountId,
        bookedOn: entry.bookedOn,
        amountCents: entry.amountCents,
        currency: entry.currency,
        description: entry.description,
        status: entry.status,
        categoryId: entry.categoryId,
        internal: internal.has(entry.id) || entry.excludedFromSpending,
        company: entry.company,
      }))
    },
  )

  return {
    entries,
    accounts,
    relations,
    checkpoints,
    categories,
    recurrenceEntries,
  }
})

export class LedgerReads extends Context.Service<
  LedgerReads,
  Effect.Success<typeof make>
>()('@spendle/server/planning/LedgerReads') {
  static readonly layer = Layer.effect(LedgerReads, make)
}
