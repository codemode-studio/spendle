import * as Result from 'effect/Result'

import { cents, fold, lastFour, signedAmount } from './Layout.ts'
import type { LayoutLine, PdfLayout, PositionedLine } from './Layout.ts'

const transactionDate = /\b(\d{2})-(\d{2})-(\d{2,4})\b/
const operationId = /\b(\d{8,})\b/

const normalizeText = (value: string) => value.replace(/\s+/g, ' ').trim()

const money = new RegExp(signedAmount({ currency: 'required' }), 'gi')
const moneyMatches = (value: string) => [...value.matchAll(money)]

const toIsoDate = (match: RegExpMatchArray) => {
  const year = match[3]!.length === 2 ? `20${match[3]}` : match[3]!
  return `${year}-${match[2]}-${match[1]}`
}

const readPeriod = (text: string) => {
  const match = text.match(
    /per[ií]odo\s*:?\s*(?:de\s*)?(\d{2}-\d{2}-\d{2,4})\s*(?:a(?:l)?|at[eé])\s*(\d{2}-\d{2}-\d{2,4})/i,
  )
  const date = (value: string | undefined) => {
    const dateMatch = value?.match(transactionDate)
    return dateMatch ? toIsoDate(dateMatch) : null
  }
  const start = date(match?.[1])
  const end = date(match?.[2])
  return start && end ? { start, end } : null
}

const labeledAmount = (text: string, label: RegExp) => {
  const labelMatch = label.exec(text)
  if (!labelMatch?.[0]) return null
  const amount = moneyMatches(
    text.slice(labelMatch.index + labelMatch[0].length),
  ).at(0)?.[0]
  return amount ? cents(amount) : null
}

const hasTransactionIdentity = (line: PositionedLine) => {
  const dateMatch = line.text.match(transactionDate)
  if (!dateMatch?.[0] || dateMatch.index === undefined) return false
  return operationId.test(
    line.text.slice(dateMatch.index + dateMatch[0].length),
  )
}

/**
 * Reads rows `DD-MM-YYYY description operation-id R$ value R$ balance`. The
 * value is the second to last amount; the last is the running balance.
 * Descriptions can wrap onto lines just above and below the row.
 */
export const readMercadoPagoRows = (lines: ReadonlyArray<PositionedLine>) => {
  const candidates = lines.filter(hasTransactionIdentity)
  const rowsByPage = new Map<number, Array<PositionedLine>>()
  for (const line of candidates) {
    const pageRows = rowsByPage.get(line.bounds.page) ?? []
    pageRows.push(line)
    rowsByPage.set(line.bounds.page, pageRows)
  }
  for (const pageRows of rowsByPage.values()) {
    pageRows.sort((left, right) => left.bounds.y - right.bounds.y)
  }
  const ordered = [...candidates].sort((left, right) =>
    left.bounds.page !== right.bounds.page
      ? left.bounds.page - right.bounds.page
      : right.bounds.y - left.bounds.y,
  )

  const rows: Array<LayoutLine> = []
  for (const line of ordered) {
    const dateMatch = line.text.match(transactionDate)
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
    const amountCents = cents(transactionAmount[0])
    if (amountCents === null) continue

    const lineDescription = prefix
      .slice(0, operationIdMatch.index)
      .replace(/^[|:;–—-]+|[|:;–—-]+$/g, '')
      .trim()
    const pageRows = rowsByPage.get(line.bounds.page) ?? []
    const rowIndex = pageRows.indexOf(line)
    const below = pageRows[rowIndex - 1]
    const above = pageRows[rowIndex + 1]
    const lowerBound = Math.max(
      line.bounds.y - 32,
      below ? (below.bounds.y + line.bounds.y) / 2 : Number.NEGATIVE_INFINITY,
    )
    const upperBound = Math.min(
      line.bounds.y + 32,
      above ? (line.bounds.y + above.bounds.y) / 2 : Number.POSITIVE_INFINITY,
    )
    const continuations = lines.filter(
      (candidate) =>
        candidate !== line &&
        candidate.bounds.page === line.bounds.page &&
        candidate.bounds.y > lowerBound &&
        candidate.bounds.y < upperBound &&
        candidate.bounds.x >= line.bounds.x + line.bounds.width * 0.08 &&
        candidate.bounds.x < line.bounds.x + line.bounds.width * 0.7 &&
        !transactionDate.test(candidate.text) &&
        moneyMatches(candidate.text).length === 0 &&
        !/\b(?:data|descri[cç][aã]o|id da opera[cç][aã]o|valor|saldo)\b/i.test(
          candidate.text,
        ),
    )
    const description = [
      ...continuations.map((candidate) => ({
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

    rows.push({
      externalId: operationIdMatch[1],
      bookedOn: toIsoDate(dateMatch),
      description,
      amountCents,
      source: line,
    })
  }
  return { rows, candidates: candidates.length }
}

export const mercadoPagoAccount: PdfLayout = {
  id: 'mercado-pago/account-statement/v1',
  kind: 'account',
  currency: 'BRL',
  matches: (text) => {
    const folded = fold(text).toLowerCase()
    return (
      (/mercado pago instituicao de pagamento ltda/.test(folded) ||
        /(?:www\.)?mercadopago\.com\.br/.test(folded)) &&
      /detalhe dos movimentos/.test(folded) &&
      /id da operacao/.test(folded) &&
      /\bvalor\b/.test(folded) &&
      /\bsaldo\b/.test(folded)
    )
  },
  parse: ({ text, lines }) => {
    const period = readPeriod(text)
    const { rows, candidates } = readMercadoPagoRows(lines)

    // The summary's inflow and outflow totals must match the rows read.
    const declaredCredits = labeledAmount(text, /entradas\s*:/i)
    const declaredDebits = labeledAmount(text, /sa[ií]das\s*:/i)
    const credits = rows.reduce(
      (sum, row) => sum + Math.max(0, row.amountCents),
      0,
    )
    const debits = rows.reduce(
      (sum, row) => sum - Math.min(0, row.amountCents),
      0,
    )
    if (
      (declaredCredits !== null && Math.abs(declaredCredits) !== credits) ||
      (declaredDebits !== null && Math.abs(declaredDebits) !== debits)
    ) {
      return Result.fail('summary_balance_mismatch')
    }

    const closing = labeledAmount(text, /saldo final\s*:/i)
    return Result.succeed({
      lines: rows,
      period,
      closingBalance:
        closing !== null && period
          ? { asOf: period.end, cents: closing }
          : null,
      accountHint: lastFour(
        text.match(
          /cpf\/cnpj:\s*\d+\s+\d+\s+(\d+)\s+ag[eê]ncia:\s*conta:/i,
        )?.[1],
      ),
      rejectedRows: candidates - rows.length,
    })
  },
}
