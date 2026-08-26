import {
  classifyPdfAsync,
  extractPagesMarkdownAsync,
  extractText,
  extractTextWithPositions,
  processPdfAsync,
} from '@firecrawl/pdf-inspector'
import type { TextItem } from '@firecrawl/pdf-inspector'

import { parseCurrency, toMinorUnits } from '#/domain/currency'

export interface SourceBounds {
  page: number
  x: number
  y: number
  width: number
  height: number
}

export interface PdfParsedTransaction {
  postedAt: string
  description: string
  amountCents: number
  currency: string
  raw: {
    line: string
    bounds: SourceBounds
  }
}

export interface PdfControlData {
  openingBalanceCents: number | null
  openingBalanceAt: string | null
  closingBalanceCents: number | null
  closingBalanceType: 'posted' | 'available' | 'card_statement' | null
  balanceAsOf: string | null
  periodStart: string | null
  periodEnd: string | null
  dueDate: string | null
}

export function classifyClosingBalanceLabel(
  value: string,
  targetType: 'account' | 'card',
) {
  if (targetType === 'card') {
    return /total (?:da )?fatura|valor (?:total|da fatura)/i.test(value)
      ? ('card_statement' as const)
      : null
  }
  if (/saldo (?:final|em conta)/i.test(value)) return 'posted' as const
  if (/saldo dispon[ií]vel/i.test(value)) return 'available' as const
  return null
}

export interface PdfDocumentIdentity {
  kind: 'bank_statement' | 'card_statement' | 'unknown'
  institution: string | null
  lastFour: string | null
  currency: string
}

export interface PdfInspectionResult {
  transactions: PdfParsedTransaction[]
  controls: PdfControlData
  identity: PdfDocumentIdentity
  markdown: string
  positionedItems: TextItem[]
  classification: {
    pdfType: string
    confidence: number
    pageCount: number
    pagesNeedingOcr: number[]
    isComplex: boolean
    hasEncodingIssues: boolean
    pagesWithTables: number[]
    pagesWithColumns: number[]
  }
  diagnostics: {
    rawTextLength: number
    positionedTextLength: number
    markdownTextLength: number
    positionedToRawRatio: number
    markdownToRawRatio: number
    suspiciousTextLoss: boolean
  }
}

interface PositionedLine {
  text: string
  bounds: SourceBounds
}

const amountPattern =
  /(?:(?:R\$|US\$|BTC|₿)\s*)?[-−]?\(?(?:\d{1,3}(?:\.\d{3})*|\d+)[,.]\d{2,8}\)?(?:\s*(?:C|D|CR|DB))?/gi
const datePattern = /\b(\d{4}-\d{2}-\d{2}|\d{2}[/.-]\d{2}(?:[/.-]\d{2,4})?)\b/

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

