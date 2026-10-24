import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'

import type { Account } from '../ledger/Accounts.ts'
import { entryNotes, entryOneOffs } from '../ledger/Notes.ts'
import { inChunks } from '../persistence/Chunks.ts'
import { baseCurrency, convert } from '../rates/Conversion.ts'
import type { RateTable } from '../rates/Conversion.ts'
import { ExchangeRates } from '../rates/ExchangeRates.ts'
import { Balance } from './definition/Accounts.ts'
import type { AccountView, AccountLink } from './definition/Accounts.ts'
import {
  CategoryExplanation,
  Evidence,
  InferenceOrigin,
  Relation,
} from './definition/Entries.ts'
import type { Entry, EntryFilters } from './definition/Entries.ts'

const BalanceRow = Schema.Struct({
  accountId: Schema.String,
  ...Balance.fields,
})

const LinkRow = Schema.Struct({
  accountId: Schema.String,
  connectionId: Schema.String,
  providerAccountId: Schema.String,
  historyFrom: Schema.NullOr(Schema.String),
  creditLimitCents: Schema.NullOr(Schema.Int),
  availableCreditCents: Schema.NullOr(Schema.Int),
  creditAsOf: Schema.NullOr(Schema.String),
})

const EntryRow = Schema.Struct({
  id: Schema.String,
  accountId: Schema.String,
  bookedOn: Schema.String,
  amountCents: Schema.Int,
  currency: Schema.String,
  description: Schema.String,
  status: Schema.Literals(['pending', 'posted']),
  sources: Schema.Int,
  categoryId: Schema.NullOr(Schema.String),
  categoryStatus: Schema.NullOr(Schema.Literals(['applied', 'review', 'none'])),
  origin: Schema.NullOr(InferenceOrigin),
  confidence: Schema.NullOr(Schema.Number),
  excludedFromSpending: Schema.NullOr(Schema.BooleanFromBit),
  note: Schema.NullOr(Schema.String),
  oneOff: Schema.BooleanFromBit,
  manualId: Schema.NullOr(Schema.String),
})

const toEntry = (row: typeof EntryRow.Type, rates: RateTable): Entry => ({
  id: row.id,
  accountId: row.accountId,
  bookedOn: row.bookedOn,
  amountCents: row.amountCents,
  currency: row.currency,
  description: row.description,
  status: row.status,
  sources: row.sources,
  category:
    row.categoryStatus === null || row.origin === null
      ? null
      : {
          categoryId: row.categoryId,
          status: row.categoryStatus,
          origin: row.origin,
          confidence: row.confidence ?? 0,
          excludedFromSpending: row.excludedFromSpending ?? false,
        },
  note: row.note,
  oneOff: row.oneOff,
  manualId: row.manualId,
  converted:
    row.currency === baseCurrency
      ? null
      : (convert(rates, row.amountCents, row.currency, row.bookedOn)
          ?.converted ?? null),
})

const RelationRow = Schema.Struct({
  ...Relation.fields,
  reasons: Schema.fromJsonString(Schema.Array(Schema.String)),
})

const ExplanationRow = Schema.Struct({
  ...CategoryExplanation.fields,
  excludedFromSpending: Schema.BooleanFromBit,
  reasons: Schema.fromJsonString(Schema.Array(Schema.String)),
  candidates: Schema.fromJsonString(CategoryExplanation.fields.candidates),
})

/** `<bookedOn>|<id>` of the last entry of a page; opaque to clients. */
const encodeCursor = (entry: { bookedOn: string; id: string }) =>
  `${entry.bookedOn}|${entry.id}`
const decodeCursor = (cursor: string) => {
  const [bookedOn, id, ...rest] = cursor.split('|')
  return bookedOn && id && rest.length === 0
    ? Option.some({ bookedOn, id })
    : Option.none()
}

// LIKE treats % and _ as wildcards; a person searching for them means them.
const likePattern = (text: string) =>
  `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`

export const defaultPageSize = 50

