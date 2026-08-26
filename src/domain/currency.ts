import { z } from 'zod'

export const supportedCurrencies = ['BRL', 'USD', 'BTC'] as const

export type SupportedCurrency = (typeof supportedCurrencies)[number]

export const currencySchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{3}$/, 'Informe um código de moeda válido.'))

export const currencyOptions: ReadonlyArray<{
  value: SupportedCurrency
  label: string
}> = [
  { value: 'BRL', label: 'BRL — Real brasileiro' },
  { value: 'USD', label: 'USD — Dólar americano' },
  { value: 'BTC', label: 'BTC — Bitcoin' },
]

const fractionDigitsByCurrency: Record<SupportedCurrency, number> = {
  BRL: 2,
  USD: 2,
  BTC: 8,
}

export function isSupportedCurrency(value: string): value is SupportedCurrency {
  return supportedCurrencies.includes(value as SupportedCurrency)
}

export function parseCurrency(value: string) {
  return currencySchema.parse(value)
}

export function currencyFractionDigits(currency: string) {
  const normalized = currency.toUpperCase()
  return isSupportedCurrency(normalized)
    ? fractionDigitsByCurrency[normalized]
    : 2
}

export function currencyMinorUnitFactor(currency: string) {
  return 10 ** currencyFractionDigits(currency)
}

function decimalSeparatorFor(
  unsigned: string,
  currency: string,
): '.' | ',' | null {
  const lastComma = unsigned.lastIndexOf(',')
  const lastDot = unsigned.lastIndexOf('.')
  if (lastComma >= 0 && lastDot >= 0) {
    return lastComma > lastDot ? ',' : '.'
  }
  if (lastComma >= 0) return ','
  if (lastDot < 0) return null

  const dotCount = unsigned.match(/\./g)?.length ?? 0
  const fractionLength = unsigned.length - lastDot - 1
  if (dotCount > 1) {
    const groups = unsigned.split('.').slice(1)
    return groups.every((group) => group.length === 3) ? null : '.'
  }
  if (currency.toUpperCase() !== 'BTC' && fractionLength === 3) return null
  return '.'
}

/** Converts a major-unit decimal value into the currency's smallest unit. */
export function toMinorUnits(value: string | number, currency: string = 'BRL') {
  const fractionDigits = currencyFractionDigits(currency)
  const factor = 10 ** fractionDigits
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Valor monetário inválido.')
    const result = Math.round(value * factor)
    if (!Number.isSafeInteger(result)) {
      throw new Error('Valor monetário fora do intervalo suportado.')
    }
    return result
  }

  let compact = value
    .trim()
    .toUpperCase()
    .replace(/R\$|US\$|BRL|USD|BTC|₿/g, '')
    .replace(/\s/g, '')
  const parenthesized = /^\(.*\)$/.test(compact)
  if (parenthesized) compact = compact.slice(1, -1)
  const negative = parenthesized || compact.startsWith('-')
  compact = compact.replace(/^[+-]/, '')
  if (!compact || !/^[\d.,]+$/.test(compact)) {
    throw new Error('Valor monetário inválido.')
  }

  const decimalSeparator = decimalSeparatorFor(compact, currency)
  const decimalIndex = decimalSeparator
    ? compact.lastIndexOf(decimalSeparator)
    : -1
  const integerDigits = (
    decimalIndex >= 0 ? compact.slice(0, decimalIndex) : compact
  ).replace(/\D/g, '')
  const fraction =
    decimalIndex >= 0 ? compact.slice(decimalIndex + 1).replace(/\D/g, '') : ''
  if (fraction.length > fractionDigits) {
    throw new Error(
      `${currency.toUpperCase()} aceita no máximo ${fractionDigits} casas decimais.`,
    )
  }

  const absolute =
    BigInt(integerDigits || '0') * BigInt(factor) +
    BigInt((fraction || '').padEnd(fractionDigits, '0') || '0')
  const signed = negative ? -absolute : absolute
  const result = Number(signed)
  if (!Number.isSafeInteger(result)) {
    throw new Error('Valor monetário fora do intervalo suportado.')
  }
  return result
}

export function minorUnitsToMajor(value: number, currency: string = 'BRL') {
  return value / currencyMinorUnitFactor(currency)
}

export function convertMinorUnitsAtRate(
  value: number,
  fromCurrency: string,
  toCurrency: string,
  rateMicros: number,
) {
  const converted =
    minorUnitsToMajor(value, fromCurrency) *
    (rateMicros / 1_000_000) *
    currencyMinorUnitFactor(toCurrency)
  const result = Math.round(converted)
  if (!Number.isSafeInteger(result)) {
    throw new Error('Conversão monetária fora do intervalo suportado.')
  }
  return result
}

export function formatMinorUnitsForInput(
  value: number,
  currency: string = 'BRL',
) {
  const fractionDigits = currencyFractionDigits(currency)
  return minorUnitsToMajor(value, currency).toLocaleString('pt-BR', {
    useGrouping: false,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })
}

export function formatCurrency(value: number, currency: string = 'BRL') {
  if (currency.toUpperCase() === 'BTC') {
    const sign = value < 0 ? '-' : ''
    const formatted = new Intl.NumberFormat('pt-BR', {
      minimumFractionDigits: 8,
      maximumFractionDigits: 8,
    }).format(Math.abs(minorUnitsToMajor(value, 'BTC')))
    return `${sign}BTC\u00a0${formatted}`
  }
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency,
  }).format(minorUnitsToMajor(value, currency))
}
