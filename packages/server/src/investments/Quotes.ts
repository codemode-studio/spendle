import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Ref from 'effect/Ref'
import * as Schema from 'effect/Schema'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientResponse from 'effect/http/HttpClientResponse'

/** Reais per unit of a currency, × 1 000 000, on the day the source quoted it. */
export interface Quote {
  readonly rateMicros: number
  readonly date: string
  readonly source: string
}

export interface QuotesShape {
  /**
   * The BRL quote of each currency that has one now. Missing currencies
   * have no quote (the source failed or does not know them); values in
   * them stay in their own currency.
   */
  readonly toBrl: (
    currencies: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyMap<string, Quote>>
}

const baseUrl =
  'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies'
const cacheFor = Duration.minutes(15)
const timeout = Duration.seconds(2)

/**
 * Public exchange rates for showing foreign positions in reais. Only a
 * display aid: nothing is stored, and a failed lookup leaves the values in
 * their currency.
 */
export class Quotes extends Context.Service<Quotes, QuotesShape>()(
  '@spendle/server/investments/Quotes',
) {
  static readonly layer = Layer.effect(
    Quotes,
    Effect.gen(function* () {
      const http = (yield* HttpClient.HttpClient).pipe(
        HttpClient.filterStatusOk,
      )
      const cache = yield* Ref.make(
        new Map<string, { readonly quote: Quote; readonly until: number }>(),
      )
      const fetchQuote = (currency: string) => {
        const key = currency.toLowerCase()
        const Body = Schema.Struct({
          date: Schema.String,
          [key]: Schema.Struct({ brl: Schema.Finite }),
        })
        return http.get(`${baseUrl}/${key}.json`).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Body)),
          Effect.timeout(timeout),
          Effect.map((body) => {
            const rate = (body[key] as { readonly brl: number }).brl
            return rate > 0
              ? [
                  {
                    rateMicros: Math.round(rate * 1_000_000),
                    date: body.date as string,
                    source: 'Currency API',
                  } satisfies Quote,
                ]
              : []
          }),
          Effect.catch((error) =>
            Effect.logWarning('Quote unavailable', { currency, error }).pipe(
              Effect.as([]),
            ),
          ),
        )
      }
      const toBrl = Effect.fn('Quotes.toBrl')(function* (
        currencies: ReadonlyArray<string>,
      ) {
        const now = yield* Clock.currentTimeMillis
        const cached = yield* Ref.get(cache)
        const found = new Map<string, Quote>()
        const missing: Array<string> = []
        for (const currency of new Set(currencies)) {
          if (currency === 'BRL') continue
          const hit = cached.get(currency)
          if (hit !== undefined && hit.until > now)
            found.set(currency, hit.quote)
          else missing.push(currency)
        }
        const fetched = yield* Effect.forEach(
          missing,
          (currency) =>
            Effect.map(fetchQuote(currency), (quotes) =>
              quotes.map((quote) => [currency, quote] as const),
            ),
          { concurrency: 'unbounded' },
        )
        const fresh = fetched.flat()
        if (fresh.length > 0)
          yield* Ref.update(cache, (current) => {
            const next = new Map(current)
            for (const [currency, quote] of fresh)
              next.set(currency, {
                quote,
                until: now + Duration.toMillis(cacheFor),
              })
            return next
          })
        for (const [currency, quote] of fresh) found.set(currency, quote)
        return found as ReadonlyMap<string, Quote>
      })
      return Quotes.of({ toBrl })
    }),
  )

  /** Fixed quotes, for tests and offline QA. */
  static readonly fixed = (quotes: Readonly<Record<string, Quote>>) =>
    Layer.succeed(
      Quotes,
      Quotes.of({
        toBrl: (currencies) =>
          Effect.succeed(
            new Map(
              currencies.flatMap((currency) =>
                quotes[currency] === undefined
                  ? []
                  : [[currency, quotes[currency]] as const],
              ),
            ),
          ),
      }),
    )
}
