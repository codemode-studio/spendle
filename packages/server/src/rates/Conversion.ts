/**
 * Converting other currencies to reais, without I/O. Rates are the reais
 * one unit of a currency was worth on a day, × 1 000 000; amounts are
 * integer minor units and never pass through floats.
 */

export const baseCurrency = 'BRL'

/** Reais per unit × 1 000 000 on the day it applies to. */
export interface Rate {
  readonly date: string
  readonly rateMicros: number
  readonly source: string
}

/** Each currency's known rates, oldest first. */
export type RateTable = ReadonlyMap<string, ReadonlyArray<Rate>>

export const emptyRates: RateTable = new Map()

/** Digits after the decimal point of a currency's minor unit. */
export const fractionDigits = (currency: string) => (currency === 'BTC' ? 8 : 2)

/**
 * Minor units of `currency` in centavos at `rateMicros` reais per unit
 * (rate × 1 000 000), rounded half away from zero, in exact integers.
 */
export const toBrlCents = (
  amount: number,
  currency: string,
  rateMicros: number,
) => {
  if (currency === baseCurrency) return amount
  const divisor = 1_000_000n * 10n ** BigInt(fractionDigits(currency) - 2)
  const product = BigInt(amount) * BigInt(rateMicros)
  const magnitude = product < 0n ? -product : product
  const rounded = (magnitude * 2n + divisor) / (divisor * 2n)
  return Number(product < 0n ? -rounded : rounded)
}

/**
 * The rate that applies to `date`: the latest published on or before it
 * (markets close on weekends and holidays), or, for a day before any known
 * rate, the earliest one. A future date gets the latest available.
 */
export const rateOn = (
  table: RateTable,
  currency: string,
  date: string,
): Rate | null => {
  const rates = table.get(currency)
  if (rates === undefined || rates.length === 0) return null
  let low = 0
  let high = rates.length - 1
  let found = -1
  while (low <= high) {
    const middle = (low + high) >> 1
    if (rates[middle]!.date <= date) {
      found = middle
      low = middle + 1
    } else high = middle - 1
  }
  return rates[found === -1 ? 0 : found]!
}

/** An amount shown in reais, with what it was before. */
export interface Converted {
  readonly currency: string
  /** The amount in its own currency's minor units. */
  readonly originalCents: number
  readonly rateMicros: number
  readonly rateDate: string
  readonly source: string
}

/**
 * `cents` of `currency` in centavos at the rate of `date`, with the
 * conversion it took; null without a rate. Reais pass through unconverted.
 */
export const convert = (
  table: RateTable,
  cents: number,
  currency: string,
  date: string,
): { readonly cents: number; readonly converted: Converted | null } | null => {
  if (currency === baseCurrency) return { cents, converted: null }
  const rate = rateOn(table, currency, date)
  if (rate === null) return null
  return {
    cents: toBrlCents(cents, currency, rate.rateMicros),
    converted: {
      currency,
      originalCents: cents,
      rateMicros: rate.rateMicros,
      rateDate: rate.date,
      source: rate.source,
    },
  }
}

/** Builds a table from rates in any order; a later rate of the same day replaces an earlier one. */
export const rateTable = (
  rows: ReadonlyArray<Rate & { readonly currency: string }>,
): RateTable => {
  const byCurrency = new Map<string, Map<string, Rate>>()
  for (const { currency, ...rate } of rows) {
    const days = byCurrency.get(currency) ?? new Map<string, Rate>()
    days.set(rate.date, rate)
    byCurrency.set(currency, days)
  }
  return new Map(
    [...byCurrency].map(([currency, days]) => [
      currency,
      [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
    ]),
  )
}
