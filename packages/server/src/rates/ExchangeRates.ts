import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as DateTime from 'effect/DateTime'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Ref from 'effect/Ref'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'

import { addDays, today } from '../domain/LocalDate.ts'
import { baseCurrency, rateOn, rateTable } from './Conversion.ts'
import type { Rate, RateTable } from './Conversion.ts'
import { RateSource } from './RateSource.ts'
import type { RateSourceShape } from './RateSource.ts'

/** A currency and the earliest day a read needs its rate for. */
export interface RateNeed {
  readonly currency: string
  readonly from: string
}

export interface ExchangeRatesShape {
  /**
   * The rates of each currency from its `from` through today. Days the
   * cache lacks are fetched first; when the source fails, the cached rates
   * are all there is, and a currency without any has no entry.
   */
  readonly table: (
    needs: ReadonlyArray<RateNeed>,
  ) => Effect.Effect<RateTable, never, never>
  /** The rate of each currency for `date`, or the latest available. */
  readonly on: (
    currencies: ReadonlyArray<string>,
    date: string,
  ) => Effect.Effect<ReadonlyMap<string, Rate>, never, never>
}

const RateRow = Schema.Struct({
  currency: Schema.String,
  date: Schema.String,
  rateMicros: Schema.Int,
  source: Schema.String,
})

const CoverageRow = Schema.Struct({
  currency: Schema.String,
  coveredFrom: Schema.String,
  coveredThrough: Schema.String,
  checkedAt: Schema.Int,
})

/** How long the latest days stay fresh before the source is asked again. */
const refreshAfter = Duration.hours(1)
/** How long a failed source is left alone before the next attempt. */
const retryAfter = Duration.minutes(5)
/** Days `on` looks back for a date's rate, enough to cross long holidays. */
const lookBackDays = 10

