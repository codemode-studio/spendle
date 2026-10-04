import * as Result from 'effect/Result'

import { parseDate } from '../Statement.ts'
import type { StatementProblem } from '../Statement.ts'
import {
  addMonths,
  calendarDate,
  cents,
  mostFrequent,
  monthNumber,
  nextDay,
  readingOrder,
} from './Layout.ts'
import type {
  LayoutInput,
  LayoutLine,
  LayoutStatement,
  PdfLayout,
  PositionedLine,
} from './Layout.ts'

const dateIn = (line: PositionedLine | undefined) => {
  const value = line?.text.match(/\b\d{2}\/\d{2}\/\d{4}\b/)?.[0]
  return value ? parseDate(value) : null
}

const trailingMoney = (line: PositionedLine | undefined) => {
  const token = line?.text.match(
    /R\$\s*((?:\d{1,3}(?:\.\d{3})*|\d+),\d{2})\s*$/,
  )?.[1]
  return token ? cents(token) : null
}

// Some Inter PDFs encode the visual separator as the font glyph U+E054.
const rowPattern =
  /^(\d{2}) de (jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)\. (\d{4}) (.+?) [-] (\+\s+)?R\$\s*((?:\d{1,3}(?:\.\d{3})*|\d+),\d{2})$/i

// A row that lost a cell still prints its amount, and starts with a date or
// names a payment. Purchases must add up to the month's expenses, but a
// payment is outside them and would vanish unnoticed.
const rowCandidate =
  /^\d{2} de (?:jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)\.|\bpagamento\s+(?:on\s*line|de\s+fatura)\b/i

/**
 * Reads an Inter card bill. The cycle ends a month before the next cut date
 * printed at the end. Rows show the purchase date, so an installment is
 * booked in the month it is billed. Bill payments are recorded as money
 * arriving on the card on the day they were made, so they pair with the bank
 * debit; they stay out of the bill's totals, so `parsePdf` refuses a file
 * whose positioned text lost an amount, such as a payment, and a payment row
 * that kept its amount but cannot be read is rejected.
 */
