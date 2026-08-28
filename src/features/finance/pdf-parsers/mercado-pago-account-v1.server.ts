import { toMinorUnits } from '#/domain/currency'

import type {
  PdfParserTransaction,
  PdfPositionedLine,
  PdfStatementParser,
} from './types'

const transactionDatePattern = /\b(\d{2})-(\d{2})-(\d{2,4})\b/
const operationIdPattern = /\b(\d{8,})\b/

function normalizeText(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

function normalizeForMatching(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
}

function moneyMatches(value: string) {
  return [
    ...value.matchAll(/R\$\s*[-−]?\(?(?:\d{1,3}(?:\.\d{3})*|\d+),\d{2}\)?/gi),
  ]
}

function parseMoney(value: string, currency: string) {
  try {
    return toMinorUnits(value.replace('−', '-'), currency)
  } catch {
    return null
  }
}

function toIsoDate(match: RegExpMatchArray) {
  const year = match[3].length === 2 ? `20${match[3]}` : match[3]
  return `${year}-${match[2]}-${match[1]}`
}

function extractPeriod(text: string) {
  const match = text.match(
    /per[ií]odo\s*:?\s*(?:de\s*)?(\d{2}-\d{2}-\d{2,4})\s*(?:a(?:l)?|at[eé])\s*(\d{2}-\d{2}-\d{2,4})/i,
  )
  const parseDate = (value: string | undefined) => {
    const dateMatch = value?.match(transactionDatePattern)
    return dateMatch ? toIsoDate(dateMatch) : null
  }
  return {
    periodStart: parseDate(match?.[1]),
    periodEnd: parseDate(match?.[2]),
  }
}

function extractLabeledAmount(text: string, label: RegExp, currency: string) {
  const labelMatch = label.exec(text)
  if (!labelMatch?.[0]) return null
  const amount = moneyMatches(
    text.slice(labelMatch.index + labelMatch[0].length),
  ).at(0)?.[0]
  return amount ? parseMoney(amount, currency) : null
}

function hasTransactionIdentity(line: PdfPositionedLine) {
  const dateMatch = line.text.match(transactionDatePattern)
  if (!dateMatch?.[0] || dateMatch.index === undefined) return false
  return operationIdPattern.test(
    line.text.slice(dateMatch.index + dateMatch[0].length),
  )
}

function candidateTransactionLines(lines: PdfPositionedLine[]) {
  return lines.filter(hasTransactionIdentity)
}

function parseTransactions(lines: PdfPositionedLine[], currency: string) {
  const candidates = candidateTransactionLines(lines)
  const rowsByPage = new Map<number, PdfPositionedLine[]>()

  for (const line of candidates) {
    const pageRows = rowsByPage.get(line.bounds.page) ?? []
    pageRows.push(line)
    rowsByPage.set(line.bounds.page, pageRows)
  }
  for (const pageRows of rowsByPage.values()) {
    pageRows.sort((left, right) => left.bounds.y - right.bounds.y)
  }

  const orderedCandidates = [...candidates].sort((left, right) =>
    left.bounds.page !== right.bounds.page
      ? left.bounds.page - right.bounds.page
      : right.bounds.y - left.bounds.y,
  )
  const transactions: PdfParserTransaction[] = []

  for (const line of orderedCandidates) {
    const dateMatch = line.text.match(transactionDatePattern)
    if (!dateMatch?.[0] || dateMatch.index === undefined) continue

    const amounts = moneyMatches(line.text)
    if (amounts.length < 2) continue
    const transactionAmount = amounts.at(-2)!

    const prefix = normalizeText(
      line.text.slice(
        dateMatch.index + dateMatch[0].length,
        transactionAmount.index,
      ),
    )
    const operationIdMatch = prefix.match(/\b(\d{8,})\s*$/)
    if (!operationIdMatch?.[1] || operationIdMatch.index === undefined) continue

    const amountCents = parseMoney(transactionAmount[0], currency)
    if (amountCents === null) continue

    const lineDescription = prefix
      .slice(0, operationIdMatch.index)
      .replace(/^[|:;–—-]+|[|:;–—-]+$/g, '')
      .trim()
    const pageRows = rowsByPage.get(line.bounds.page) ?? []
    const rowIndex = pageRows.indexOf(line)
    const lowerBound = Math.max(
      line.bounds.y - 32,
      rowIndex > 0
        ? (pageRows[rowIndex - 1].bounds.y + line.bounds.y) / 2
        : Number.NEGATIVE_INFINITY,
    )
    const upperBound = Math.min(
      line.bounds.y + 32,
      rowIndex < pageRows.length - 1
        ? (line.bounds.y + pageRows[rowIndex + 1].bounds.y) / 2
        : Number.POSITIVE_INFINITY,
    )
    const continuationLines = lines.filter(
      (candidate) =>
        candidate !== line &&
        candidate.bounds.page === line.bounds.page &&
        candidate.bounds.y > lowerBound &&
        candidate.bounds.y < upperBound &&
        candidate.bounds.x >= line.bounds.x + line.bounds.width * 0.08 &&
        candidate.bounds.x < line.bounds.x + line.bounds.width * 0.7 &&
        !transactionDatePattern.test(candidate.text) &&
        moneyMatches(candidate.text).length === 0 &&
        !/\b(?:data|descri[cç][aã]o|id da opera[cç][aã]o|valor|saldo)\b/i.test(
          candidate.text,
        ),
    )
    const description = [
      ...continuationLines.map((candidate) => ({
        text: candidate.text,
        y: candidate.bounds.y,
      })),
      { text: lineDescription, y: line.bounds.y },
    ]
      .filter((candidate) => candidate.text)
      .sort((left, right) => right.y - left.y)
      .map((candidate) => candidate.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!description) continue

    transactions.push({
      externalId: operationIdMatch[1],
      postedAt: toIsoDate(dateMatch),
      description,
      amountCents,
      currency,
      raw: { line: line.text, bounds: line.bounds },
    })
  }

  return {
    transactions,
    sourceTransactionCount: candidates.length,
  }
}

function validateDeclaredTotals(
  text: string,
  transactions: PdfParserTransaction[],
  currency: string,
) {
  const declaredCredits = extractLabeledAmount(text, /entradas\s*:/i, currency)
  const declaredDebits = extractLabeledAmount(text, /sa[ií]das\s*:/i, currency)
  const parsedCredits = transactions.reduce(
    (total, transaction) =>
      transaction.amountCents > 0 ? total + transaction.amountCents : total,
    0,
  )
  const parsedDebits = transactions.reduce(
    (total, transaction) =>
      transaction.amountCents < 0
        ? total + Math.abs(transaction.amountCents)
        : total,
    0,
  )

  if (declaredCredits !== null && Math.abs(declaredCredits) !== parsedCredits) {
    throw new Error(
      `O total de entradas do Mercado Pago não fecha: esperado ${Math.abs(declaredCredits)}, extraído ${parsedCredits}.`,
    )
  }
  if (declaredDebits !== null && Math.abs(declaredDebits) !== parsedDebits) {
    throw new Error(
      `O total de saídas do Mercado Pago não fecha: esperado ${Math.abs(declaredDebits)}, extraído ${parsedDebits}.`,
    )
  }
}

export const mercadoPagoAccountV1Parser: PdfStatementParser = {
  id: 'mercado-pago/account-statement/v1',
  version: '1',
  institution: 'Mercado Pago',
  kind: 'bank_statement',
  matches(input) {
    const text = normalizeForMatching(input.text)
    const issuerSignature =
      /mercado pago instituicao de pagamento ltda/.test(text) ||
      /(?:www\.)?mercadopago\.com\.br/.test(text)
    return (
      issuerSignature &&
      /detalhe dos movimentos/.test(text) &&
      /id da operacao/.test(text) &&
      /\bvalor\b/.test(text) &&
      /\bsaldo\b/.test(text)
    )
  },
  parse(input) {
    const period = extractPeriod(input.text)
    const parsed = parseTransactions(input.lines, input.currency)
    validateDeclaredTotals(input.text, parsed.transactions, input.currency)

    return {
      transactions: parsed.transactions,
      sourceTransactionCount: parsed.sourceTransactionCount,
      controls: {
        openingBalanceCents: extractLabeledAmount(
          input.text,
          /saldo inicial\s*:/i,
          input.currency,
        ),
        openingBalanceAt: period.periodStart,
        closingBalanceCents: extractLabeledAmount(
          input.text,
          /saldo final\s*:/i,
          input.currency,
        ),
        closingBalanceType: 'posted',
        balanceAsOf: period.periodEnd,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        dueDate: null,
      },
    }
  },
}

export function parseMercadoPagoAccountTransactions(input: {
  lines: PdfPositionedLine[]
  currency: string
}) {
  return parseTransactions(input.lines, input.currency).transactions
}
