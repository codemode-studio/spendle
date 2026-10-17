import type * as Result from 'effect/Result'

import { parseMoney } from '../Statement.ts'
import type { StatementProblem } from '../Statement.ts'

/** A text fragment as the PDF extractor reports it, y growing up the page. */
export interface PositionedText {
  readonly text: string
  readonly page: number
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly itemType: string
}

export interface Bounds {
  readonly page: number
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Fragments sharing a baseline, joined left to right. */
export interface PositionedLine {
  readonly text: string
  readonly bounds: Bounds
}

export interface LayoutLine {
  readonly externalId?: string
  readonly bookedOn: string
  readonly amountCents: number
  readonly description: string
  readonly source: PositionedLine
}

/** What a layout read from its statement, amounts signed for the ledger. */
export interface LayoutStatement {
  readonly lines: ReadonlyArray<LayoutLine>
  readonly period: { readonly start: string; readonly end: string } | null
  readonly closingBalance: {
    readonly asOf: string
    readonly cents: number
  } | null
  readonly accountHint: string | null
  /** Rows that had a transaction's identity but could not be read. */
  readonly rejectedRows: number
  /** The payment deadline a card bill prints. */
  readonly dueOn?: string
  /**
   * Whether the closing balance counts only the period's charges, while the
   * payments printed with them settled earlier bills. Otherwise payments made
   * within the period already reduced it.
   */
  readonly chargesOnly?: boolean
  /**
   * Whether the closing balance is an amount due printed as zero when credit
   * exceeds what is owed, so a zero does not say how much credit is left.
   */
  readonly floorsAtZero?: boolean
  /**
   * What a balance statement prints as paid in advance of its own charges,
   * when it prints it: payments made within the period that reduced the
   * amount due, not the credits it may count with them. The rest of the
   * payments it prints paid earlier bills.
   */
  readonly advanceCents?: number
}

export interface LayoutInput {
  /** The raw extracted text followed by the positioned lines. */
  readonly text: string
  readonly lines: ReadonlyArray<PositionedLine>
}

/** One bank's statement layout: recognized by its text, read from its lines. */
export interface PdfLayout {
  readonly id: string
  readonly kind: 'account' | 'card'
  readonly currency: string
  readonly matches: (text: string) => boolean
  readonly parse: (
    input: LayoutInput,
  ) => Result.Result<LayoutStatement, StatementProblem>
}

const normalizeWhitespace = (value: string) => value.replace(/\s+/g, ' ').trim()

const roundCoordinate = (value: number) => Math.round(value * 100) / 100

/**
 * Groups positioned fragments into visual lines: same page and a vertical
 * distance within about half the glyph height.
 */
export const groupLines = (
  items: ReadonlyArray<PositionedText>,
): ReadonlyArray<PositionedLine> => {
  const textItems = items
    .filter((item) => item.text.trim() && item.itemType === 'Text')
    .sort((left, right) =>
      left.page !== right.page
        ? left.page - right.page
        : Math.abs(left.y - right.y) > 2
          ? left.y - right.y
          : left.x - right.x,
    )
  const groups: Array<{
    page: number
    y: number
    items: Array<PositionedText>
  }> = []
  for (const item of textItems) {
    const tolerance = Math.max(2, Math.min(5, item.height * 0.45))
    const group = groups
      .slice(-12)
      .find(
        (candidate) =>
          candidate.page === item.page &&
          Math.abs(candidate.y - item.y) <= tolerance,
      )
    if (group) {
      group.items.push(item)
      group.y =
        group.items.reduce((sum, candidate) => sum + candidate.y, 0) /
        group.items.length
    } else {
      groups.push({ page: item.page, y: item.y, items: [item] })
    }
  }
  return groups
    .map((group): PositionedLine => {
      const ordered = group.items.sort((left, right) => left.x - right.x)
      const left = Math.min(...ordered.map((item) => item.x))
      const top = Math.min(...ordered.map((item) => item.y))
      const right = Math.max(...ordered.map((item) => item.x + item.width))
      const bottom = Math.max(...ordered.map((item) => item.y + item.height))
      return {
        text: normalizeWhitespace(ordered.map((item) => item.text).join(' ')),
        bounds: {
          page: group.page,
          x: roundCoordinate(left),
          y: roundCoordinate(top),
          width: roundCoordinate(right - left),
          height: roundCoordinate(bottom - top),
        },
      }
    })
    .filter((line) => line.text)
}

/** Top to bottom, page by page. */
export const readingOrder = (lines: ReadonlyArray<PositionedLine>) =>
  [...lines].sort(
    (left, right) =>
      left.bounds.page - right.bounds.page || right.bounds.y - left.bounds.y,
  )

/**
 * An amount with two decimals, whatever currency sign precedes it or not:
 * Brazilian `1.234,56` and dot-decimal `1,234.56`. Digits or a separator
 * followed by a digit on either side mean it is part of a longer number.
 */
export const amountToken =
  /(?<!\d[.,]?)(?:(?:\d{1,3}(?:\.\d{3})+|\d+),\d{2}|(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})(?![.,]?\d)/g

/** Whether a line prints an amount, with or without a sign or currency. */
export const printsAmount = (text: string) => text.search(amountToken) >= 0

/**
 * Whether a line of a card bill's transaction pages that is not a readable
 * row is a row that could not be read. Every line there printing an amount
 * is a row unless the layout knows it as a summary (totals, subtotals,
 * limits, exchange details), whatever cell it lost: its date, its currency
 * sign or its description. A line naming a payment is always a row, as no
 * bill total includes payments.
 */
export const isUnreadRow = (
  text: string,
  { summary, payment }: { readonly summary: RegExp; readonly payment: RegExp },
) => printsAmount(text) && (payment.test(text) || !summary.test(text))

const minus = '[-−–]'
const brazilianAmount = String.raw`(?:\d{1,3}(?:\.\d{3})+|\d+),\d{2}`

/**
 * The source of a signed Brazilian money token, to embed in a layout's row
 * pattern. The minus, a hyphen, `−` or `–`, may come before or after the
 * `R$` and be drawn apart from it: `- R$ 50,00`, `-R$50,00`, `R$ -50,00`,
 * `- 50,00`. Embedding it whole keeps a row's description from taking a sign
 * drawn as its own fragment. Parenthesised amounts are negative too.
 */
export const signedAmount = ({
  currency = 'optional',
}: { readonly currency?: 'optional' | 'required' } = {}) => {
  const number = String.raw`(?:${brazilianAmount}|\(${brazilianAmount}\))`
  const signed = String.raw`R\$\s*(?:${minus}\s*)?${number}|${minus}\s*R\$\s*${number}`
  return currency === 'required'
    ? `(?:${signed})`
    : String.raw`(?:${signed}|(?:${minus}\s*)?${number})`
}

/** Reads a money token such as `R$ -1.234,56` or `− R$ 5,00` in cents. */
export const cents = (token: string) =>
  parseMoney(token.replace(/[−–]/g, '-').replace(/\s+/g, ''))

/** Removes accents and uppercases, for matching month names. */
export const fold = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()

export const monthAbbreviations = [
  'JAN',
  'FEV',
  'MAR',
  'ABR',
  'MAI',
  'JUN',
  'JUL',
  'AGO',
  'SET',
  'OUT',
  'NOV',
  'DEZ',
] as const

export const monthNames = [
  'JANEIRO',
  'FEVEREIRO',
  'MARCO',
  'ABRIL',
  'MAIO',
  'JUNHO',
  'JULHO',
  'AGOSTO',
  'SETEMBRO',
  'OUTUBRO',
  'NOVEMBRO',
  'DEZEMBRO',
] as const

/** 1-based month of a Portuguese abbreviation or name, 0 when unknown. */
export const monthNumber = (value: string) => {
  const folded = fold(value)
  const index = (monthAbbreviations as ReadonlyArray<string>).indexOf(folded)
  return index >= 0
    ? index + 1
    : (monthNames as ReadonlyArray<string>).indexOf(folded) + 1
}

const pad = (value: number) => String(value).padStart(2, '0')

export const isoDate = (year: number, month: number, day: number) =>
  `${year}-${pad(month)}-${pad(day)}`

const daysInMonth = (year: number, month: number) => {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][
    month - 1
  ]!
}

