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
import { groupLines } from './pdf/Layout.ts'
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

const moneyToken = /R\$\s*[-−]?\s*((?:\d{1,3}(?:\.\d{3})*|\d+),\d{2})/g

/** How many times each money amount is printed in the given lines. */
const amountCounts = (lines: ReadonlyArray<string>) => {
  const counts = new Map<string, number>()
  for (const line of lines)
    for (const match of line.matchAll(moneyToken)) {
      const amount = match[1]!.replace(/\./g, '')
      counts.set(amount, (counts.get(amount) ?? 0) + 1)
    }
  return counts
}

/**
 * Whether every money amount the plain text prints was also seen by the
 * positioned extraction, as many times. Layouts read rows from positioned
 * lines and check purchases against the printed totals, but rows outside
 * those totals (bill payments, a statement's first movement) can only be
 * found missing by comparing the two extractions. Amounts are compared rather than
 * rows because the plain text splits table cells over separate lines, and
 * counted because two rows can print the same amount. The sign is ignored:
 * the count alone tells a lost row, and a sign printed apart from its amount
 * would otherwise make the two extractions disagree. Consecutive repeated
 * plain lines, such as text drawn twice to look bold, count once.
 */
const seesEveryAmount = (
  text: string,
  lines: ReadonlyArray<PositionedLine>,
) => {
  const plain = text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '')
  const positioned = amountCounts(lines.map((line) => line.text))
  return [...amountCounts(plain)].every(
    ([amount, count]) => (positioned.get(amount) ?? 0) >= count,
  )
}

/**
 * Reads a statement from a PDF's text with the single bank layout that
 * recognizes it. Text a layout cannot see — pages needing OCR, positioned
 * text much shorter than the plain text, or an amount the positioned text
 * lost — could hide lines, so such a file is refused rather than read
 * partially.
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
  if (!seesEveryAmount(pdf.text, lines))
    return Result.fail('unsupported_format')
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