/** The service over the cache; without a source it only reads what is cached. */
const makeWith = (source: RateSourceShape | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const failedAt = yield* Ref.make(new Map<string, number>())

    const findRates = SqlSchema.findAll({
      Request: Schema.Array(Schema.String),
      Result: RateRow,
      execute: (currencies) => sql`
        SELECT currency, rate_date AS date, rate_micros AS rateMicros, source
        FROM exchange_rates WHERE ${sql.in('currency', currencies)}
        ORDER BY currency, rate_date
      `,
    })
    const findCoverage = SqlSchema.findAll({
      Request: Schema.Array(Schema.String),
      Result: CoverageRow,
      execute: (currencies) => sql`
        SELECT currency, covered_from AS coveredFrom, covered_through AS coveredThrough,
          checked_at AS checkedAt
        FROM exchange_rate_coverage WHERE ${sql.in('currency', currencies)}
      `,
    })

    const store = (
      currency: string,
      rates: ReadonlyArray<Rate>,
      coverage: { readonly from: string; readonly through: string },
      checkedAt: number,
    ) =>
      Effect.gen(function* () {
        const fetchedAt = DateTime.formatIso(yield* DateTime.now)
        yield* sql.withTransaction(
          Effect.gen(function* () {
            for (const rate of rates)
              yield* sql`
                INSERT INTO exchange_rates (currency, rate_date, rate_micros, source, fetched_at)
                VALUES (${currency}, ${rate.date}, ${rate.rateMicros}, ${rate.source}, ${fetchedAt})
                ON CONFLICT (currency, rate_date) DO UPDATE SET
                  rate_micros = excluded.rate_micros, source = excluded.source,
                  fetched_at = excluded.fetched_at
              `
            yield* sql`
              INSERT INTO exchange_rate_coverage (currency, covered_from, covered_through, checked_at)
              VALUES (${currency}, ${coverage.from}, ${coverage.through}, ${checkedAt})
              ON CONFLICT (currency) DO UPDATE SET
                covered_from = min(covered_from, excluded.covered_from),
                covered_through = max(covered_through, excluded.covered_through),
                checked_at = max(checked_at, excluded.checked_at)
            `
          }),
        )
      })

    /** Asks the source for what the cache lacks of one currency. */
    const refresh = (
      currency: string,
      from: string,
      day: string,
      now: number,
      coverage: typeof CoverageRow.Type | undefined,
      latestCached: string | undefined,
    ) =>
      Effect.gen(function* () {
        if (source === null) return
        const failed = (yield* Ref.get(failedAt)).get(currency)
        if (
          failed !== undefined &&
          now - failed < Duration.toMillis(retryAfter)
        )
          return
        const spans: Array<readonly [string, string, boolean]> = []
        if (coverage === undefined) spans.push([from, day, true])
        else {
          if (from < coverage.coveredFrom)
            spans.push([from, addDays(coverage.coveredFrom, -1), false])
          const stale =
            now - coverage.checkedAt >= Duration.toMillis(refreshAfter)
          if (stale && (latestCached === undefined || latestCached < day))
            spans.push([
              coverage.coveredThrough < day ? coverage.coveredThrough : day,
              day,
              true,
            ])
        }
        for (const [start, end, tail] of spans) {
          const fetched = yield* source.daily(currency, start, end).pipe(
            Effect.tapError((error) =>
              Effect.logWarning('Exchange rates unavailable', {
                currency,
                source: error.source,
                from: start,
                through: end,
              }).pipe(
                Effect.andThen(
                  Ref.update(failedAt, (current) =>
                    new Map(current).set(currency, now),
                  ),
                ),
              ),
            ),
            Effect.option,
          )
          if (Option.isNone(fetched)) return
          yield* store(
            currency,
            fetched.value,
            { from: start, through: end },
            tail ? now : (coverage?.checkedAt ?? now),
          )
        }
      }).pipe(Effect.orDie)

    const table = Effect.fn('ExchangeRates.table')(function* (
      needs: ReadonlyArray<RateNeed>,
    ) {
      const earliest = new Map<string, string>()
      for (const need of needs) {
        if (need.currency === baseCurrency) continue
        const current = earliest.get(need.currency)
        if (current === undefined || need.from < current)
          earliest.set(need.currency, need.from)
      }
      if (earliest.size === 0) return new Map() as RateTable
      const currencies = [...earliest.keys()]
      const [day, now, coverage, cached] = yield* Effect.all([
        today,
        Clock.currentTimeMillis,
        findCoverage(currencies),
        findRates(currencies),
      ]).pipe(Effect.orDie)
      const latest = new Map<string, string>()
      for (const row of cached) latest.set(row.currency, row.date)
      yield* Effect.forEach(
        earliest,
        ([currency, from]) =>
          refresh(
            currency,
            from < day ? from : day,
            day,
            now,
            coverage.find((row) => row.currency === currency),
            latest.get(currency),
          ),
        { concurrency: 'unbounded', discard: true },
      )
      return rateTable(yield* findRates(currencies).pipe(Effect.orDie))
    })

    const on = Effect.fn('ExchangeRates.on')(function* (
      currencies: ReadonlyArray<string>,
      date: string,
    ) {
      const rates = yield* table(
        currencies.map((currency) => ({
          currency,
          from: addDays(date, -lookBackDays),
        })),
      )
      const found = new Map<string, Rate>()
      for (const currency of currencies) {
        const rate = rateOn(rates, currency, date)
        if (rate !== null) found.set(currency, rate)
      }
      return found as ReadonlyMap<string, Rate>
    })

    return ExchangeRates.of({ table, on })
  })

/**
 * Exchange rates to reais, cached in the database as rebuildable data with
 * the day each applies to. Planning, entries and investments convert other
 * currencies with them; the source is asked only for days the cache lacks.
 */
export class ExchangeRates extends Context.Service<
  ExchangeRates,
  ExchangeRatesShape
>()('@spendle/server/rates/ExchangeRates') {
  static readonly layer = Layer.effect(
    ExchangeRates,
    Effect.gen(function* () {
      return yield* makeWith(yield* RateSource)
    }),
  )

  /** Reads cached rates and never asks a source, for offline tools. */
  static readonly cacheOnly = Layer.effect(ExchangeRates, makeWith(null))
}