/**
 * Reads shaped for the web app that join several modules' tables. Writes
 * never go through here; each module keeps its own.
 */
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const exchangeRates = yield* ExchangeRates

  /** Entries with their amount in reais when they are in another currency. */
  const toEntries = (rows: ReadonlyArray<typeof EntryRow.Type>) =>
    Effect.map(
      exchangeRates.table(
        rows.map((row) => ({ currency: row.currency, from: row.bookedOn })),
      ),
      (rates) => rows.map((row) => toEntry(row, rates)),
    )

  // Per account and kind, the latest report still standing: each source's
  // latest report of a day, unless a later read withdrew it.
  const findBalances = SqlSchema.findAll({
    Request: Schema.Void,
    Result: BalanceRow,
    execute: () => sql`
      WITH standing AS (
        SELECT b.account_id, b.kind, b.as_of, b.balance_cents, b.source_id,
          s.kind AS source_kind, b.rowid AS seq
        FROM balance_observations b
        JOIN sources s ON s.id = b.source_id
        WHERE b.rowid = (
            SELECT max(l.rowid) FROM balance_observations l
            WHERE l.account_id = b.account_id AND l.source_id = b.source_id
              AND l.kind = b.kind AND l.as_of = b.as_of
          )
          AND COALESCE((SELECT i.withdrawn FROM open_finance_checkpoint_invalidations i
            WHERE i.balance_observation_id = b.id ORDER BY i.rowid DESC LIMIT 1), 0) = 0
          AND COALESCE((SELECT w.withdrawn FROM manual_checkpoint_withdrawals w
            WHERE w.balance_observation_id = b.id ORDER BY w.rowid DESC LIMIT 1), 0) = 0
      ),
      ranked AS (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY account_id, kind ORDER BY as_of DESC, seq DESC
        ) AS rank
        FROM standing
      )
      SELECT account_id AS accountId, kind, as_of AS asOf, balance_cents AS balanceCents,
        source_id AS sourceId, source_kind AS sourceKind
      FROM ranked WHERE rank = 1
      ORDER BY account_id, kind
    `,
  })

  const findLinks = SqlSchema.findAll({
    Request: Schema.Void,
    Result: LinkRow,
    execute: () => sql`
      SELECT account_id AS accountId, connection_id AS connectionId,
        provider_account_id AS providerAccountId, history_from AS historyFrom,
        credit_limit_cents AS creditLimitCents, available_credit_cents AS availableCreditCents,
        credit_as_of AS creditAsOf
      FROM open_finance_accounts
      WHERE account_id IS NOT NULL AND unlinked_at IS NULL
    `,
  })

  /** Latest balances and live Open Finance link of every account. */
  // When each account last had a posted movement, and last got new data.
  const findFreshness = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({
      accountId: Schema.String,
      lastBookedOn: Schema.NullOr(Schema.String),
      lastObservedAt: Schema.NullOr(Schema.String),
    }),
    execute: () => sql`
      SELECT a.id AS accountId,
        (SELECT max(e.booked_on) FROM ledger_entries e
          WHERE e.account_id = a.id AND e.status = 'posted') AS lastBookedOn,
        (SELECT max(o.observed_at) FROM transaction_observations o
          WHERE o.account_id = a.id) AS lastObservedAt
      FROM accounts a
    `,
  })

  const accountState = Effect.gen(function* () {
    const [balances, links, freshness] = yield* Effect.all([
      findBalances(undefined),
      findLinks(undefined),
      findFreshness(undefined),
    ])
    const balancesOf = new Map<string, Array<Balance>>()
    for (const { accountId, ...balance } of balances) {
      const list = balancesOf.get(accountId) ?? []
      list.push(balance)
      balancesOf.set(accountId, list)
    }
    const linkOf = new Map(
      links.map(
        ({
          accountId,
          creditLimitCents,
          availableCreditCents,
          creditAsOf,
          ...link
        }): [string, typeof AccountLink.Type] => [
          accountId,
          {
            ...link,
            credit:
              creditAsOf === null
                ? null
                : {
                    limitCents: creditLimitCents,
                    availableCents: availableCreditCents,
                    asOf: creditAsOf,
                  },
          },
        ],
      ),
    )
    const freshnessOf = new Map(freshness.map((row) => [row.accountId, row]))
    return {
      balances: (accountId: string) => balancesOf.get(accountId) ?? [],
      link: (accountId: string) => linkOf.get(accountId) ?? null,
      freshness: (accountId: string) => ({
        lastBookedOn: freshnessOf.get(accountId)?.lastBookedOn ?? null,
        lastObservedAt: freshnessOf.get(accountId)?.lastObservedAt ?? null,
      }),
    }
  }).pipe(Effect.withSpan('ReadModel.accountState'))

  /** Accounts with their latest balances, last standing checkpoint, live link and freshness. */
  const accountViews = Effect.fn('ReadModel.accountViews')(function* (
    accounts: ReadonlyArray<Account>,
  ) {
    const state = yield* accountState
    return accounts.map((account): AccountView => {
      const balances = state.balances(account.id)
      return {
        ...account,
        balances,
        // Balance proofs start from booked and statement balances alike.
        lastCheckpoint:
          balances
            .filter((balance) => balance.kind !== 'available')
            .sort((a, b) => b.asOf.localeCompare(a.asOf))[0] ?? null,
        link: state.link(account.id),
        ...state.freshness(account.id),
      }
    })
  })

  const accountView = (account: Account) =>
    Effect.map(accountViews([account]), (views) => views[0]!)

  // Entries with their category inference, the person's note and one-off mark.
  const entrySource = sql`
    ledger_entries e
    LEFT JOIN category_inferences c ON c.entry_id = e.id
    LEFT JOIN (${entryNotes(sql)}) n ON n.entry_id = e.id
    LEFT JOIN (${entryOneOffs(sql)}) o ON o.entry_id = e.id
  `
  const entryColumns = sql`
    e.id, e.account_id AS accountId, e.booked_on AS bookedOn, e.amount_cents AS amountCents,
    e.currency, e.description, e.status,
    (SELECT count(DISTINCT v.source_id) FROM entry_evidence v WHERE v.entry_id = e.id) AS sources,
    c.category_id AS categoryId, c.status AS categoryStatus, c.origin,
    c.confidence, c.excluded_from_spending AS excludedFromSpending, n.note,
    o.entry_id IS NOT NULL AS oneOff,
    (SELECT m.external_id FROM entry_evidence m JOIN sources ms ON ms.id = m.source_id
      WHERE m.entry_id = e.id AND ms.kind = 'manual' ORDER BY m.external_id LIMIT 1) AS manualId
  `

  /**
   * A page of entries, latest first, matching every given filter. Returns
   * `None` for a cursor this API did not issue.
   */
  const entriesPage = Effect.fn('ReadModel.entriesPage')(function* (
    filters: EntryFilters,
  ) {
    const cursor: Option.Option<{ bookedOn: string; id: string } | undefined> =
      filters.cursor === undefined
        ? Option.some(undefined)
        : decodeCursor(filters.cursor)
    if (Option.isNone(cursor)) return Option.none()
    const limit = filters.limit ?? defaultPageSize
    const clauses = [
      ...(filters.accountId === undefined
        ? []
        : [sql`e.account_id = ${filters.accountId}`]),
      ...(filters.from === undefined
        ? []
        : [sql`e.booked_on >= ${filters.from}`]),
      ...(filters.to === undefined ? [] : [sql`e.booked_on <= ${filters.to}`]),
      ...(filters.status === undefined
        ? []
        : [sql`e.status = ${filters.status}`]),
      ...(filters.categoryId === undefined
        ? []
        : [sql`c.category_id = ${filters.categoryId}`]),
      ...(filters.categoryStatus === undefined
        ? []
        : filters.categoryStatus === 'none'
          ? [sql`(c.entry_id IS NULL OR c.status = 'none')`]
          : [sql`c.status = ${filters.categoryStatus}`]),
      ...(filters.text === undefined || filters.text.trim() === ''
        ? []
        : [
            sql`(e.description LIKE ${likePattern(filters.text.trim())} ESCAPE '\\'
              OR n.note LIKE ${likePattern(filters.text.trim())} ESCAPE '\\')`,
          ]),
      ...(filters.oneOff === undefined
        ? []
        : [
            filters.oneOff
              ? sql`o.entry_id IS NOT NULL`
              : sql`o.entry_id IS NULL`,
          ]),
      ...(filters.direction === undefined
        ? []
        : filters.direction === 'inflow'
          ? [sql`e.amount_cents > 0`]
          : [sql`e.amount_cents < 0`]),
      ...(filters.minAmountCents === undefined
        ? []
        : [sql`abs(e.amount_cents) >= ${filters.minAmountCents}`]),
      ...(filters.maxAmountCents === undefined
        ? []
        : [sql`abs(e.amount_cents) <= ${filters.maxAmountCents}`]),
    ]
    const after = cursor.value
    const page = yield* sql`
      SELECT ${entryColumns}
      FROM ${entrySource}
      WHERE ${sql.and([
        ...clauses,
        ...(after === undefined
          ? []
          : [
              sql`(e.booked_on < ${after.bookedOn} OR (e.booked_on = ${after.bookedOn} AND e.id < ${after.id}))`,
            ]),
      ])}
      ORDER BY e.booked_on DESC, e.id DESC
      LIMIT ${limit + 1} OFFSET ${filters.offset ?? 0}
    `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(EntryRow))))
    const counted = yield* sql<{ total: number }>`
      SELECT count(*) AS total
      FROM ${entrySource}
      WHERE ${sql.and(clauses)}
    `
    const entries = yield* toEntries(page.slice(0, limit))
    const last = entries.at(-1)
    return Option.some({
      entries,
      nextCursor:
        page.length > limit && last !== undefined ? encodeCursor(last) : null,
      total: counted[0]?.total ?? 0,
    })
  })

  // The same category conditions `entriesPage` filters `categoryStatus` by.
  const findCounts = SqlSchema.findOne({
    Request: Schema.Void,
    Result: Schema.Struct({
      total: Schema.Int,
      review: Schema.Int,
      uncategorized: Schema.Int,
    }),
    execute: () => sql`
      SELECT count(*) AS total,
        coalesce(sum(c.status = 'review'), 0) AS review,
        coalesce(sum(c.entry_id IS NULL OR c.status = 'none'), 0) AS uncategorized
      FROM ledger_entries e
      LEFT JOIN category_inferences c ON c.entry_id = e.id
    `,
  })

  /** Every entry, and those waiting on a category decision, in one query. */
  const entryCounts = findCounts(undefined).pipe(
    Effect.withSpan('ReadModel.entryCounts'),
  )

  const findEntry = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: EntryRow,
    execute: (id) => sql`
      SELECT ${entryColumns}
      FROM ${entrySource}
      WHERE e.id = ${id}
    `,
  })
  const findEvidence = SqlSchema.findAll({
    Request: Schema.String,
    Result: Evidence,
    execute: (entryId) => sql`
      SELECT o.source_id AS sourceId, s.kind AS sourceKind, s.label AS sourceLabel,
        o.external_id AS externalId, o.version, o.booked_on AS bookedOn,
        o.amount_cents AS amountCents, o.description, o.status, o.observed_at AS observedAt
      FROM entry_evidence v
      JOIN sources s ON s.id = v.source_id
      JOIN transaction_observations o ON o.source_id = v.source_id
        AND o.account_id = v.account_id AND o.external_id = v.external_id
      WHERE v.entry_id = ${entryId}
        AND o.version = (
          SELECT max(l.version) FROM transaction_observations l
          WHERE l.source_id = o.source_id AND l.account_id = o.account_id
            AND l.external_id = o.external_id
        )
      ORDER BY o.observed_at, o.source_id, o.external_id
    `,
  })
  const findRelations = SqlSchema.findAll({
    Request: Schema.String,
    Result: RelationRow,
    execute: (entryId) => sql`
      SELECT key, kind, outflow_entry_id AS outflowEntryId, inflow_entry_id AS inflowEntryId,
        status, origin, score, reasons
      FROM relations
      WHERE outflow_entry_id = ${entryId} OR inflow_entry_id = ${entryId}
      ORDER BY key
    `,
  })
  const findExplanation = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: ExplanationRow,
    execute: (entryId) => sql`
      SELECT entry_id AS entryId, category_id AS categoryId, origin, origin_ref AS originRef,
        policy_version AS policyVersion, confidence, status,
        excluded_from_spending AS excludedFromSpending, reasons, candidates
      FROM category_inferences WHERE entry_id = ${entryId}
    `,
  })

  /** An entry with the observations behind it, its relations and why it has its category. */
  const entryDetail = Effect.fn('ReadModel.entryDetail')(function* (
    entryId: string,
  ) {
    const found = yield* findEntry(entryId)
    if (Option.isNone(found)) return Option.none()
    const [evidence, relations, category] = yield* Effect.all([
      findEvidence(entryId),
      findRelations(entryId),
      findExplanation(entryId),
    ])
    return Option.some({
      entry: (yield* toEntries([found.value]))[0]!,
      evidence,
      relations,
      category: Option.getOrNull(category),
    })
  })

  /** Entries by id, for showing both sides of relations; missing ones are skipped. */
  const entriesById = Effect.fn('ReadModel.entriesById')(function* (
    ids: ReadonlyArray<string>,
  ) {
    const rows = yield* inChunks([...new Set(ids)], (chunk) =>
      sql`
        SELECT ${entryColumns}
        FROM ${entrySource}
        WHERE ${sql.in('e.id', chunk)}
      `.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(EntryRow))),
      ),
    )
    const entries = yield* toEntries(rows)
    return new Map(entries.map((entry) => [entry.id, entry]))
  })

  return {
    accountViews,
    accountView,
    entriesPage,
    entryCounts,
    entryDetail,
    entriesById,
  }
})

export class ReadModel extends Context.Service<
  ReadModel,
  Effect.Success<typeof make>
>()('@spendle/server/api/ReadModel') {
  static readonly layer = Layer.effect(ReadModel, make)
}
