import * as Context from 'effect/Context'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientResponse from 'effect/http/HttpClientResponse'

import type { Rate } from './Conversion.ts'

export class RateSourceError extends Schema.TaggedError<RateSourceError>()(
  'RateSourceError',
  {
    currency: Schema.String,
    source: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export interface RateSourceShape {
  /**
   * The rates of `currency` published from `from` through `through`, both
   * `YYYY-MM-DD`. Empty when the source has none in the period.
   */
  readonly daily: (
    currency: string,
    from: string,
    through: string,
  ) => Effect.Effect<ReadonlyArray<Rate>, RateSourceError>
}

/** Currencies the Banco Central publishes a PTAX rate for. */
export const ptaxCurrencies = new Set([
  'AUD',
  'CAD',
  'CHF',
  'DKK',
  'EUR',
  'GBP',
  'JPY',
  'NOK',
  'SEK',
  'USD',
])

const ptaxUrl =
  'https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoMoedaPeriodo(moeda=@moeda,dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)'
const currencyApiUrl =
  'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies'
const timeout = Duration.seconds(5)

const PtaxBody = Schema.Struct({
  value: Schema.Array(
    Schema.Struct({
      cotacaoVenda: Schema.Finite,
      dataHoraCotacao: Schema.String,
      tipoBoletim: Schema.String,
    }),
  ),
})

/** `YYYY-MM-DD` as PTAX reads dates, `MM-DD-YYYY`. */
const ptaxDate = (date: string) =>
  `${date.slice(5, 7)}-${date.slice(8, 10)}-${date.slice(0, 4)}`

const micros = (rate: number) => Math.round(rate * 1_000_000)

/**
 * Where exchange rates come from: the Banco Central's PTAX closing rate
 * (selling side) for the currencies it publishes, and a public currency
 * API's latest rate for the rest (crypto, for example), which has no
 * history.
 */
export class RateSource extends Context.Service<RateSource, RateSourceShape>()(
  '@spendle/server/rates/RateSource',
) {
  static readonly layer = Layer.effect(
    RateSource,
    Effect.gen(function* () {
      const http = (yield* HttpClient.HttpClient).pipe(
        HttpClient.filterStatusOk,
      )

      const ptax = (currency: string, from: string, through: string) =>
        http
          .get(ptaxUrl, {
            urlParams: {
              '@moeda': `'${currency}'`,
              '@dataInicial': `'${ptaxDate(from)}'`,
              '@dataFinalCotacao': `'${ptaxDate(through)}'`,
              $format: 'json',
              $select: 'cotacaoVenda,dataHoraCotacao,tipoBoletim',
            },
          })
          .pipe(
            Effect.flatMap(HttpClientResponse.schemaBodyJson(PtaxBody)),
            Effect.timeout(timeout),
            Effect.map((body) =>
              body.value
                .filter(
                  (row) =>
                    row.tipoBoletim === 'Fechamento' && row.cotacaoVenda > 0,
                )
                .map((row): Rate => ({
                  date: row.dataHoraCotacao.slice(0, 10),
                  rateMicros: micros(row.cotacaoVenda),
                  source: 'PTAX',
                })),
            ),
            Effect.mapError(
              (cause) =>
                new RateSourceError({ currency, source: 'PTAX', cause }),
            ),
          )

      const latest = (currency: string) => {
        const key = currency.toLowerCase()
        const Body = Schema.Struct({
          date: Schema.String,
          [key]: Schema.Struct({ brl: Schema.Finite }),
        })
        return http.get(`${currencyApiUrl}/${key}.json`).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Body)),
          Effect.timeout(timeout),
          Effect.map((body) => {
            const rate = (body[key] as { readonly brl: number }).brl
            return rate > 0
              ? [
                  {
                    date: body.date as string,
                    rateMicros: micros(rate),
                    source: 'Currency API',
                  } satisfies Rate,
                ]
              : []
          }),
          Effect.mapError(
            (cause) =>
              new RateSourceError({ currency, source: 'Currency API', cause }),
          ),
        )
      }

      return RateSource.of({
        daily: (currency, from, through) =>
          ptaxCurrencies.has(currency)
            ? ptax(currency, from, through)
            : latest(currency),
      })
    }),
  )
}
