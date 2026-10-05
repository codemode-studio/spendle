import { assert, describe, it } from '@effect/vitest'
import * as DateTime from 'effect/DateTime'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Ref from 'effect/Ref'
import * as TestClock from 'effect/testing/TestClock'

import * as Sqlite from '../persistence/Sqlite.ts'
import { fakeRateSource } from '../testing/FakeRates.ts'
import type { FakeSeries } from '../testing/FakeRates.ts'
import { ExchangeRates } from './ExchangeRates.ts'
import { RateSource } from './RateSource.ts'

const usd: FakeSeries = {
  USD: [
    ['2026-09-25', 5_199_100],
    ['2026-09-28', 5_210_000],
    ['2026-09-29', 5_220_000],
    ['2026-09-30', 5_230_000],
    ['2026-10-01', 5_240_000],
    ['2026-10-02', 5_250_000],
    ['2026-10-05', 5_260_000],
  ],
}

// Monday 2026-10-05, 15:00 in São Paulo.
const withRates = <A>(
  series: FakeSeries,
  body: (
    rates: ExchangeRates['Service'],
    requests: Ref.Ref<ReadonlyArray<readonly [string, string, string]>>,
  ) => Effect.Effect<A>,
  failing: ReadonlyArray<string> = [],
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(
      DateTime.toEpochMillis(DateTime.makeUnsafe('2026-10-05T18:00:00Z')),
    )
    const requests = yield* Ref.make<
      ReadonlyArray<readonly [string, string, string]>
    >([])
    return yield* Effect.gen(function* () {
      return yield* body(yield* ExchangeRates, requests)
    }).pipe(
      Effect.provide(
        ExchangeRates.layer.pipe(
          Layer.provide(
            Layer.succeed(
              RateSource,
              fakeRateSource(series, requests, failing),
            ),
          ),
          Layer.provide(Sqlite.layerMemory),
        ),
      ),
    )
  })

describe('ExchangeRates', () => {
  it.effect(
    'fetches a period once and answers later reads from the cache',
    () =>
      withRates(usd, (rates, requests) =>
        Effect.gen(function* () {
          const first = yield* rates.table([
            { currency: 'USD', from: '2026-09-28' },
            { currency: 'BRL', from: '2026-01-01' },
          ])
          const second = yield* rates.table([
            { currency: 'USD', from: '2026-09-29' },
          ])
          assert.deepStrictEqual(
            {
              requests: yield* Ref.get(requests),
              first: first
                .get('USD')
                ?.map((rate) => [rate.date, rate.rateMicros]),
              sameAgain: second.get('USD')?.length,
              brl: first.has('BRL'),
            },
            {
              requests: [['USD', '2026-09-28', '2026-10-05']],
              first: [
                ['2026-09-28', 5_210_000],
                ['2026-09-29', 5_220_000],
                ['2026-09-30', 5_230_000],
                ['2026-10-01', 5_240_000],
                ['2026-10-02', 5_250_000],
                ['2026-10-05', 5_260_000],
              ],
              sameAgain: 6,
              brl: false,
            },
          )
        }),
      ),
  )

  it.effect('asks only for the earlier days a later read needs', () =>
    withRates(usd, (rates, requests) =>
      Effect.gen(function* () {
        yield* rates.table([{ currency: 'USD', from: '2026-09-30' }])
        const wider = yield* rates.table([
          { currency: 'USD', from: '2026-09-25' },
        ])
        assert.deepStrictEqual(
          {
            requests: yield* Ref.get(requests),
            earliest: wider.get('USD')?.[0]?.date,
          },
          {
            requests: [
              ['USD', '2026-09-30', '2026-10-05'],
              ['USD', '2026-09-25', '2026-09-29'],
            ],
            earliest: '2026-09-25',
          },
        )
      }),
    ),
  )

  it.effect('asks again for the latest days once they are stale', () =>
    withRates(
      {
        USD: usd.USD!.filter(([date]) => date < '2026-10-05'),
      },
      (rates, requests) =>
        Effect.gen(function* () {
          yield* rates.table([{ currency: 'USD', from: '2026-10-01' }])
          // Within the hour the missing close of today is not asked for again.
          yield* rates.table([{ currency: 'USD', from: '2026-10-01' }])
          yield* TestClock.adjust(Duration.hours(1))
          yield* rates.table([{ currency: 'USD', from: '2026-10-01' }])
          assert.deepStrictEqual(yield* Ref.get(requests), [
            ['USD', '2026-10-01', '2026-10-05'],
            ['USD', '2026-10-05', '2026-10-05'],
          ])
        }),
    ),
  )

  it.effect(
    'keeps cached rates when the source fails and leaves unknown currencies out',
    () =>
      withRates(
        usd,
        (rates) =>
          Effect.gen(function* () {
            const table = yield* rates.table([
              { currency: 'USD', from: '2026-10-01' },
              { currency: 'EUR', from: '2026-10-01' },
            ])
            const on = yield* rates.on(['USD', 'EUR'], '2026-10-04')
            assert.deepStrictEqual(
              {
                currencies: [...table.keys()],
                // Sunday: Friday's close applies.
                usdOnSunday: on.get('USD'),
                eur: on.has('EUR'),
              },
              {
                currencies: ['USD'],
                usdOnSunday: {
                  date: '2026-10-02',
                  rateMicros: 5_250_000,
                  source: 'Fake',
                },
                eur: false,
              },
            )
          }),
        ['EUR'],
      ),
  )
})
