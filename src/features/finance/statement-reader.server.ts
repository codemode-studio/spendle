import { Ofx } from 'ofx-data-extractor'
import { PDFParse } from 'pdf-parse'
import { z } from 'zod'

import {
  currencySchema,
  formatMinorUnitsForInput,
  parseCurrency,
  toMinorUnits,
} from '#/domain/currency'
import { inferCoverageFromLearnedTemplates } from '#/domain/import-coverage'
import { getConfiguredAiModel } from './ai.server'
import { parseCsvStatement } from './csv-statement.server'
import { inspectPdfStatement } from './pdf-inspector.server'

export type StatementTargetType = 'account' | 'card'

export interface ParsedTransaction {
  externalId?: string
  postedAt: string
  description: string
  amountCents: number
  currency: string
  raw?: unknown
}

export interface ParsedOfxStatement {
  transactions: ParsedTransaction[]
  closingBalanceCents: number | null
  balanceAsOf: string | null
  sourceTransactionCount: number
  periodStart: string | null
  periodEnd: string | null
  activityStart: string | null
  activityEnd: string | null
  periodSource: 'metadata' | 'activity'
  coverageConfidence: 'high' | 'low'
}

export interface StatementReadResult {
  transactions: ParsedTransaction[]
  parser: 'ofx' | 'csv' | 'pdf_inspector' | 'pdf_ai'
  documentKind: 'bank_statement' | 'card_statement' | 'unknown'
  sourceTransactionCount: number | null
  controls: {
    openingBalanceCents: number | null
    openingBalanceAt: string | null
    closingBalanceCents: number | null
    closingBalanceType: 'posted' | 'available' | 'card_statement' | null
    balanceAsOf: string | null
    dueDate: string | null
  }
  coverage: {
    periodStart: string | null
    periodEnd: string | null
    activityStart: string | null
    activityEnd: string | null
    periodSource: 'metadata' | 'filename' | 'activity' | 'unknown'
    confidence: 'high' | 'medium' | 'low' | 'unknown'
  }
  identity: {
    institution: string | null
    lastFour: string | null
    currency: string | null
  }
  diagnostics: {
    pdfType: string | null
    pdfConfidenceBps: number | null
    pageCount: number | null
    pagesNeedingOcrJson: string | null
    markdown: string | null
    positionedTextJson: string | null
    extractionDiagnosticsJson: string | null
    blockingReason: string | null
  }
}

export class StatementReadError extends Error {
  constructor(
    message: string,
    readonly result: StatementReadResult | null = null,
  ) {
    super(message)
    this.name = 'StatementReadError'
  }
}

interface ReadStatementInput {
  buffer: Buffer
  filename: string
  targetType: StatementTargetType
  targetCurrency: string
  targetInstitution: string | null
  targetIdentifiers: Array<string | null | undefined>
  aiConsent: boolean
  learnedCoverageTemplates: string[]
}

export function normalizeLastFour(value: string | null | undefined) {
  const digits = value?.replace(/\D/g, '') ?? ''
  return digits.length >= 4 ? digits.slice(-4) : null
}

export function matchesDocumentLastFour(
  detectedLastFour: string,
  targetIdentifiers: Array<string | null | undefined>,
) {
  const detected = normalizeLastFour(detectedLastFour)
  return Boolean(
    detected &&
    targetIdentifiers.some(
      (identifier) => normalizeLastFour(identifier) === detected,
    ),
  )
}

function parseBrazilianDate(value: string) {
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10)
  const [day, month, rawYear] = value.split('/')
  const year = rawYear.length === 2 ? `20${rawYear}` : rawYear
  return `${year}-${month}-${day}`
}

function readOfxTag(source: string, tag: string) {
  const match = source.match(new RegExp(`<${tag}>\\s*([^<\\r\\n]+)`, 'i'))
  return match?.[1]?.trim() ?? null
}

