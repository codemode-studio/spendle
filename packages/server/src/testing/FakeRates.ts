import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Ref from 'effect/Ref'

import { ExchangeRates } from '../rates/ExchangeRates.ts'
import { RateSource, RateSourceError } from '../rates/RateSource.ts'

/** Each currency's published rates: `[date, reais per unit × 1 000 000]`. */
export type FakeSeries = Readonly<
  Record<string, ReadonlyArray<readonly [date: string, rateMicros: number]>>
>

/** What the fake source was asked: `[currency, from, through]`. */
export type FakeRequests = Ref.Ref<
  ReadonlyArray<readonly [currency: string, from: string, through: string]>
>

/**
 * A rate source that publishes `series` and records every request; a
 * currency listed in `failing` fails like an unreachable source.
 */
export const fakeRateSource = (
  series: FakeSeries,
  requests: FakeRequests,
  failing: ReadonlyArray<string> = [],
) =>
  RateSource.of({
    daily: (currency, from, through) =>
      Ref.update(requests, (list) => [
        ...list,
        [currency, from, through] as const,
      ]).pipe(
        Effect.andThen(
          failing.includes(currency)
            ? Effect.fail(
                new RateSourceError({
                  currency,
                  source: 'Fake',
                  cause: 'unreachable',
                }),
              )
            : Effect.succeed(
                (series[currency] ?? [])
                  .filter(([date]) => date >= from && date <= through)
                  .map(([date, rateMicros]) => ({
                    date,
                    rateMicros,
                    source: 'Fake',
                  })),
              ),
        ),
      ),
  })

/** `ExchangeRates` over the database with a fake source publishing `series`. */
export const fakeExchangeRates = (series: FakeSeries = {}) =>
  ExchangeRates.layer.pipe(
    Layer.provide(
      Layer.effect(
        RateSource,
        Effect.map(
          Ref.make<ReadonlyArray<readonly [string, string, string]>>([]),
          (requests) => fakeRateSource(series, requests),
        ),
      ),
    ),
  )
