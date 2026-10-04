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

/** Folds a description for comparison: no accents, case or repeated spaces. */
export const foldDescription = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLocaleLowerCase('pt-BR')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * Gives lines without a source id a stable one. Identical lines in the same
 * file are distinct purchases, so each repetition gets its own ordinal.
 */
export const fingerprintIds = <L extends Omit<StatementLine, 'externalId'>>(
  lines: ReadonlyArray<L & { readonly externalId?: string | undefined }>,
): ReadonlyArray<L & { readonly externalId: string }> => {
  const seen = new Map<string, number>()
  return lines.map((line) => {
    const base =
      line.externalId ||
      `${line.bookedOn}|${line.amountCents}|${foldDescription(line.description)}`
    const occurrence = (seen.get(base) ?? 0) + 1
    seen.set(base, occurrence)
    return {
      ...line,
      externalId: occurrence === 1 ? base : `${base}#${occurrence}`,
    }
  })
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
  const whole = (isDecimal ? numeric.slice(0, lastSeparator) : numeric).replace(
    /[,.]/g,
    '',
  )
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