export const parseInterCard = ({
  lines,
}: LayoutInput): Result.Result<LayoutStatement, StatementProblem> => {
  const dueDate = dateIn(
    lines.find(
      (line) =>
        line.bounds.page === 1 &&
        /\b\d{2}\/\d{2}\/\d{4}\b/.test(line.text) &&
        /vencimento|valor que voc[eê] precisa pagar/i.test(line.text),
    ),
  )
  const nextCut = dateIn(
    lines.find((line) => /data de corte\s*:/i.test(line.text)),
  )
  if (!dueDate || !nextCut) return Result.fail('no_statement')
  const periodEnd = addMonths(nextCut, -1)
  const periodStart = nextDay(addMonths(periodEnd, -1))

  const statementTotal = trailingMoney(
    lines.find((line) => /^fatura atual\s+R\$/i.test(line.text)),
  )
  if (statementTotal === null) return Result.fail('no_statement')
  // "Fatura atual" is net of payments anticipated inside the cycle. When the
  // holder pays before the cut, the amount due drops (possibly to zero) while
  // the purchases still add up to "Despesas do mês".
  const monthlyExpenses = trailingMoney(
    lines.find((line) => /^despesas do m[eê]s\s+R\$/i.test(line.text)),
  )
  const anticipated = trailingMoney(
    lines.find((line) => /^valor antecipado\s+R\$/i.test(line.text)),
  )

  const transactionPages = new Set(
    lines
      .filter((line) => /^despesas da fatura$/i.test(line.text))
      .map((line) => line.bounds.page),
  )
  const rows: Array<LayoutLine> = []
  const payments = new Set<LayoutLine>()
  let rejectedRows = 0
  for (const line of readingOrder(lines)) {
    if (!transactionPages.has(line.bounds.page)) continue
    const match = line.text.match(rowPattern)
    if (!match) {
      if (trailingMoney(line) !== null && rowCandidate.test(line.text))
        rejectedRows++
      continue
    }
    const [, day, rawMonth, year, rawDescription, creditMarker, rawAmount] =
      match
    const description = rawDescription!.replace(/\s+/g, ' ').trim()
    const amount = cents(rawAmount!)
    if (amount === null) return Result.fail('summary_balance_mismatch')
    // Checked before any month arithmetic, which would hide an impossible day.
    const purchasedOn = calendarDate(
      Number(year),
      monthNumber(rawMonth!),
      Number(day),
    )
    if (purchasedOn === null) return Result.fail('invalid_date')
    if (/^pagamento(?:\s+on\s*line|\s+de\s+fatura)$/i.test(description)) {
      // A payment printed on the bill was made during its cycle; one dated
      // outside it was misread.
      if (purchasedOn < periodStart || purchasedOn > periodEnd)
        return Result.fail('summary_balance_mismatch')
      const row = {
        bookedOn: purchasedOn,
        description,
        amountCents: Math.abs(amount),
        source: line,
      }
      rows.push(row)
      payments.add(row)
      continue
    }
    const installment = description.match(/\bparcela\s+(\d+)\s+de\s+\d+\b/i)
    const billedOn = installment
      ? addMonths(purchasedOn, Number(installment[1]) - 1)
      : purchasedOn
    if (billedOn > periodEnd) return Result.fail('summary_balance_mismatch')
    rows.push({
      // A purchase authorised before the cut can be captured and billed in
      // the following cycle. The bill decides which cycle it belongs to, so
      // it is booked on the cycle's first day.
      bookedOn: billedOn < periodStart ? periodStart : billedOn,
      description,
      amountCents: creditMarker ? Math.abs(amount) : -Math.abs(amount),
      source: line,
    })
  }

  const billed = rows.filter((row) => !payments.has(row))
  const charged = -billed.reduce((sum, row) => sum + row.amountCents, 0)
  // Inter can report gross purchases under "Despesas do mês" and include
  // both statement credits and payments in "Valor antecipado". Check the
  // gross purchases and the summary equation independently; each credit
  // stays a positive line and the remaining payment is never invented.
  const credits = billed.reduce(
    (sum, row) => sum + Math.max(row.amountCents, 0),
    0,
  )
  // The amount due is checked by the shared summary equation below.
  const reconciledGross =
    monthlyExpenses !== null &&
    anticipated !== null &&
    credits > 0 &&
    anticipated >= credits &&
    charged + credits === monthlyExpenses
  // Purchases must add up to the month's expenses when the bill prints them.
  // The amount due is only a valid target when nothing was paid early:
  // otherwise a missing purchase could equal what is still due.
  const balanced =
    monthlyExpenses !== null
      ? charged === monthlyExpenses || reconciledGross
      : (anticipated ?? 0) === 0 && charged === statementTotal
  // The summary must close on its own: what is due is the month's expenses
  // less what was paid early, or zero when the early payment covered more.
  const summaryCloses =
    monthlyExpenses === null ||
    statementTotal + (anticipated ?? 0) === monthlyExpenses ||
    (statementTotal === 0 && (anticipated ?? 0) >= monthlyExpenses)
  if (billed.length === 0 || !balanced || !summaryCloses) {
    return Result.fail('summary_balance_mismatch')
  }

  return Result.succeed({
    lines: rows,
    period: { start: periodStart, end: periodEnd },
    // What is owed at the cut: "Fatura atual", net of payments made before
    // it, which are recorded as lines. Money owed on a card is negative in
    // the ledger.
    closingBalance: { asOf: periodEnd, cents: 0 - statementTotal },
    accountHint:
      mostFrequent(
        lines.flatMap((line) => [
          ...line.text.matchAll(/\b\d{4}\*{4}(\d{4})\b/g),
        ]),
      ) ?? null,
    rejectedRows,
  })
}

export const interCard: PdfLayout = {
  id: 'inter/card-statement/v1',
  kind: 'card',
  currency: 'BRL',
  matches: (text) =>
    /(?:banco inter s\/?a|inter\.co\/)/i.test(text) &&
    /resumo da fatura/i.test(text) &&
    /despesas da fatura/i.test(text) &&
    /cart[aã]o\s+\d{4}\*{4}\d{4}/i.test(text) &&
    /fatura atual/i.test(text),
  parse: parseInterCard,
}
