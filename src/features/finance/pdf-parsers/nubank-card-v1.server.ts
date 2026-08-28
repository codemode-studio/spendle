import { toMinorUnits } from '#/domain/currency'

import type {
  PdfParserTransaction,
  PdfPositionedLine,
  PdfStatementParser,
  PdfStatementParserResult,
} from './types'

const monthByAbbreviation: Record<string, number> = {
  JAN: 1,
  FEV: 2,
  MAR: 3,
  ABR: 4,
  MAI: 5,
  JUN: 6,
  JUL: 7,
  AGO: 8,
  SET: 9,
  OUT: 10,
  NOV: 11,
  DEZ: 12,
}

function parseMoney(value: string, currency: string) {
  try {
    return toMinorUnits(value.replace(/\s+/g, ''), currency)
  } catch {
    return null
  }
}

function isoDate(year: number, month: number, day: number) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function parseNubankCardStatement(input: {
  lines: PdfPositionedLine[]
  currency: string
}): PdfStatementParserResult {
  const dueLine = input.lines.find((line) =>
    /data de vencimento\s*:/i.test(line.text),
  )
  const dueMatch = dueLine?.text.match(
    /data de vencimento\s*:\s*(\d{2})\s+(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)\s+(\d{4})/i,
  )
  const periodLine = input.lines.find((line) =>
    /per[ií]odo vigente\s*:/i.test(line.text),
  )
  const periodMatch = periodLine?.text.match(
    /per[ií]odo vigente\s*:\s*(\d{2})\s+(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)\s+a\s+(\d{2})\s+(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)/i,
  )
  if (!dueMatch || !periodMatch) {
    throw new Error(
      'Não foi possível identificar o vencimento e o período da fatura Nubank.',
    )
  }

  const dueYear = Number(dueMatch[3])
  const dueMonth = monthByAbbreviation[dueMatch[2].toUpperCase()]
  const endMonth = monthByAbbreviation[periodMatch[4].toUpperCase()]
  const startMonth = monthByAbbreviation[periodMatch[2].toUpperCase()]
  const periodEndYear = endMonth > dueMonth ? dueYear - 1 : dueYear
  const periodStartYear =
    startMonth > endMonth ? periodEndYear - 1 : periodEndYear
  const periodStart = isoDate(
    periodStartYear,
    startMonth,
    Number(periodMatch[1]),
  )
  const periodEnd = isoDate(periodEndYear, endMonth, Number(periodMatch[3]))
  const dueDate = isoDate(dueYear, dueMonth, Number(dueMatch[1]))

  const totalLine = input.lines.find((line) =>
    /^total a pagar\s+R\$\s*(?:\d{1,3}(?:\.\d{3})*|\d+),\d{2}$/i.test(
      line.text,
    ),
  )
  const totalToken = totalLine?.text.match(
    /R\$\s*((?:\d{1,3}(?:\.\d{3})*|\d+),\d{2})$/,
  )?.[1]
  const closingBalanceCents = totalToken
    ? parseMoney(totalToken, input.currency)
    : null
  if (closingBalanceCents === null) {
    throw new Error('Não foi possível interpretar o total da fatura Nubank.')
  }

  const transactionPages = new Set(
    input.lines
      .filter((line) => /^transa[cç][oõ]es\b/i.test(line.text))
      .map((line) => line.bounds.page),
  )
  const rowPattern =
    /^(\d{2})\s+(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)\s+(?:(?:[•*]{4})\s*(\d{4})\s+)?(.+?)\s+([−-]?\s*R\$)\s*((?:\d{1,3}(?:\.\d{3})*|\d+),\d{2})$/i
  const transactions: PdfParserTransaction[] = []

  const orderedLines = [...input.lines].sort((left, right) =>
    left.bounds.page !== right.bounds.page
      ? left.bounds.page - right.bounds.page
      : right.bounds.y - left.bounds.y,
  )
  for (const line of orderedLines) {
    if (!transactionPages.has(line.bounds.page)) continue
    const match = line.text.match(rowPattern)
    if (!match) continue
    const [, day, rawMonth, , rawDescription, amountMarker, rawAmount] = match
    const description = rawDescription.replace(/\s+/g, ' ').trim()
    if (/^pagamento\s+em\b/i.test(description)) continue
    const parsedAmount = parseMoney(rawAmount, input.currency)
    if (parsedAmount === null) {
      throw new Error(`Valor inválido na fatura Nubank: ${line.text}`)
    }
    const month = monthByAbbreviation[rawMonth.toUpperCase()]
    const transactionYear =
      periodStartYear !== periodEndYear && month >= startMonth
        ? periodStartYear
        : periodEndYear
    const postedAt = isoDate(transactionYear, month, Number(day))
    if (postedAt < periodStart || postedAt > periodEnd) {
      throw new Error(`Data fora do período na fatura Nubank: ${line.text}`)
    }
    transactions.push({
      postedAt,
      description,
      amountCents: /^[−-]/.test(amountMarker)
        ? Math.abs(parsedAmount)
        : -Math.abs(parsedAmount),
      currency: input.currency,
      raw: { line: line.text, bounds: line.bounds },
    })
  }

  const calculatedTotal = -transactions.reduce(
    (sum, transaction) => sum + transaction.amountCents,
    0,
  )
  if (!transactions.length || calculatedTotal !== closingBalanceCents) {
    throw new Error(
      `As compras da fatura Nubank não fecham: esperado ${closingBalanceCents}, extraído ${calculatedTotal}.`,
    )
  }

  return {
    transactions,
    sourceTransactionCount: transactions.length,
    controls: {
      openingBalanceCents: null,
      openingBalanceAt: null,
      closingBalanceCents,
      closingBalanceType: 'card_statement',
      balanceAsOf: periodEnd,
      periodStart,
      periodEnd,
      dueDate,
    },
  }
}

export const nubankCardV1Parser: PdfStatementParser = {
  id: 'nubank/card-statement/v1',
  version: '1',
  institution: 'Nubank',
  kind: 'card_statement',
  matches(input) {
    return (
      /nu pagamentos s\.?a\.?/i.test(input.text) &&
      /resumo da fatura atual/i.test(input.text) &&
      /per[ií]odo vigente/i.test(input.text) &&
      /total de compras de todos os cart[oõ]es/i.test(input.text) &&
      /transa[cç][oõ]es/i.test(input.text)
    )
  },
  parse: parseNubankCardStatement,
}

export function parseNubankCardTransactions(input: {
  lines: PdfPositionedLine[]
  currency: string
}) {
  return parseNubankCardStatement(input)
}
