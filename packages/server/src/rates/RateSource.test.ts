import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientResponse from 'effect/http/HttpClientResponse'

import { RateSource } from './RateSource.ts'

// Scripted responses in the shapes PTAX and the currency API answer with.
const sourceWith = (route: (url: URL) => Response) =>
  RateSource.pipe(
    Effect.provide(
      RateSource.layer.pipe(
        Layer.provide(
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request, url) =>
              Effect.succeed(HttpClientResponse.fromWeb(request, route(url))),
            ),
          ),
        ),
      ),
    ),
  )

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status })

describe('RateSource', () => {
  it.effect('reads PTAX closing selling rates for the period asked', () =>
    Effect.gen(function* () {
      const seen: Array<string> = []
      const source = yield* sourceWith((url) => {
        seen.push(
          [
            url.hostname,
            url.searchParams.get('@moeda'),
            url.searchParams.get('@dataInicial'),
            url.searchParams.get('@dataFinalCotacao'),
          ].join(' '),
        )
        return json({
          value: [
            {
              cotacaoVenda: 5.1986,
              dataHoraCotacao: '2026-09-25 10:09:12.64966',
              tipoBoletim: 'Abertura',
            },
            {
              cotacaoVenda: 5.1991,
              dataHoraCotacao: '2026-09-25 13:10:17.447657',
              tipoBoletim: 'Fechamento',
            },
            {
              cotacaoVenda: 5.2104,
              dataHoraCotacao: '2026-09-28 13:09:11.1',
              tipoBoletim: 'Fechamento',
            },
          ],
        })
      })
      const rates = yield* source.daily('USD', '2026-09-25', '2026-09-28')
      assert.deepStrictEqual(
        { seen, rates },
        {
          seen: ["olinda.bcb.gov.br 'USD' '09-25-2026' '09-28-2026'"],
          rates: [
            { date: '2026-09-25', rateMicros: 5_199_100, source: 'PTAX' },
            { date: '2026-09-28', rateMicros: 5_210_400, source: 'PTAX' },
          ],
        },
      )
    }),
  )

  it.effect(
    'takes the latest public rate for a currency PTAX does not publish',
    () =>
      Effect.gen(function* () {
        const source = yield* sourceWith((url) =>
          url.pathname.endsWith('/btc.json')
            ? json({ date: '2026-10-05', btc: { brl: 350_000.5 } })
            : json({}, 404),
        )
        const rates = yield* source.daily('BTC', '2026-09-01', '2026-10-05')
        assert.deepStrictEqual(rates, [
          {
            date: '2026-10-05',
            rateMicros: 350_000_500_000,
            source: 'Currency API',
          },
        ])
      }),
  )

  it.effect(
    'fails with the currency and source when the source answers badly',
    () =>
      Effect.gen(function* () {
        const source = yield* sourceWith(() => json({ error: 'down' }, 503))
        const error = yield* Effect.flip(
          source.daily('EUR', '2026-10-01', '2026-10-05'),
        )
        assert.deepStrictEqual(
          [error._tag, error.currency, error.source],
          ['RateSourceError', 'EUR', 'PTAX'],
        )
      }),
  )
})