function plainMarkdownLength(value: string) {
  return value
    .replace(/[#*_|`>()-]/g, '')
    .replaceAll('[', '')
    .replaceAll(']', '')
    .replace(/\s+/g, '').length
}

function roundCoordinate(value: number) {
  return Math.round(value * 100) / 100
}

export function groupPositionedTextIntoLines(items: TextItem[]) {
  const textItems = items
    .filter((item) => item.text.trim() && item.itemType === 'Text')
    .sort((left, right) =>
      left.page !== right.page
        ? left.page - right.page
        : Math.abs(left.y - right.y) > 2
          ? left.y - right.y
          : left.x - right.x,
    )
  const groups: Array<{ page: number; y: number; items: TextItem[] }> = []

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

export function parseLocalizedMoney(value: string, currency = 'BRL') {
  const normalized = value.toUpperCase().replace(/\s+/g, '')
  const debit =
    normalized.startsWith('-') ||
    normalized.startsWith('−') ||
    normalized.startsWith('(') ||
    /(?:D|DB)$/.test(normalized)
  const credit = /(?:C|CR)$/.test(normalized)
  let cents: number
  try {
    cents = toMinorUnits(
      normalized.replace('−', '-').replace(/(?:C|D|CR|DB)$/, ''),
      currency,
    )
  } catch {
    return null
  }
  return {
    cents: debit ? -Math.abs(cents) : Math.abs(cents),
    explicit: debit || credit,
  }
}

function toIsoDate(
  value: string,
  periodStart: string | null,
  periodEnd: string | null,
) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  const [day, month, rawYear] = value.split(/[/.-]/)
  if (rawYear) {
    const year = rawYear.length === 2 ? `20${rawYear}` : rawYear
    return `${year}-${month}-${day}`
  }

  const referenceYear = Number((periodEnd ?? periodStart)?.slice(0, 4))
  const years = Number.isFinite(referenceYear)
    ? [referenceYear - 1, referenceYear, referenceYear + 1]
    : [new Date().getUTCFullYear()]
  const candidates = years.map((year) => `${year}-${month}-${day}`)
  if (periodStart && periodEnd) {
    const inside = candidates.find(
      (candidate) => candidate >= periodStart && candidate <= periodEnd,
    )
    if (inside) return inside
  }
  return candidates[Math.min(1, candidates.length - 1)]
}

function extractFullDates(text: string) {
  return [...text.matchAll(/\b(\d{2})[/.-](\d{2})[/.-](\d{2,4})\b/g)]
    .map((match) => {
      const year = match[3].length === 2 ? `20${match[3]}` : match[3]
      return `${year}-${match[2]}-${match[1]}`
    })
    .filter((date) => !Number.isNaN(new Date(`${date}T12:00:00Z`).getTime()))
}

function extractPeriod(text: string) {
  const candidates = [
    ...text.matchAll(
      /(?:per[ií]odo|lan[cç]amentos?|movimenta[cç][aã]o)[^\n]{0,80}/gi,
    ),
  ].map((match) => [...new Set(extractFullDates(match[0]))])
  const dates =
    candidates.find((candidate) => candidate.length >= 2) ??
    candidates.at(0) ??
    []
  return {
    periodStart: dates.at(0) ?? null,
    periodEnd: dates.at(1) ?? dates.at(0) ?? null,
  }
}

function amountFromControlLine(text: string, currency: string) {
  const matches = [...text.matchAll(amountPattern)]
  const parsed = matches.at(-1)?.[0]
  return parsed ? (parseLocalizedMoney(parsed, currency)?.cents ?? null) : null
}

function findControlLine(lines: PositionedLine[], pattern: RegExp) {
  return lines.find((line) => pattern.test(line.text))?.text ?? null
}

function detectIdentity(
  text: string,
  defaultCurrency = 'BRL',
): PdfDocumentIdentity {
  const normalized = text.toLocaleLowerCase('pt-BR')
  const institution = normalized.includes('mercado pago')
    ? 'Mercado Pago'
    : /banco inter|inter bank|inter black/.test(normalized)
      ? 'Inter'
      : /nubank|nu pagamentos|ultravioleta/.test(normalized)
        ? 'Nubank'
        : /btg pactual/.test(normalized)
          ? 'BTG'
          : null
  const kind =
    /fatura|vencimento|limite (?:total|dispon[ií]vel)|melhor dia/i.test(text)
      ? 'card_statement'
      : /extrato|saldo (?:anterior|inicial|final|dispon[ií]vel)/i.test(text)
        ? 'bank_statement'
        : 'unknown'
  const lastFour = text.match(
    /(?:conta|cart[aã]o|final|terminado em|n[úu]mero)[^\d\n]{0,18}(?:\*{0,8}|x{0,8})(\d{4})\b/i,
  )?.[1]
  return {
    kind,
    institution,
    lastFour: lastFour ?? null,
    currency: /\bBTC\b|₿|bitcoin/i.test(text)
      ? 'BTC'
      : /\bUSD\b|US\$|d[oó]lar/i.test(text)
        ? 'USD'
        : parseCurrency(defaultCurrency),
  }
}

function inferAmountSign(
  parsed: { cents: number; explicit: boolean },
  description: string,
  targetType: 'account' | 'card',
) {
  if (parsed.explicit) return parsed.cents
  const normalized = description.toLocaleLowerCase('pt-BR')
  if (
    /estorno|reembolso|cr[eé]dito|recebido|dep[oó]sito|rendimento|resgate/.test(
      normalized,
    )
  ) {
    return Math.abs(parsed.cents)
  }
  if (targetType === 'card') return -Math.abs(parsed.cents)
  if (
    /compra|pagamento|pix enviado|transfer[eê]ncia enviada|saque|tarifa|d[eé]bito/.test(
      normalized,
    )
  ) {
    return -Math.abs(parsed.cents)
  }
  return null
}

export function parsePositionedTransactions(input: {
  lines: PositionedLine[]
  targetType: 'account' | 'card'
  currency: string
  periodStart: string | null
  periodEnd: string | null
}) {
  const transactions: PdfParsedTransaction[] = []
  for (const line of input.lines) {
    const dateMatch = line.text.match(datePattern)
    if (!dateMatch || dateMatch.index === undefined) continue
    const amountMatches = [...line.text.matchAll(amountPattern)]
    const amountMatch = amountMatches.at(-1)
    if (!amountMatch) continue
    if (amountMatch.index <= dateMatch.index + dateMatch[0].length) continue
    const parsedAmount = parseLocalizedMoney(amountMatch[0], input.currency)
    if (!parsedAmount) continue
    const description = normalizeWhitespace(
      line.text.slice(dateMatch.index + dateMatch[0].length, amountMatch.index),
    ).replace(/^[|:;–—-]+|[|:;–—-]+$/g, '')
    if (
      !description ||
      /saldo (?:anterior|inicial|final)|total da fatura/i.test(description)
    ) {
      continue
    }
    const amountCents = inferAmountSign(
      parsedAmount,
      description,
      input.targetType,
    )
    if (amountCents === null) continue
    transactions.push({
      postedAt: toIsoDate(dateMatch[1], input.periodStart, input.periodEnd),
      description,
      amountCents,
      currency: input.currency,
      raw: { line: line.text, bounds: line.bounds },
    })
  }
  return transactions
}

export async function inspectPdfStatement(
  buffer: Buffer,
  targetType: 'account' | 'card',
  defaultCurrency = 'BRL',
): Promise<PdfInspectionResult> {
  const [classification, pages, processed] = await Promise.all([
    classifyPdfAsync(buffer),
    extractPagesMarkdownAsync(buffer),
    processPdfAsync(buffer),
  ])
  const positionedItems = extractTextWithPositions(buffer)
  const rawText = extractText(buffer)
  const markdown = pages.pages
    .map((page) => page.markdown)
    .join('\n\n<!-- page -->\n\n')
  const lines = groupPositionedTextIntoLines(positionedItems)
  const joinedLines = lines.map((line) => line.text).join('\n')
  const identity = detectIdentity(`${rawText}\n${joinedLines}`, defaultCurrency)
  const period = extractPeriod(`${rawText}\n${markdown}`)

  const openingLine = findControlLine(
    lines,
    /saldo (?:anterior|inicial|de abertura)/i,
  )
  const postedClosingLine = findControlLine(
    lines,
    targetType === 'card'
      ? /total (?:da )?fatura|valor (?:total|da fatura)/i
      : /saldo (?:final|em conta)/i,
  )
  const availableClosingLine =
    targetType === 'account'
      ? findControlLine(lines, /saldo dispon[ií]vel/i)
      : null
  const closingLine = postedClosingLine ?? availableClosingLine
  const closingBalanceType = closingLine
    ? classifyClosingBalanceLabel(closingLine, targetType)
    : null
  const dueLine = findControlLine(lines, /vencimento|data de pagamento/i)
  const dueDate = extractFullDates(dueLine ?? '').at(0) ?? null
  const parsedClosingBalance = closingLine
    ? amountFromControlLine(closingLine, identity.currency)
    : null
  const transactions = parsePositionedTransactions({
    lines,
    targetType,
    currency: identity.currency,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
  })
  const transactionDates = transactions
    .map((transaction) => transaction.postedAt)
    .sort()
  const periodStart = period.periodStart ?? transactionDates.at(0) ?? null
  const periodEnd = period.periodEnd ?? transactionDates.at(-1) ?? null
  const balanceAsOf =
    extractFullDates(closingLine ?? '').at(-1) ?? periodEnd ?? dueDate

  const rawTextLength = rawText.replace(/\s+/g, '').length
  const positionedTextLength = positionedItems
    .map((item) => item.text)
    .join('')
    .replace(/\s+/g, '').length
  const markdownTextLength = plainMarkdownLength(markdown)
  const positionedToRawRatio = rawTextLength
    ? positionedTextLength / rawTextLength
    : 0
  const markdownToRawRatio = rawTextLength
    ? markdownTextLength / rawTextLength
    : 0

  return {
    transactions,
    controls: {
      openingBalanceCents: openingLine
        ? amountFromControlLine(openingLine, identity.currency)
        : null,
      openingBalanceAt: openingLine
        ? (extractFullDates(openingLine).at(-1) ?? periodStart)
        : null,
      closingBalanceCents:
        parsedClosingBalance === null
          ? null
          : targetType === 'card'
            ? Math.abs(parsedClosingBalance)
            : parsedClosingBalance,
      closingBalanceType,
      balanceAsOf,
      periodStart,
      periodEnd,
      dueDate,
    },
    identity,
    markdown,
    positionedItems,
    classification: {
      pdfType: classification.pdfType,
      confidence: classification.confidence,
      pageCount: classification.pageCount,
      pagesNeedingOcr: classification.pagesNeedingOcr,
      isComplex: pages.isComplex,
      hasEncodingIssues: processed.hasEncodingIssues,
      pagesWithTables: pages.pagesWithTables,
      pagesWithColumns: pages.pagesWithColumns,
    },
    diagnostics: {
      rawTextLength,
      positionedTextLength,
      markdownTextLength,
      positionedToRawRatio,
      markdownToRawRatio,
      suspiciousTextLoss:
        rawTextLength > 200 &&
        (positionedToRawRatio < 0.72 || markdownToRawRatio < 0.72),
    },
  }
}
