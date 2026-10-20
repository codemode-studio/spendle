import * as Context from 'effect/Context'
import * as Crypto from 'effect/Crypto'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'

import { today } from '../domain/LocalDate.ts'
import { addEndpoints, covering, holders } from '../ledger/Followed.ts'
import { inChunks } from '../persistence/Chunks.ts'
import { toBrlCents } from '../rates/Conversion.ts'
import { ExchangeRates } from '../rates/ExchangeRates.ts'
import { valuePosition } from './Valuation.ts'

export class InvestmentsError extends Schema.TaggedError<InvestmentsError>()(
  'InvestmentsError',
  {
    reason: Schema.Literals([
      'entry_not_found',
      'position_not_found',
      'asset_class_not_found',
      /** Positions live in brokerage accounts (kind or purpose `investment`). */
      'not_an_investment_account',
      /** A movement goes into a position of its own account. */
      'position_account_mismatch',
      'not_classified',
      'invalid_input',
    ]),
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return [this.reason, this.detail].filter(Boolean).join(': ')
  }
}

export interface NewPosition {
  readonly accountId: string
  readonly assetClassId: string
  readonly name: string
  readonly symbol?: string | null | undefined
  /** Counts toward the emergency reserve. */
  readonly reserve: boolean
  readonly openingCents?: number | undefined
  readonly archived?: boolean | undefined
}

const PositionRow = Schema.Struct({
  id: Schema.String,
  accountId: Schema.String,
  accountName: Schema.String,
  institutionName: Schema.String,
  currency: Schema.String,
  assetClassId: Schema.String,
  assetClassName: Schema.String,
  color: Schema.String,
  name: Schema.String,
  symbol: Schema.NullOr(Schema.String),
  reserve: Schema.BooleanFromBit,
  openingCents: Schema.Int,
})

const EntryRow = Schema.Struct({
  id: Schema.String,
  accountId: Schema.String,
  bookedOn: Schema.String,
  amountCents: Schema.Int,
  currency: Schema.String,
  description: Schema.String,
  status: Schema.Literals(['pending', 'posted']),
})

const AccountRow = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  institutionName: Schema.String,
  currency: Schema.String,
  kind: Schema.String,
  purpose: Schema.String,
  archived: Schema.BooleanFromBit,
})

const ClassRow = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  color: Schema.String,
})

// A snapshot lists at most `availableLimit` unplaced brokerage movements,
// reading them `availablePage` at a time.
const availableLimit = 100
const availablePage = 200

