import { toMinorUnits } from '#/domain/currency'

import type {
  PdfParserTransaction,
  PdfPositionedLine,
  PdfStatementParser,
  PdfStatementParserResult,
} from './types'

const monthByAbbreviation: Record<string, string> = {
  jan: '01',
  fev: '02',
  mar: '03',
  abr: '04',
  mai: '05',
  jun: '06',
  jul: '07',
  ago: '08',
  set: '09',
  out: '10',
  nov: '11',
  dez: '12',
}

function parseMoney(value: string, currency: string) {
  try {
    return toMinorUnits(value.replace(/\s+/g, ''), currency)
  } catch {
    return null
  }
}

function parseBrazilianDate(value: string) {
  const match = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
  return match ? `${match[3]}-${match[2]}-${match[1]}` : null
}

function shiftMonth(date: string, months: number) {
  const value = new Date(`${date}T12:00:00Z`)
  const day = value.getUTCDate()
  value.setUTCDate(1)
  value.setUTCMonth(value.getUTCMonth() + months)
  const lastDay = new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0, 12),
  ).getUTCDate()
  value.setUTCDate(Math.min(day, lastDay))
  return value.toISOString().slice(0, 10)
}

function nextDay(date: string) {
  const value = new Date(`${date}T12:00:00Z`)
  value.setUTCDate(value.getUTCDate() + 1)
  return value.toISOString().slice(0, 10)
}

function extractDateFromLine(line: PdfPositionedLine | undefined) {
  const value = line?.text.match(/\b\d{2}\/\d{2}\/\d{4}\b/)?.[0]
  return value ? parseBrazilianDate(value) : null
}

function findRequiredControlLine(lines: PdfPositionedLine[], pattern: RegExp) {
  const line = lines.find((candidate) => pattern.test(candidate.text))
  if (!line) throw new Error('O resumo da fatura Inter está incompleto.')
  return line
}

function parseInterCardStatement(input: {
  lines: PdfPositionedLine[]
  currency: string
}): PdfStatementParserResult {
  const dueDate = extractDateFromLine(
    input.lines.find(
      (line) =>
        line.bounds.page === 1 &&
        /\b\d{2}\/\d{2}\/\d{4}\b/.test(line.text) &&
        /vencimento|valor que voc[eê] precisa pagar/i.test(line.text),
    ),
  )
  const nextCutDate = extractDateFromLine(
    input.lines.find((line) => /data de corte\s*:/i.test(line.text)),
  )
  if (!dueDate || !nextCutDate) {
    throw new Error(
      'Não foi possível identificar o vencimento e o ciclo da fatura Inter.',
    )
  }
  const periodEnd = shiftMonth(nextCutDate, -1)
  const periodStart = nextDay(shiftMonth(periodEnd, -1))
  const totalLine = findRequiredControlLine(input.lines, /^fatura atual\s+R\$/i)
  const totalToken = totalLine.text.match(
    /R\$\s*((?:\d{1,3}(?:\.\d{3})*|\d+),\d{2})\s*$/,
  )?.[1]
  const closingBalanceCents = totalToken
    ? parseMoney(totalToken, input.currency)
    : null
  if (closingBalanceCents === null) {
    throw new Error('Não foi possível interpretar o total da fatura Inter.')
  }

  const transactionPages = new Set(
    input.lines
      .filter((line) => /^despesas da fatura$/i.test(line.text))
      .map((line) => line.bounds.page),
  )
  const transactions: PdfParserTransaction[] = []
  const rowPattern =
    /^(\d{2}) de (jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)\. (\d{4}) (.+?) - (\+\s+)?R\$\s*((?:\d{1,3}(?:\.\d{3})*|\d+),\d{2})$/i

  const orderedLines = [...input.lines].sort((left, right) =>
    left.bounds.page !== right.bounds.page
      ? left.bounds.page - right.bounds.page
      : right.bounds.y - left.bounds.y,
  )
  for (const line of orderedLines) {
    if (!transactionPages.has(line.bounds.page)) continue
    const match = line.text.match(rowPattern)
    if (!match) continue
    const [, day, rawMonth, year, rawDescription, creditMarker, rawAmount] =
      match
    const description = rawDescription.replace(/\s+/g, ' ').trim()
    if (/^pagamento(?:\s+on\s*line|\s+de\s+fatura)$/i.test(description)) {
      continue
    }
    const parsedAmount = parseMoney(rawAmount, input.currency)
    if (parsedAmount === null) {
      throw new Error(`Valor inválido na fatura Inter: ${line.text}`)
    }
    const originalDate = `${year}-${monthByAbbreviation[rawMonth.toLowerCase()]}-${day}`
    const installment = description.match(/\bparcela\s+(\d+)\s+de\s+\d+\b/i)
    const installmentDate = installment
      ? shiftMonth(originalDate, Number(installment[1]) - 1)
      : originalDate
    if (installmentDate < periodStart || installmentDate > periodEnd) {
      throw new Error(`Parcela fora do ciclo da fatura Inter: ${line.text}`)
    }
    transactions.push({
      postedAt: installmentDate,
      description,
      amountCents: creditMarker
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
      `As compras da fatura Inter não fecham: esperado ${closingBalanceCents}, extraído ${calculatedTotal}.`,
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

export const interCardV1Parser: PdfStatementParser = {
  id: 'inter/card-statement/v1',
  version: '1',
  institution: 'Inter',
  kind: 'card_statement',
  matches(input) {
    return (
      /(?:banco inter s\/?a|inter\.co\/)/i.test(input.text) &&
      /resumo da fatura/i.test(input.text) &&
      /despesas da fatura/i.test(input.text) &&
      /cart[aã]o\s+\d{4}\*{4}\d{4}/i.test(input.text) &&
      /fatura atual/i.test(input.text)
    )
  },
  parse: parseInterCardStatement,
}

export function parseInterCardTransactions(input: {
  lines: PdfPositionedLine[]
  currency: string
}) {
  return parseInterCardStatement(input)
}