/** `isoDate` for a day that exists in the calendar, else null. */
export const calendarDate = (year: number, month: number, day: number) =>
  month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month)
    ? isoDate(year, month, day)
    : null

const splitDate = (date: string) => {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number)
  return { year, month, day }
}

/** Shifts a calendar date by whole months, clamping to the month's last day. */
export const addMonths = (date: string, months: number) => {
  const { year, month, day } = splitDate(date)
  const index = year * 12 + (month - 1) + months
  const nextYear = Math.floor(index / 12)
  const nextMonth = (index % 12) + 1
  return isoDate(
    nextYear,
    nextMonth,
    Math.min(day, daysInMonth(nextYear, nextMonth)),
  )
}

export const nextDay = (date: string) => {
  const { year, month, day } = splitDate(date)
  if (day < daysInMonth(year, month)) return isoDate(year, month, day + 1)
  return month === 12 ? isoDate(year + 1, 1, 1) : isoDate(year, month + 1, 1)
}

/** The last four digits of an identifier, when it has that many. */
export const lastFour = (value: string | undefined) => {
  const digits = value?.replace(/\D/g, '') ?? ''
  return digits.length >= 4 ? digits.slice(-4) : null
}

/** The identifier printed most often, ties broken by value. */
export const mostFrequent = (matches: Iterable<RegExpMatchArray>) => {
  const counts = new Map<string, number>()
  for (const match of matches) {
    const value = match[1]
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [...counts.entries()].sort(
    ([leftValue, leftCount], [rightValue, rightCount]) =>
      rightCount - leftCount || leftValue.localeCompare(rightValue),
  )[0]?.[0]
}
