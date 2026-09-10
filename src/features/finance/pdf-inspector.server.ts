import {
  classifyPdfAsync,
  extractPagesMarkdownAsync,
  extractText,
  extractTextWithPositions,
  processPdfAsync,
} from '@firecrawl/pdf-inspector'
import type { TextItem } from '@firecrawl/pdf-inspector'

import { parseCurrency, toMinorUnits } from '#/domain/currency'
import { selectPdfStatementParser } from './pdf-parsers/registry.server'

export interface SourceBounds {
  page: number
  x: number
  y: number
  width: number
  height: number
}

export interface PdfParsedTransaction {
  externalId?: string
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
  sourceTransactionCount: number | null
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
    layoutId: string | null
    layoutVersion: string | null
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
  const numericToken = normalized.replace(/^(?:R\$|US\$|BTC|₿)/, '')
  const debit =
    numericToken.startsWith('-') ||
    numericToken.startsWith('−') ||
    numericToken.startsWith('(') ||
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

function amountFromControlLine(
  text: string,
  currency: string,
  position: 'first' | 'last' = 'last',
) {
  const matches = [...text.matchAll(amountPattern)]
  const parsed = (position === 'first' ? matches.at(0) : matches.at(-1))?.[0]
  return parsed ? (parseLocalizedMoney(parsed, currency)?.cents ?? null) : null
}

function findControlLine(lines: PositionedLine[], pattern: RegExp) {
  return lines.find((line) => pattern.test(line.text))?.text ?? null
}

function mostFrequentLastFour(matches: IterableIterator<RegExpMatchArray>) {
  const counts = new Map<string, number>()
  for (const match of matches) {
    const value = match[1]
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [...counts.entries()].sort(
    ([leftValue, leftCount], [rightValue, rightCount]) =>
      rightCount - leftCount || leftValue.localeCompare(rightValue),
  )[0]?.[0]
}

export function detectIdentity(
  text: string,
  defaultCurrency = 'BRL',
  confirmedProfile?: Pick<PdfDocumentIdentity, 'institution' | 'kind'>,
): PdfDocumentIdentity {
  const normalized = text.toLocaleLowerCase('pt-BR')
  const institutionScores = [
    {
      institution: 'Mercado Pago',
      score:
        (/mercado pago institui[cç][aã]o de pagamento/.test(normalized)
          ? 5
          : 0) +
        (/mercadopago\.com\.br/.test(normalized) ? 5 : 0) +
        (/detalhe dos movimentos/.test(normalized) &&
        /id da opera[cç][aã]o/.test(normalized)
          ? 3
          : 0) +
        (/mercado pago/.test(normalized) ? 1 : 0),
    },
    {
      institution: 'Nubank',
      score:
        (/nu financeira s\.a\.|nu pagamentos s\.a\./.test(normalized) ? 5 : 0) +
        (/nubank\.com\.br/.test(normalized) ? 5 : 0) +
        (/\bnubank\b|ultravioleta/.test(normalized) ? 1 : 0),
    },
    {
      institution: 'Inter',
      score:
        (/banco inter s\.a\.|inter bank/.test(normalized) ? 5 : 0) +
        (/bancointer\.com\.br|inter\.co/.test(normalized) ? 5 : 0) +
        (/\bbanco inter\b|inter black/.test(normalized) ? 1 : 0),
    },
    {
      institution: 'BTG',
      score:
        (/banco btg pactual s\.a\./.test(normalized) ? 5 : 0) +
        (/btgpactual\.com/.test(normalized) ? 5 : 0) +
        (/\bbtg pactual\b/.test(normalized) ? 1 : 0),
    },
  ].sort((left, right) => right.score - left.score)
  const institution =
    confirmedProfile?.institution ??
    (institutionScores[0].score >= 3 &&
    institutionScores[0].score > institutionScores[1].score
      ? institutionScores[0].institution
      : null)
  const cardScore = [
    /total (?:da )?fatura/i,
    /valor (?:total|da fatura)/i,
    /limite (?:total|dispon[ií]vel)/i,
    /melhor dia/i,
    /data de vencimento/i,
  ].filter((pattern) => pattern.test(text)).length
  const accountScore = [
    /extrato de conta/i,
    /saldo (?:anterior|inicial|final|dispon[ií]vel)/i,
    /total de entradas/i,
    /total de sa[ií]das/i,
    /movimenta[cç][oõ]es/i,
  ].filter((pattern) => pattern.test(text)).length
  const kind =
    confirmedProfile?.kind ??
    (cardScore >= 2 && cardScore > accountScore
      ? 'card_statement'
      : accountScore >= 1
        ? 'bank_statement'
        : 'unknown')
  const rawIdentifier =
    institution === 'Nubank' && kind === 'card_statement'
      ? mostFrequentLastFour(text.matchAll(/[•*]{4}\s*(\d{4})\b/g))
      : institution === 'Nubank'
        ? text.match(/(?:cpf\s+)?ag[eê]ncia\s+conta\s+(\d(?:[\d.-]*\d)?)/i)?.[1]
        : institution === 'Inter' && kind === 'card_statement'
          ? mostFrequentLastFour(text.matchAll(/\b\d{4}\*{4}(\d{4})\b/g))
          : institution === 'Mercado Pago'
            ? text.match(
                /cpf\/cnpj:\s*\d+\s+\d+\s+(\d+)\s+ag[eê]ncia:\s*conta:/i,
              )?.[1]
            : text.match(
                /(?:conta|cart[aã]o|final|terminado em|n[úu]mero)[^\d\n]{0,18}(?:\*{0,8}|x{0,8})(\d{4})\b/i,
              )?.[1]
  const identifierDigits = rawIdentifier?.replace(/\D/g, '') ?? ''
  return {
    kind,
    institution,
    lastFour: identifierDigits.length >= 4 ? identifierDigits.slice(-4) : null,
    currency: (() => {
      const occurrences = [
        { currency: 'BRL', count: text.match(/R\$/g)?.length ?? 0 },
        { currency: 'USD', count: text.match(/US\$|\bUSD\b/g)?.length ?? 0 },
        {
          currency: 'BTC',
          count: text.match(/(?:\bBTC\b|₿)\s*[-−]?[\d.,]+/gi)?.length ?? 0,
        },
      ].sort((left, right) => right.count - left.count)
      return occurrences[0].count > 0
        ? occurrences[0].currency
        : parseCurrency(defaultCurrency)
    })(),
  }
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
  const documentText = `${rawText}\n${joinedLines}`
  const candidateIdentity = detectIdentity(documentText, defaultCurrency)
  const statementParser = selectPdfStatementParser({
    text: documentText,
    lines,
    currency: candidateIdentity.currency,
    institution: null,
    kind: 'unknown',
  })
  const identity = statementParser
    ? detectIdentity(documentText, defaultCurrency, {
        institution: statementParser.institution,
        kind: statementParser.kind,
      })
    : {
        kind: 'unknown' as const,
        institution: null,
        lastFour: null,
        currency: candidateIdentity.currency,
      }
  const parserResult = statementParser?.parse({
    text: documentText,
    lines,
    currency: identity.currency,
    institution: identity.institution,
    kind: identity.kind,
  })
  const layoutId = statementParser?.id ?? null
  const period = parserResult
    ? {
        periodStart: parserResult.controls.periodStart,
        periodEnd: parserResult.controls.periodEnd,
      }
    : extractPeriod(`${rawText}\n${markdown}`)

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
  const transactions = parserResult?.transactions ?? []
  const transactionDates = transactions
    .map((transaction) => transaction.postedAt)
    .sort()
  const periodStart = period.periodStart ?? transactionDates.at(0) ?? null
  const periodEnd = period.periodEnd ?? transactionDates.at(-1) ?? null
  const fallbackBalanceAsOf =
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
    sourceTransactionCount: parserResult?.sourceTransactionCount ?? null,
    controls: parserResult
      ? {
          ...parserResult.controls,
          periodStart,
          periodEnd,
        }
      : {
          openingBalanceCents: openingLine
            ? amountFromControlLine(openingLine, identity.currency, 'first')
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
          balanceAsOf: fallbackBalanceAsOf,
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
      layoutId,
      layoutVersion: statementParser?.version ?? null,
      rawTextLength,
      positionedTextLength,
      markdownTextLength,
      positionedToRawRatio,
      markdownToRawRatio,
      // Institutional parsers consume positioned text, not Markdown. Keep the
      // Markdown check for unknown layouts that may need fallback extraction.
      suspiciousTextLoss:
        rawTextLength > 200 &&
        (positionedToRawRatio < 0.72 ||
          (!parserResult && markdownToRawRatio < 0.72)),
    },
  }
}