const isBrokerage = (account: { kind: string; purpose: string }) =>
  account.kind === 'investment' || account.purpose === 'investment'

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const crypto = yield* Crypto.Crypto
  const exchangeRates = yield* ExchangeRates

  const now = Effect.map(DateTime.now, DateTime.formatIso)
  const newId = crypto.randomUUIDv7.pipe(Effect.orDie)

  const findPositions = SqlSchema.findAll({
    Request: Schema.Void,
    Result: PositionRow,
    execute: () => sql`
      SELECT p.id, p.account_id AS accountId, a.name AS accountName,
        i.name AS institutionName, a.currency, p.asset_class_id AS assetClassId,
        c.name AS assetClassName, c.color, p.name, p.symbol, p.reserve,
        p.opening_cents AS openingCents
      FROM investment_positions p
      JOIN accounts a ON a.id = p.account_id
      JOIN institutions i ON i.id = a.institution_id
      JOIN investment_asset_classes c ON c.id = p.asset_class_id
      WHERE p.archived_at IS NULL
      ORDER BY p.created_at, p.rowid
    `,
  })
  const findPosition = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ id: Schema.String, accountId: Schema.String }),
    execute: (id) => sql`
      SELECT id, account_id AS accountId FROM investment_positions WHERE id = ${id}
    `,
  })
  const findDecisions = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({
      key: Schema.String,
      positionId: Schema.String,
      revision: Schema.Int,
    }),
    execute: () => sql`
      SELECT key, position_id AS positionId, revision FROM investment_movement_decisions
    `,
  })
  const findValuations = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({
      positionId: Schema.String,
      asOf: Schema.String,
      amountCents: Schema.Int,
      sequence: Schema.Int,
    }),
    execute: () => sql`
      SELECT position_id AS positionId, as_of AS asOf, amount_cents AS amountCents,
        rowid AS sequence
      FROM investment_valuations ORDER BY as_of, rowid
    `,
  })
  const findAccounts = SqlSchema.findAll({
    Request: Schema.Void,
    Result: AccountRow,
    execute: () => sql`
      SELECT a.id, a.name, i.name AS institutionName, a.currency, a.kind, a.purpose,
        (a.archived_at IS NOT NULL) AS archived
      FROM accounts a JOIN institutions i ON i.id = a.institution_id
      ORDER BY a.created_at, a.rowid
    `,
  })
  const findClasses = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ClassRow,
    execute: () => sql`
      SELECT id, name, color FROM investment_asset_classes
      WHERE active = 1 ORDER BY sort_order, name
    `,
  })
  const entryColumns = sql`
    e.id, e.account_id AS accountId, e.booked_on AS bookedOn, e.amount_cents AS amountCents,
    e.currency, e.description, e.status
  `
  const entriesIn = (ids: ReadonlyArray<string>) =>
    inChunks(ids, (chunk) =>
      sql`
        SELECT ${entryColumns} FROM ledger_entries e WHERE ${sql.in('e.id', chunk)}
      `.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(EntryRow))),
      ),
    )
  const findEntry = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: EntryRow,
    execute: (id) =>
      sql`SELECT ${entryColumns} FROM ledger_entries e WHERE e.id = ${id}`,
  })

  /** Each entry's position: the latest decision whose observations it alone holds. */
  const placements = Effect.gen(function* () {
    const decisions = yield* findDecisions(undefined)
    const entriesOf = yield* holders(sql, 'investment_movement_endpoints')
    const byEntry = new Map<
      string,
      { readonly positionId: string; readonly revision: number }
    >()
    for (const decision of decisions) {
      const held = entriesOf.get(decision.key) ?? []
      if (held.length !== 1) continue
      const entryId = held[0]!
      const current = byEntry.get(entryId)
      if (current === undefined || current.revision < decision.revision)
        byEntry.set(entryId, decision)
    }
    return { byEntry, entriesOf, decisions }
  })

  /**
   * Positions with their value at the end of `on` (today in São Paulo by
   * default), the movements classified into them, the brokerage movements
   * still unclassified, and totals by currency and in reais.
   */
  const snapshot = Effect.fn('Investments.snapshot')(function* (
    on?: string | undefined,
  ) {
    const referenceDate = on ?? (yield* today)
    const [positions, valuations, accounts, classes, placed] =
      yield* Effect.all([
        findPositions(undefined),
        findValuations(undefined),
        findAccounts(undefined),
        findClasses(undefined),
        placements,
      ])
    const placedEntries = yield* entriesIn([...placed.byEntry.keys()])
    const movementsOf = new Map<string, Array<typeof EntryRow.Type>>()
    for (const entry of placedEntries) {
      const positionId = placed.byEntry.get(entry.id)!.positionId
      const list = movementsOf.get(positionId) ?? []
      list.push(entry)
      movementsOf.set(positionId, list)
    }
    const valuationsOf = new Map<string, Array<(typeof valuations)[number]>>()
    for (const valuation of valuations) {
      const list = valuationsOf.get(valuation.positionId) ?? []
      list.push(valuation)
      valuationsOf.set(valuation.positionId, list)
    }
    const rates = yield* exchangeRates.on(
      positions.map((p) => p.currency),
      referenceDate,
    )
    const inBrl = (cents: number, currency: string) => {
      if (currency === 'BRL') return cents
      const quote = rates.get(currency)
      return quote === undefined
        ? null
        : toBrlCents(cents, currency, quote.rateMicros)
    }

    const items = positions.map((position) => {
      const movements = movementsOf.get(position.id) ?? []
      const value = valuePosition({
        openingCents: position.openingCents,
        movements: movements.map((entry) => ({ ...entry, entryId: entry.id })),
        valuations: valuationsOf.get(position.id) ?? [],
        referenceDate,
      })
      const counted = new Set(value.counted)
      return {
        ...position,
        contributedCents: value.contributedCents,
        currentCents: value.currentCents,
        resultCents: value.currentCents - value.contributedCents,
        valueKind: value.valueKind,
        valuedOn: value.valuedOn,
        currentBrlCents: inBrl(value.currentCents, position.currency),
        quote: rates.get(position.currency) ?? null,
        movements: [...movements]
          .sort((a, b) =>
            a.bookedOn === b.bookedOn
              ? b.id.localeCompare(a.id)
              : b.bookedOn.localeCompare(a.bookedOn),
          )
          .map((entry) => ({
            entryId: entry.id,
            bookedOn: entry.bookedOn,
            description: entry.description,
            amountCents: entry.amountCents,
            status: entry.status,
            counted: counted.has(entry.id),
          })),
        valuations: (valuationsOf.get(position.id) ?? [])
          .map(({ asOf, amountCents }) => ({ asOf, amountCents }))
          .reverse(),
      }
    })
    items.sort((a, b) => (b.currentBrlCents ?? -1) - (a.currentBrlCents ?? -1))

    const brokerage = accounts.filter(
      (account) => isBrokerage(account) && !account.archived,
    )
    const brokerageIds = new Set(brokerage.map((account) => account.id))
    // The newest 100 brokerage movements not yet placed. Placed ones are
    // skipped here, page by page, rather than listed in the query: they grow
    // past the parameters a Durable Object's SQLite binds.
    const available: Array<typeof EntryRow.Type> = []
    let after: typeof EntryRow.Type | undefined
    while (brokerageIds.size > 0 && available.length < availableLimit) {
      const page = yield* sql`
        SELECT ${entryColumns} FROM ledger_entries e
        WHERE ${sql.in('e.account_id', [...brokerageIds])} AND e.amount_cents <> 0
          ${after === undefined ? sql`` : sql`AND (e.booked_on, e.id) < (${after.bookedOn}, ${after.id})`}
        ORDER BY e.booked_on DESC, e.id DESC
        LIMIT ${availablePage}
      `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(EntryRow))))
      available.push(...page.filter((entry) => !placed.byEntry.has(entry.id)))
      if (page.length < availablePage) break
      after = page.at(-1)
    }
    available.splice(availableLimit)

    const totals = new Map<
      string,
      { currentCents: number; contributedCents: number }
    >()
    for (const item of items) {
      const total = totals.get(item.currency) ?? {
        currentCents: 0,
        contributedCents: 0,
      }
      total.currentCents += item.currentCents
      total.contributedCents += item.contributedCents
      totals.set(item.currency, total)
    }
    const sumBrl = (list: ReadonlyArray<(typeof items)[number]>) =>
      list.reduce((sum, item) => sum + (item.currentBrlCents ?? 0), 0)
    const reserve = items.filter((item) => item.reserve)
    return {
      referenceDate,
      positions: items,
      classes,
      accounts: brokerage.map(({ id, name, institutionName, currency }) => ({
        id,
        name,
        institutionName,
        currency,
      })),
      available: available.map((entry) => ({
        entryId: entry.id,
        accountId: entry.accountId,
        bookedOn: entry.bookedOn,
        description: entry.description,
        amountCents: entry.amountCents,
        currency: entry.currency,
        status: entry.status,
      })),
      summary: {
        totalBrlCents: sumBrl(items),
        byCurrency: [...totals].map(([currency, total]) => ({
          currency,
          ...total,
        })),
        positionCount: items.length,
        accountCount: new Set(items.map((item) => item.accountId)).size,
        reserveBrlCents: sumBrl(reserve),
        reservePositionCount: reserve.length,
        missingQuoteCount: items.filter((item) => item.currentBrlCents === null)
          .length,
      },
    }
  })

  const brokerageAccount = Effect.fnUntraced(function* (accountId: string) {
    const account = (yield* findAccounts(undefined)).find(
      (found) => found.id === accountId,
    )
    if (account === undefined || !isBrokerage(account))
      return yield* new InvestmentsError({
        reason: 'not_an_investment_account',
        detail: accountId,
      })
    return account
  })

  const insertPosition = Effect.fnUntraced(function* (input: NewPosition) {
    const name = input.name.trim()
    if (name.length < 2 || name.length > 100)
      return yield* new InvestmentsError({
        reason: 'invalid_input',
        detail: 'name',
      })
    yield* brokerageAccount(input.accountId)
    const assetClass = yield* sql<{ id: string }>`
      SELECT id FROM investment_asset_classes WHERE id = ${input.assetClassId}
    `
    if (assetClass.length === 0)
      return yield* new InvestmentsError({
        reason: 'asset_class_not_found',
        detail: input.assetClassId,
      })
    const id = yield* newId
    const createdAt = yield* now
    yield* sql`
      INSERT INTO investment_positions (id, account_id, asset_class_id, name, symbol, reserve,
        opening_cents, created_at, archived_at)
      VALUES (${id}, ${input.accountId}, ${input.assetClassId}, ${name},
        ${input.symbol?.trim() || null}, ${input.reserve ? 1 : 0}, ${input.openingCents ?? 0},
        ${createdAt}, ${input.archived ? createdAt : null})
    `
    return { id }
  })

  /** A position the person keeps at a brokerage account. */
  const createPosition = Effect.fn('Investments.createPosition')(
    (input: NewPosition) => sql.withTransaction(insertPosition(input)),
  )

  /**
   * The person putting a brokerage movement into a position, or a new one
   * created with it. A movement sits in one position: classifying it again
   * moves it.
   */
  const classify = Effect.fn('Investments.classify')(function* (input: {
    readonly entryId: string
    readonly positionId?: string | undefined
    readonly newPosition?: Omit<NewPosition, 'accountId'> | undefined
  }) {
    if ((input.positionId === undefined) === (input.newPosition === undefined))
      return yield* new InvestmentsError({
        reason: 'invalid_input',
        detail: 'give a position or a new one',
      })
    const found = yield* findEntry(input.entryId)
    if (Option.isNone(found))
      return yield* new InvestmentsError({
        reason: 'entry_not_found',
        detail: input.entryId,
      })
    const entry = found.value
    yield* brokerageAccount(entry.accountId)
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        let positionId: string
        if (input.newPosition !== undefined) {
          positionId = (yield* insertPosition({
            ...input.newPosition,
            accountId: entry.accountId,
          })).id
        } else {
          const position = yield* findPosition(input.positionId!)
          if (Option.isNone(position))
            return yield* new InvestmentsError({
              reason: 'position_not_found',
              detail: input.positionId,
            })
          if (position.value.accountId !== entry.accountId)
            return yield* new InvestmentsError({
              reason: 'position_account_mismatch',
              detail: position.value.id,
            })
          positionId = position.value.id
        }
        const keys = covering(
          yield* holders(sql, 'investment_movement_endpoints'),
          entry.id,
        )
        const targets = keys.length > 0 ? keys : [yield* newId]
        const decidedAt = yield* now
        for (const key of targets) {
          yield* sql`
            INSERT INTO investment_movement_decisions (key, position_id, origin, decided_at, revision)
            VALUES (${key}, ${positionId}, 'person', ${decidedAt},
              (SELECT coalesce(max(revision), 0) + 1 FROM investment_movement_decisions))
            ON CONFLICT (key) DO UPDATE SET position_id = excluded.position_id,
              origin = excluded.origin, decided_at = excluded.decided_at,
              revision = excluded.revision
          `
          yield* addEndpoints(
            sql,
            'investment_movement_endpoints',
            key,
            entry.id,
          )
        }
        return { entryId: entry.id, positionId }
      }),
    )
  })

  /** The position a movement sits in, if any. */
  const positionOf = Effect.fn('Investments.positionOf')(function* (
    entryId: string,
  ) {
    return Option.fromNullishOr(
      (yield* placements).byEntry.get(entryId)?.positionId,
    )
  })

  /**
   * Takes a movement out of its position. A position left with nothing
   * (no movement, valuation or opening amount) goes with it.
   */
  const unclassify = Effect.fn('Investments.unclassify')(function* (
    entryId: string,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const { decisions, entriesOf } = yield* placements
        const keys = new Set(covering(entriesOf, entryId))
        if (keys.size === 0)
          return yield* new InvestmentsError({
            reason: 'not_classified',
            detail: entryId,
          })
        const affected = new Set(
          decisions
            .filter((decision) => keys.has(decision.key))
            .map((decision) => decision.positionId),
        )
        for (const key of keys)
          yield* sql`DELETE FROM investment_movement_decisions WHERE key = ${key}`
        let positionDeleted = false
        for (const positionId of affected) {
          const deleted = yield* sql<{ id: string }>`
            DELETE FROM investment_positions
            WHERE id = ${positionId} AND opening_cents = 0
              AND NOT EXISTS (SELECT 1 FROM investment_movement_decisions d
                WHERE d.position_id = ${positionId})
              AND NOT EXISTS (SELECT 1 FROM investment_valuations v
                WHERE v.position_id = ${positionId})
            RETURNING id
          `
          positionDeleted ||= deleted.length > 0
        }
        return { entryId, positionDeleted }
      }),
    )
  })

  /** What the person says the position was worth at the end of `asOf`. */
  const recordValuation = Effect.fn('Investments.recordValuation')(
    function* (input: {
      readonly positionId: string
      readonly asOf: string
      readonly amountCents: number
    }) {
      if (!Number.isSafeInteger(input.amountCents) || input.amountCents < 0)
        return yield* new InvestmentsError({
          reason: 'invalid_input',
          detail: 'amountCents',
        })
      if (Option.isNone(yield* findPosition(input.positionId)))
        return yield* new InvestmentsError({
          reason: 'position_not_found',
          detail: input.positionId,
        })
      const id = yield* newId
      yield* sql`
      INSERT INTO investment_valuations (id, position_id, as_of, amount_cents, origin, recorded_at)
      VALUES (${id}, ${input.positionId}, ${input.asOf}, ${input.amountCents}, 'person', ${yield* now})
    `
      return { id, positionId: input.positionId }
    },
  )

  return {
    snapshot,
    createPosition,
    classify,
    positionOf,
    unclassify,
    recordValuation,
  }
})

/**
 * Investment positions. Positions, classifications and valuations are the
 * person's; values are a projection of them and the posted entries.
 */
export class Investments extends Context.Service<
  Investments,
  Effect.Success<typeof make>
>()('@spendle/server/investments/Investments') {
  static readonly layer = Layer.effect(Investments, make)
}
