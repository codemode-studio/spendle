import * as Result from 'effect/Result'

import type { StatementProblem } from '../Statement.ts'
import {
  calendarDate,
  cents,
  mostFrequent,
  monthNumber,
  readingOrder,
} from './Layout.ts'
import type {
  LayoutInput,
  LayoutLine,
  LayoutStatement,
  PdfLayout,
} from './Layout.ts'

const months = 'JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ'

/**
 * Reads a Nubank card bill. Rows print day and month only; the year comes
 * from the due date and the cycle, which can span a new year. Payments of
 * earlier bills are recorded as money arriving on the card, so the card
 * ledger and the bank debit can be paired; they are not part of the bill, so
 * only purchases and credits must add up to `Total a pagar`.
 */
export const parseNubankCard = ({
  text,
  lines,
}: LayoutInput): Result.Result<LayoutStatement, StatementProblem> => {
  const due = lines
    .find((line) => /data de vencimento\s*:/i.test(line.text))
    ?.text.match(
      new RegExp(
        `data de vencimento\\s*:\\s*(\\d{2})\\s+(${months})\\s+(\\d{4})`,
        'i',
      ),
    )
  const cycle = lines
    .find((line) => /per[ií]odo vigente\s*:/i.test(line.text))
    ?.text.match(
      new RegExp(
        `per[ií]odo vigente\\s*:\\s*(\\d{2})\\s+(${months})\\s+a\\s+(\\d{2})\\s+(${months})`,
        'i',
      ),
    )
  if (!due || !cycle) return Result.fail('no_statement')

  const dueYear = Number(due[3])
  const dueMonth = monthNumber(due[2]!)
  const startMonth = monthNumber(cycle[2]!)
  const endMonth = monthNumber(cycle[4]!)
  const endYear = endMonth > dueMonth ? dueYear - 1 : dueYear
  const startYear = startMonth > endMonth ? endYear - 1 : endYear
  const periodStart = calendarDate(startYear, startMonth, Number(cycle[1]))
  const periodEnd = calendarDate(endYear, endMonth, Number(cycle[3]))
  if (
    calendarDate(dueYear, dueMonth, Number(due[1])) === null ||
    periodStart === null ||
    periodEnd === null
  )
    return Result.fail('invalid_date')

  const total = lines
    .find((line) =>
      /^total a pagar\s+R\$\s*(?:\d{1,3}(?:\.\d{3})*|\d+),\d{2}$/i.test(
        line.text,
      ),
    )
    ?.text.match(/R\$\s*((?:\d{1,3}(?:\.\d{3})*|\d+),\d{2})$/)?.[1]
  const totalCents = total ? cents(total) : null
  if (totalCents === null) return Result.fail('no_statement')

  const transactionPages = new Set(
    lines
      .filter((line) => /^transa[cç][oõ]es\b/i.test(line.text))
      .map((line) => line.bounds.page),
  )
  const rowPattern = new RegExp(
    `^(\\d{2})\\s+(${months})\\s+(?:(?:[•*]{4})\\s*(\\d{4})\\s+)?(.+?)\\s+([−-]?\\s*R\\$)\\s*((?:\\d{1,3}(?:\\.\\d{3})*|\\d+),\\d{2})$`,
    'i',
  )
  const rows: Array<LayoutLine> = []
  const payments = new Set<LayoutLine>()
  for (const line of readingOrder(lines)) {
    if (!transactionPages.has(line.bounds.page)) continue
    const match = line.text.match(rowPattern)
    if (!match) continue
    const [, day, rawMonth, , rawDescription, marker, rawAmount] = match
    const description = rawDescription!.replace(/\s+/g, ' ').trim()
    const payment = /^pagamento\s+em\b/i.test(description)
    const amount = cents(rawAmount!)
    if (amount === null) return Result.fail('summary_balance_mismatch')
    const month = monthNumber(rawMonth!)
    const year =
      startYear !== endYear && month >= startMonth ? startYear : endYear
    const bookedOn = calendarDate(year, month, Number(day))
    if (bookedOn === null) return Result.fail('invalid_date')
    // Payments made during the cycle are printed in it too; one dated
    // outside it was misread, or its year guessed wrong.
    if (bookedOn < periodStart || bookedOn > periodEnd)
      return Result.fail('summary_balance_mismatch')
    if (payment) {
      const row = {
        bookedOn,
        description,
        amountCents: Math.abs(amount),
        source: line,
      }
      rows.push(row)
      payments.add(row)
      continue
    }
    rows.push({
      bookedOn,
      description,
      // A purchase is printed positive; a refund or credit with a minus.
      amountCents: /^[−-]/.test(marker!) ? Math.abs(amount) : -Math.abs(amount),
      source: line,
    })
  }

  const billed = rows.filter((row) => !payments.has(row))
  const charged = -billed.reduce((sum, row) => sum + row.amountCents, 0)
  // Payments are outside the bill's total, so a payment lost in positioning
  // would go unnoticed: every row the plain text shows, by its date and
  // amount, must have been read from the layout.
  const signature = (line: string) => {
    const match = line.replace(/\s+/g, ' ').trim().match(rowPattern)
    return match ? `${match[1]} ${match[2]!.toUpperCase()} ${match[6]}` : null
  }
  const read = new Set(rows.map((row) => signature(row.source.text)))
  const lost = text
    .split('\n')
    .map(signature)
    .some((key) => key !== null && !read.has(key))
  if (billed.length === 0 || charged !== totalCents || lost)
    return Result.fail('summary_balance_mismatch')

  return Result.succeed({
    lines: rows,
    period: { start: periodStart, end: periodEnd },
    // The bill's total is what the holder owes at the cycle's close. The
    // ledger records money owed on a card as a negative balance.
    closingBalance: { asOf: periodEnd, cents: -totalCents },
    accountHint:
      mostFrequent(
        lines.flatMap((line) => [
          ...line.text.matchAll(/[•*]{4}\s*(\d{4})\b/g),
        ]),
      ) ?? null,
    rejectedRows: 0,
  })
}

export const nubankCard: PdfLayout = {
  id: 'nubank/card-statement/v1',
  kind: 'card',
  currency: 'BRL',
  matches: (text) =>
    /nu pagamentos s\.?a\.?/i.test(text) &&
    /resumo da fatura atual/i.test(text) &&
    /per[ií]odo vigente/i.test(text) &&
    /total de compras de todos os cart[oõ]es/i.test(text) &&
    /transa[cç][oõ]es/i.test(text),
  parse: parseNubankCard,
}