export function parseOfxAmount(value: string | null, currency = 'BRL') {
  if (!value) return null
  const compact = value.replaceAll(/\s/g, '')
  const lastComma = compact.lastIndexOf(',')
  const lastDot = compact.lastIndexOf('.')
  const normalized =
    lastComma >= 0 && lastDot >= 0
      ? lastComma > lastDot
        ? compact.replaceAll('.', '').replace(',', '.')
        : compact.replaceAll(',', '')
      : lastComma >= 0
        ? compact.replace(',', '.')
        : compact
  try {
    return toMinorUnits(normalized, currency)
  } catch {
    return null
  }
}

function parseOfxDate(value: string | null) {
  if (!value) return null
  const compact = value.replace(/\D/g, '').slice(0, 8)
  if (compact.length !== 8) return null
  const candidate = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`
  const parsed = new Date(`${candidate}T12:00:00Z`)
  return Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== candidate
    ? null
    : candidate
}

export function parseOfxStatement(
  buffer: Buffer,
  defaultCurrency = 'BRL',
): ParsedOfxStatement {
  const source = buffer.toString('utf8')
  const declaredCurrency = readOfxTag(source, 'CURDEF')?.toUpperCase()
  let currency = parseCurrency(defaultCurrency)
  if (declaredCurrency) {
    try {
      currency = parseCurrency(declaredCurrency)
    } catch {
      // Preserve the destination currency when the OFX code is malformed.
    }
  }
  const closingBalanceCents = parseOfxAmount(
    readOfxTag(source, 'BALAMT'),
    currency,
  )
  const parserSource =
    closingBalanceCents === null
      ? source
      : source.replace(
          /(<BALAMT>\s*)[^<\r\n]+/i,
          (_match, prefix: string) =>
            `${prefix}${formatMinorUnitsForInput(closingBalanceCents, currency).replace(',', '.')}`,
        )
  const ofx = Ofx.fromBuffer(Buffer.from(parserSource)).config({
    parserMode: 'lenient',
  })
  const normalized = ofx.toNormalized({ amountMode: 'cents', dateMode: 'iso' })
  const rawTransactionAmounts = [
    ...source.matchAll(
      /<STMTTRN(?=>|\s)[\s\S]*?(?=<\/STMTTRN>|<STMTTRN(?=>|\s)|<\/BANKTRANLIST>)/gi,
    ),
  ].map((match) => readOfxTag(match[0], 'TRNAMT'))
  const transactions = normalized.transactions
    .map((transaction, index) => {
      const rawAmount = Number(transaction.amount)
      const amountCentsFromParser =
        transaction.direction === 'debit'
          ? -Math.abs(rawAmount)
          : Math.abs(rawAmount)
      const parsedRawAmount = parseOfxAmount(
        rawTransactionAmounts[index] ?? null,
        currency,
      )
      const amountCents =
        parsedRawAmount === null
          ? transaction.amount === null
            ? Number.NaN
            : amountCentsFromParser
          : transaction.direction === 'debit'
            ? -Math.abs(parsedRawAmount)
            : Math.abs(parsedRawAmount)
      return {
        externalId: transaction.fitId || undefined,
        postedAt: String(transaction.postedAt).slice(0, 10),
        description: transaction.description || 'Lançamento sem descrição',
        amountCents,
        currency,
        raw: transaction.raw,
      }
    })
    .filter(
      (transaction) =>
        Number.isFinite(transaction.amountCents) &&
        parseOfxDate(transaction.postedAt) !== null,
    )
  const periodStart = parseOfxDate(readOfxTag(source, 'DTSTART'))
  const periodEnd = parseOfxDate(readOfxTag(source, 'DTEND'))
  const activityDates = transactions
    .map((transaction) => transaction.postedAt)
    .sort()
  const activityStart = activityDates.at(0) ?? null
  const activityEnd = activityDates.at(-1) ?? null
  const declaredContainsActivity = Boolean(
    periodStart &&
    periodEnd &&
    (!activityStart || periodStart <= activityStart) &&
    (!activityEnd || periodEnd >= activityEnd),
  )
  return {
    transactions,
    closingBalanceCents,
    balanceAsOf: parseOfxDate(readOfxTag(source, 'DTASOF')),
    sourceTransactionCount: (source.match(/<STMTTRN(?=>|\s)/gi) ?? []).length,
    periodStart,
    periodEnd,
    activityStart,
    activityEnd,
    periodSource: declaredContainsActivity ? 'metadata' : 'activity',
    coverageConfidence: declaredContainsActivity ? 'high' : 'low',
  }
}

export function parseOfxBuffer(buffer: Buffer): ParsedTransaction[] {
  return parseOfxStatement(buffer).transactions
}

export async function parsePdfBufferLegacy(buffer: Buffer) {
  const parser = new PDFParse({ data: buffer })
  try {
    const result = await parser.getText()
    const parsed: ParsedTransaction[] = []
    const patterns = [
      /^(\d{2}\/\d{2}\/\d{2,4})\s+(.+?)\s+(-?[\d.]+,\d{2})(?:\s*([CD]))?$/,
      /^(\d{2}\/\d{2})\s+(.+?)\s+(-?[\d.]+,\d{2})(?:\s*([CD]))?$/,
      /^(\d{4}-\d{2}-\d{2})\s+(.+?)\s+(-?[\d,]+\.\d{2})(?:\s*([CD]))?$/,
    ]

    for (const sourceLine of result.text.split('\n')) {
      const line = sourceLine.replace(/\s+/g, ' ').trim()
      const match = patterns.map((pattern) => line.match(pattern)).find(Boolean)
      if (!match) continue
      const [, rawDate, description, rawAmount, direction] = match
      const year = new Date().getUTCFullYear()
      const date =
        rawDate.split('/').length === 2 ? `${rawDate}/${year}` : rawDate
      let amountCents = toMinorUnits(rawAmount, 'BRL')
      if (direction === 'D' || /compra|pagamento|debito/i.test(description)) {
        amountCents = -Math.abs(amountCents)
      } else if (direction === 'C') {
        amountCents = Math.abs(amountCents)
      }
      parsed.push({
        postedAt: parseBrazilianDate(date),
        description,
        amountCents,
        currency: 'BRL',
        raw: { line },
      })
    }
    return parsed
  } finally {
    await parser.destroy()
  }
}

const aiPdfOutputSchema = z.object({
  transactions: z.array(
    z.object({
      postedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      description: z.string().min(1),
      amountCents: z.number().int(),
      currency: currencySchema,
      externalId: z.string().nullable(),
    }),
  ),
})

async function parsePdfBufferWithAi(buffer: Buffer, filename: string) {
  const model = getConfiguredAiModel()
  if (!model) {
    throw new Error(
      'O PDF não foi reconhecido localmente e o OpenRouter não está configurado.',
    )
  }

  const { generateText, Output } = await import('ai')
  const result = await generateText({
    model,
    output: Output.object({ schema: aiPdfOutputSchema }),
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Extraia todas as transações deste extrato. amountCents deve usar a menor unidade da moeda: centavos para BRL/USD e satoshis (8 casas) para BTC. Débitos devem ser negativos e créditos positivos. Preserve a moeda original.',
          },
          {
            type: 'file',
            data: buffer,
            mediaType: 'application/pdf',
            filename,
          },
        ],
      },
    ],
  })
  return result.output.transactions.map((transaction) => ({
    ...transaction,
    externalId: transaction.externalId ?? undefined,
  }))
}

function emptyDiagnostics(): StatementReadResult['diagnostics'] {
  return {
    pdfType: null,
    pdfConfidenceBps: null,
    pageCount: null,
    pagesNeedingOcrJson: null,
    markdown: null,
    positionedTextJson: null,
    extractionDiagnosticsJson: null,
    blockingReason: null,
  }
}

function assertStatementIdentity(
  result: StatementReadResult,
  input: ReadStatementInput,
) {
  const detectedInstitution = result.identity.institution?.toLowerCase()
  const targetInstitution = input.targetInstitution?.toLowerCase()
  if (
    detectedInstitution &&
    targetInstitution &&
    !targetInstitution.includes(detectedInstitution) &&
    !detectedInstitution.includes(targetInstitution)
  ) {
    throw new Error(
      `O documento parece ser de ${result.identity.institution}, mas o destino selecionado é ${input.targetInstitution}.`,
    )
  }
  if (
    (input.targetType === 'account' &&
      result.documentKind === 'card_statement') ||
    (input.targetType === 'card' && result.documentKind === 'bank_statement')
  ) {
    throw new Error(
      'O tipo de documento não corresponde ao destino selecionado.',
    )
  }
  if (
    result.identity.lastFour &&
    input.targetIdentifiers.some(Boolean) &&
    !matchesDocumentLastFour(result.identity.lastFour, input.targetIdentifiers)
  ) {
    throw new Error(
      `O documento termina em •${result.identity.lastFour}, diferente do destino selecionado.`,
    )
  }
}

async function readPdfStatement(
  input: ReadStatementInput,
): Promise<StatementReadResult> {
  const inspection = await inspectPdfStatement(
    input.buffer,
    input.targetType,
    input.targetCurrency,
  )
  let transactions: ParsedTransaction[] = inspection.transactions
  let parser: StatementReadResult['parser'] = 'pdf_inspector'
  const activityDates = transactions
    .map((transaction) => transaction.postedAt)
    .sort()
  const periodSource =
    inspection.controls.periodStart && inspection.controls.periodEnd
      ? ('metadata' as const)
      : ('activity' as const)
  const legacy = await parsePdfBufferLegacy(input.buffer).catch(() => [])
  const legacyNet = legacy.reduce((sum, item) => sum + item.amountCents, 0)
  const inspectorNet = transactions.reduce(
    (sum, item) => sum + item.amountCents,
    0,
  )
  const disagreesWithLegacy =
    legacy.length > 0 &&
    (legacy.length !== transactions.length || legacyNet !== inspectorNet)
  let blockingReason: string | null = null

  if (inspection.classification.pagesNeedingOcr.length) {
    blockingReason =
      'Há páginas que exigem OCR local. Este lote ficou bloqueado para evitar perda silenciosa de lançamentos.'
  } else if (inspection.diagnostics.suspiciousTextLoss) {
    blockingReason =
      'As extrações nativa, posicionada e Markdown têm diferenças grandes de conteúdo.'
  } else if (disagreesWithLegacy) {
    blockingReason =
      'O extrator posicional e o parser anterior discordam na contagem ou nos totais.'
  }

  if (!transactions.length && input.aiConsent) {
    transactions = await parsePdfBufferWithAi(input.buffer, input.filename)
    parser = 'pdf_ai'
    blockingReason =
      'A extração por IA não possui prova posicional completa e não pode ser consolidada automaticamente.'
  }

  return {
    transactions,
    parser,
    documentKind: inspection.identity.kind,
    sourceTransactionCount: null,
    controls: {
      openingBalanceCents: inspection.controls.openingBalanceCents,
      openingBalanceAt: inspection.controls.openingBalanceAt,
      closingBalanceCents: inspection.controls.closingBalanceCents,
      closingBalanceType: inspection.controls.closingBalanceType,
      balanceAsOf: inspection.controls.balanceAsOf,
      dueDate: inspection.controls.dueDate,
    },
    coverage: {
      periodStart: inspection.controls.periodStart,
      periodEnd: inspection.controls.periodEnd,
      activityStart: activityDates.at(0) ?? null,
      activityEnd: activityDates.at(-1) ?? null,
      periodSource,
      confidence: periodSource === 'metadata' ? 'high' : 'low',
    },
    identity: {
      institution: inspection.identity.institution,
      lastFour: inspection.identity.lastFour,
      currency: inspection.identity.currency,
    },
    diagnostics: {
      pdfType: inspection.classification.pdfType,
      pdfConfidenceBps: Math.round(
        inspection.classification.confidence * 10_000,
      ),
      pageCount: inspection.classification.pageCount,
      pagesNeedingOcrJson: JSON.stringify(
        inspection.classification.pagesNeedingOcr,
      ),
      markdown: inspection.markdown,
      positionedTextJson: JSON.stringify(inspection.positionedItems),
      extractionDiagnosticsJson: JSON.stringify({
        ...inspection.diagnostics,
        pagesWithTables: inspection.classification.pagesWithTables,
        pagesWithColumns: inspection.classification.pagesWithColumns,
        legacyTransactionCount: legacy.length,
        legacyNetMovementCents: legacyNet,
        inspectorTransactionCount: transactions.length,
        inspectorNetMovementCents: inspectorNet,
        disagreesWithLegacy,
      }),
      blockingReason,
    },
  }
}

export async function readStatement(
  input: ReadStatementInput,
): Promise<StatementReadResult> {
  const extension = input.filename.split('.').pop()?.toLowerCase()
  let result: StatementReadResult

  if (extension === 'ofx') {
    const statement = parseOfxStatement(input.buffer, input.targetCurrency)
    result = {
      transactions: statement.transactions,
      parser: 'ofx',
      documentKind:
        input.targetType === 'account' ? 'bank_statement' : 'card_statement',
      sourceTransactionCount: statement.sourceTransactionCount,
      controls: {
        openingBalanceCents: null,
        openingBalanceAt: null,
        closingBalanceCents: statement.closingBalanceCents,
        closingBalanceType:
          statement.closingBalanceCents === null ? null : 'posted',
        balanceAsOf: statement.balanceAsOf,
        dueDate: null,
      },
      coverage: {
        periodStart: statement.periodStart,
        periodEnd: statement.periodEnd,
        activityStart: statement.activityStart,
        activityEnd: statement.activityEnd,
        periodSource: statement.periodSource,
        confidence: statement.coverageConfidence,
      },
      identity: {
        institution: null,
        lastFour: null,
        currency:
          statement.transactions[0]?.currency ??
          parseCurrency(input.targetCurrency),
      },
      diagnostics: emptyDiagnostics(),
    }
  } else if (extension === 'csv') {
    const statement = parseCsvStatement(
      input.buffer,
      input.targetType,
      input.filename,
      input.targetCurrency,
    )
    const learnedPeriod =
      statement.periodSource === 'activity'
        ? inferCoverageFromLearnedTemplates(
            input.filename,
            input.learnedCoverageTemplates,
          )
        : null
    const reliableLearnedPeriod =
      learnedPeriod &&
      (!statement.activityStart ||
        learnedPeriod.start <= statement.activityStart) &&
      (!statement.activityEnd || learnedPeriod.end >= statement.activityEnd)
        ? learnedPeriod
        : null
    result = {
      transactions: statement.transactions,
      parser: 'csv',
      documentKind:
        input.targetType === 'account' ? 'bank_statement' : 'card_statement',
      sourceTransactionCount: statement.sourceTransactionCount,
      controls: {
        openingBalanceCents: null,
        openingBalanceAt: null,
        closingBalanceCents: statement.closingBalanceCents,
        closingBalanceType:
          statement.closingBalanceCents === null
            ? null
            : input.targetType === 'card'
              ? 'card_statement'
              : 'posted',
        balanceAsOf: statement.balanceAsOf,
        dueDate: null,
      },
      coverage: {
        periodStart: reliableLearnedPeriod?.start ?? statement.periodStart,
        periodEnd: reliableLearnedPeriod?.end ?? statement.periodEnd,
        activityStart: statement.activityStart,
        activityEnd: statement.activityEnd,
        periodSource: reliableLearnedPeriod
          ? 'filename'
          : statement.periodSource,
        confidence: reliableLearnedPeriod
          ? 'high'
          : statement.coverageConfidence,
      },
      identity: {
        institution: null,
        lastFour: statement.detectedLastFour,
        currency: statement.detectedCurrency,
      },
      diagnostics: emptyDiagnostics(),
    }
  } else if (extension === 'pdf') {
    result = await readPdfStatement(input)
  } else {
    throw new Error('Envie um arquivo OFX, CSV ou PDF.')
  }

  try {
    assertStatementIdentity(result, input)
    if (!result.transactions.length) {
      throw new Error(
        extension === 'pdf' && !input.aiConsent
          ? 'Nenhuma transação foi reconhecida localmente. Autorize a IA para tentar este PDF.'
          : 'Nenhuma transação foi encontrada no arquivo.',
      )
    }
  } catch (error) {
    throw new StatementReadError(
      error instanceof Error
        ? error.message
        : 'Falha ao interpretar o arquivo.',
      result,
    )
  }
  return result
}
