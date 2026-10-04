import {
  classifyPdfAsync,
  extractText,
  extractTextWithPositions,
} from '@firecrawl/pdf-inspector'
import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'

import { btgAccount } from './pdf/BtgAccount.ts'
import { interAccount } from './pdf/InterAccount.ts'
import { interCard } from './pdf/InterCard.ts'
import { interGlobal } from './pdf/InterGlobal.ts'
import {
  amountToken,
  fold,
  groupLines,
  monthAbbreviations,
  monthNames,
  monthNumber,
} from './pdf/Layout.ts'
import type { PdfLayout, PositionedLine, PositionedText } from './pdf/Layout.ts'
import { mercadoPagoAccount } from './pdf/MercadoPagoAccount.ts'
import { nubankAccount } from './pdf/NubankAccount.ts'
import { nubankCard } from './pdf/NubankCard.ts'
import { fingerprintIds, parseDate } from './Statement.ts'
import type { ParsedStatement, StatementProblem } from './Statement.ts'

export const pdfLayouts: ReadonlyArray<PdfLayout> = [
  btgAccount,
  interGlobal,
  interAccount,
  interCard,
  nubankCard,
  mercadoPagoAccount,
  nubankAccount,
]

export class PdfUnreadable extends Schema.TaggedError<PdfUnreadable>()(
  'PdfUnreadable',
  { cause: Schema.Defect() },
) {}

/** The text of a PDF as its extractor reads it. */
export interface PdfText {
  readonly text: string
  readonly items: ReadonlyArray<PositionedText>
  /** Pages whose text is an image or unreliable, needing OCR to be read. */
  readonly pagesNeedingOcr: ReadonlyArray<number>
}

export const looksLikePdf = (bytes: Uint8Array) =>
  bytes[0] === 0x25 &&
  bytes[1] === 0x50 &&
  bytes[2] === 0x44 &&
  bytes[3] === 0x46

/** Reads a PDF's plain text and its text fragments with their positions. */
export const extractPdfText = Effect.fn('Pdf.extractText')(function* (
  bytes: Uint8Array,
) {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const classification = yield* Effect.tryPromise({
    try: () => classifyPdfAsync(buffer),
    catch: (cause) => new PdfUnreadable({ cause }),
  })
  const { text, items } = yield* Effect.try({
    try: () => ({
      text: extractText(buffer),
      items: extractTextWithPositions(buffer),
    }),
    catch: (cause) => new PdfUnreadable({ cause }),
  })
  return {
    text,
    items,
    pagesNeedingOcr: classification.pagesNeedingOcr,
  } satisfies PdfText
})

const visibleLength = (value: string) => value.replace(/\s+/g, '').length

/** Month names and abbreviations, as layouts print them in dates. */
const monthPattern = [...monthNames, ...monthAbbreviations].join('|')

/**
 * A date as layouts print it: `01/08/2026`, `01/08/26`, `01-08-2026`,
 * `02 JUL`, `05 AGO 2026`, `20 de ago. 2026` or `1 de Junho de 2026`,
 * matched on text folded to unaccented capitals. Only day and month are
 * compared: the plain text can print a year in a cell of its own.
 */
const dateToken = new RegExp(
  `(?<![\\d.,/-])(\\d{1,2})(?:\\s+(?:DE\\s+)?(${monthPattern})\\b|([/-])(\\d{1,2})(?:\\3(?:\\d{4}|\\d{2}))?(?![\\d/]))`,
  'g',
)

/**
 * How many times each amount and each date is printed in the given text,
 * keyed by kind. Currency signs and the sign of an amount are dropped, and a
 * date is reduced to its day and month.
 */
const tokenCounts = (text: string) => {
  const counts = new Map<string, number>()
  const add = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1)
  for (const [token] of text.matchAll(amountToken))
    add(`amount:${token.replace(/[.,]/g, '')}`)
  for (const match of fold(text).matchAll(dateToken)) {
    const day = Number(match[1])
    const month = match[2] ? monthNumber(match[2]) : Number(match[4])
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12)
      add(`date:${day}-${month}`)
  }
  return counts
}

