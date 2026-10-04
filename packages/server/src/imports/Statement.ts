import type * as Schema from 'effect/Schema'

/** A transaction line read from a statement file, signed: outflows negative. */
export interface StatementLine {
  readonly externalId: string
  readonly bookedOn: string
  readonly amountCents: number
  readonly description: string
  readonly raw: Schema.Json
}

/** What a statement file declares about itself, beside its lines. */
export interface ParsedStatement {
  readonly format: 'ofx' | 'csv'
  readonly currency: string | null
  /** Whether the file says it is a bank or a card statement, when it does. */
  readonly accountKind: 'account' | 'card' | null
  /** Last four digits of the account number, when the file names it. */
  readonly accountHint: string | null
  /** The period the file says it covers, not the span of its lines. */
  readonly period: { readonly start: string; readonly end: string } | null
  readonly closingBalance: {
    readonly asOf: string
    readonly cents: number
  } | null
  readonly lines: ReadonlyArray<StatementLine>
  /** Rows that looked like transactions but had no valid date, description or amount. */
  readonly rejectedRows: number
}

export type StatementProblem =
  | 'unsupported_format'
  | 'no_statement'
  | 'multiple_statements'
  | 'running_balance_mismatch'
  | 'summary_balance_mismatch'
  | 'mixed_currencies'
  | 'malformed_csv'

/** Folds a description for comparison: no accents, case or repeated spaces. */
export const foldDescription = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLocaleLowerCase('pt-BR')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * Gives every line a stable id within its file. A source id (FITID, an id
 * column) and a fingerprint of date, amount and description live in separate
 * namespaces, and each repetition of the same base gets its own ordinal, so
 * identical purchases stay distinct and no generated id can equal another:
 * `id:a@1`, `id:a@2`, `id:a%402@1`, `fp:2026-09-10|-500|cafe@1`.
 */
export const fingerprintIds = <L extends Omit<StatementLine, 'externalId'>>(
  lines: ReadonlyArray<L & { readonly externalId?: string | undefined }>,
): ReadonlyArray<L & { readonly externalId: string }> => {
  const seen = new Map<string, number>()
  return lines.map((line) => {
    const base = line.externalId
      ? `id:${encodeURIComponent(line.externalId)}`
      : `fp:${encodeURIComponent(`${line.bookedOn}|${line.amountCents}|${foldDescription(line.description)}`)}`
    const occurrence = (seen.get(base) ?? 0) + 1
    seen.set(base, occurrence)
    return { ...line, externalId: `${base}@${occurrence}` }
  })
}

/**
 * Parses an OFX amount. OFX writes one decimal separator (`.` or `,`) and no
 * thousands grouping, so `1.2300` is 1.23. Digits past the centavos must be
 * zeros; anything else cannot be represented exactly and is rejected.
 */
export const parseOfxAmount = (
  text: string,
  fractionDigits = 2,
): number | null => {
  const match = text.trim().match(/^([+-])?(\d*)(?:[.,](\d*))?$/)
  if (!match || (!match[2] && !match[3])) return null
  const [, sign, whole = '', fraction = ''] = match
  if (/[1-9]/.test(fraction.slice(fractionDigits))) return null
  const cents = Number(
    `${whole || '0'}${fraction.slice(0, fractionDigits).padEnd(fractionDigits, '0')}`,
  )
  if (!Number.isSafeInteger(cents)) return null
  return sign === '-' ? -cents : cents
}

/**
 * Parses a money string as written in Brazilian or international files —
 * `1.234,56`, `1,234.56`, `R$ -10,00`, `(10,00)`, `10,00-` — into integer
 * minor units, without going through floating point.
 */
export const parseMoney = (text: string, fractionDigits = 2): number | null => {
  const trimmed = text.trim()
  if (!trimmed) return null
  const negative = /^-|^\(.*\)$|-$/.test(trimmed.replace(/[^\d,.()-]/g, ''))
  const numeric = trimmed.replace(/[^\d,.]/g, '')
  if (!/\d/.test(numeric)) return null
  const lastSeparator = Math.max(
    numeric.lastIndexOf(','),
    numeric.lastIndexOf('.'),
  )
  const decimals = lastSeparator === -1 ? '' : numeric.slice(lastSeparator + 1)
  const isDecimal =
    lastSeparator !== -1 &&
    decimals.length > 0 &&
    decimals.length <= fractionDigits
  const grouped = isDecimal ? numeric.slice(0, lastSeparator) : numeric
  // Thousands must be grouped by threes with one separator that is not the
  // decimal one: `1.234.567,89` and `1,234` are numbers, `1.23.4` is not.
  if (/[,.]/.test(grouped)) {
    const separator = grouped.match(/[,.]/)![0]
    const decimalSeparator = isDecimal ? numeric[lastSeparator] : undefined
    const pattern =
      separator === '.' ? /^\d{1,3}(\.\d{3})+$/ : /^\d{1,3}(,\d{3})+$/
    if (separator === decimalSeparator || !pattern.test(grouped)) return null
  }
  const whole = grouped.replace(/[,.]/g, '')
  const fraction = (isDecimal ? decimals : '').padEnd(fractionDigits, '0')
  const cents = Number(`${whole || '0'}${fraction}`)
  if (!Number.isSafeInteger(cents)) return null
  return negative ? -cents : cents
}

/** Reads `YYYY-MM-DD`, `DD/MM/YYYY`, `DD/MM/YY` or OFX `YYYYMMDD…` as a valid calendar date. */
export const parseDate = (text: string): string | null => {
  const value = text.trim()
  const match =
    value.match(/^(\d{4})-(\d{2})-(\d{2})/) ??
    value.match(/^(\d{4})(\d{2})(\d{2})/) ??
    (() => {
      const brazilian = value.match(/^(\d{2})[/.-](\d{2})[/.-](\d{2,4})\b/)
      return brazilian
        ? ([
            brazilian[0],
            brazilian[3]!.length === 2 ? `20${brazilian[3]}` : brazilian[3]!,
            brazilian[2]!,
            brazilian[1]!,
          ] as const)
        : null
    })()
  if (!match) return null
  const [, year, month, day] = match
  const candidate = `${year}-${month}-${day}`
  const [y, m, d] = [Number(year), Number(month), Number(day)]
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
  const daysInMonth =
    [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] ?? 0
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth ? candidate : null
}