/**
 * Whether every amount and date the plain text prints was also seen by the
 * positioned extraction, as many times. Layouts read rows from positioned
 * lines and check them against the printed totals and balances, but those
 * controls cannot see every lost cell: rows outside them (bill payments, a
 * statement's first movement, a day of an account without a running
 * balance, movements that offset), and dates, which no total checks, so a
 * row or a day header that lost its date would be booked on another day.
 * Such losses can only be found by comparing the two extractions. Tokens
 * are compared rather than rows because the plain text splits table cells
 * over separate lines, even a currency sign from its amount, and counted
 * because two rows can print the same amount or date. Currency signs and
 * the sign of the amount are ignored: layouts print amounts bare, with `$`
 * or with `R$`, and a sign printed apart from its amount would otherwise
 * make the extractions disagree.
 */
const seesEveryToken = (text: string, lines: ReadonlyArray<PositionedLine>) => {
  const positioned = tokenCounts(lines.map((line) => line.text).join('\n'))
  return [...tokenCounts(text)].every(
    ([token, count]) => (positioned.get(token) ?? 0) >= count,
  )
}

/**
 * Reads a statement from a PDF's text with the single bank layout that
 * recognizes it. Text a layout cannot see — pages needing OCR, positioned
 * text much shorter than the plain text, or an amount or date the
 * positioned text lost — could hide lines or misdate them, so such a file
 * is refused rather than read partially.
 */
export const parsePdf = (
  pdf: PdfText,
  kind: 'account' | 'card',
): Result.Result<ParsedStatement, StatementProblem> => {
  const rawLength = visibleLength(pdf.text)
  const positionedLength = visibleLength(
    pdf.items.map((item) => item.text).join(''),
  )
  if (
    pdf.pagesNeedingOcr.length > 0 ||
    (rawLength > 200 && positionedLength / rawLength < 0.72)
  ) {
    return Result.fail('unsupported_format')
  }

  const lines = groupLines(pdf.items)
  if (!seesEveryToken(pdf.text, lines)) return Result.fail('unsupported_format')
  const text = `${pdf.text}\n${lines.map((line) => line.text).join('\n')}`
  const matching = pdfLayouts.filter((layout) => layout.matches(text))
  if (matching.length !== 1) return Result.fail('unsupported_format')
  const layout = matching[0]!
  if (layout.kind !== kind) return Result.fail('account_mismatch')

  const parsed = layout.parse({ text, lines })
  if (Result.isFailure(parsed)) return Result.fail(parsed.failure)
  const statement = parsed.success
  // Layouts build dates from printed day and month; one that does not exist
  // (31 SET, 32-08) means the text was misread, so the file is refused.
  const dates = [
    ...statement.lines.map((line) => line.bookedOn),
    ...(statement.period ? [statement.period.start, statement.period.end] : []),
    ...(statement.closingBalance ? [statement.closingBalance.asOf] : []),
    ...(statement.dueOn ? [statement.dueOn] : []),
  ]
  if (dates.some((date) => parseDate(date) !== date))
    return Result.fail('invalid_date')
  return Result.succeed({
    format: 'pdf',
    currency: layout.currency,
    accountKind: layout.kind,
    accountHint: statement.accountHint,
    period: statement.period,
    closingBalance: statement.closingBalance,
    ...(statement.dueOn ? { dueOn: statement.dueOn } : {}),
    ...(statement.chargesOnly ? { chargesOnly: true } : {}),
    ...(statement.floorsAtZero ? { floorsAtZero: true } : {}),
    lines: fingerprintIds(
      statement.lines.map(({ source, ...line }) => ({
        ...line,
        raw: {
          layout: layout.id,
          line: source.text,
          ...source.bounds,
        },
      })),
    ),
    rejectedRows: statement.rejectedRows,
  })
}
