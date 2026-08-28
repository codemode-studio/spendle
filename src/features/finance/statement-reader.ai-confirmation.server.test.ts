import { beforeEach, describe, expect, it, vi } from 'vitest'

import { comparePdfExtractions, readStatement } from './statement-reader.server'

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  inspectPdfStatement: vi.fn(),
}))

vi.mock('./ai.server', () => ({
  getConfiguredAiModel: () => 'test-model',
}))

vi.mock('./pdf-inspector.server', () => ({
  inspectPdfStatement: mocks.inspectPdfStatement,
}))

vi.mock('ai', () => ({
  generateText: mocks.generateText,
  Output: { object: vi.fn(() => ({})) },
}))

vi.mock('pdf-parse', () => ({
  PDFParse: class {
    async getText() {
      return { text: '' }
    }

    async destroy() {}
  },
}))

const deterministicTransaction = {
  externalId: 'op-1',
  postedAt: '2026-08-07',
  description: 'Pix enviado Mercado Pago',
  amountCents: -7_393,
  currency: 'BRL',
  raw: { source: 'deterministic' },
}

function inspectionWith(transactions = [deterministicTransaction]) {
  return {
    transactions,
    sourceTransactionCount: transactions.length,
    identity: {
      institution: 'Nubank',
      kind: 'bank_statement' as const,
      lastFour: '6607',
      currency: 'BRL',
    },
    controls: {
      openingBalanceCents: 10_000,
      openingBalanceAt: '2026-08-01',
      closingBalanceCents: 2_607,
      closingBalanceType: 'posted' as const,
      balanceAsOf: '2026-08-23',
      dueDate: null,
      periodStart: '2026-08-01',
      periodEnd: '2026-08-23',
    },
    classification: {
      pdfType: 'digital',
      confidence: 1,
      pageCount: 1,
      pagesNeedingOcr: [],
      pagesWithTables: [1],
      pagesWithColumns: [1],
    },
    diagnostics: {
      layoutId: 'nubank/account-statement/v1',
      layoutVersion: '1',
      suspiciousTextLoss: false,
    },
    markdown: '',
    positionedItems: [],
  }
}

const baseInput = {
  buffer: Buffer.from('mock-pdf'),
  filename: 'nubank.pdf',
  targetType: 'account' as const,
  targetCurrency: 'BRL',
  targetInstitution: 'Nubank',
  targetIdentifiers: ['6607'],
  learnedCoverageTemplates: [],
}

function aiOutput(
  transaction: Omit<
    typeof deterministicTransaction,
    'raw'
  > = deterministicTransaction,
) {
  return {
    output: {
      transactions: [transaction],
    },
  }
}

describe('confirmação independente de PDF por IA', () => {
  beforeEach(() => {
    mocks.generateText.mockReset()
    mocks.inspectPdfStatement.mockReset()
    mocks.inspectPdfStatement.mockResolvedValue(inspectionWith())
  })

  it('mantém as transações determinísticas quando as duas extrações concordam', async () => {
    mocks.generateText.mockResolvedValue(
      aiOutput({
        externalId: 'op-1',
        postedAt: '2026-08-07',
        description: 'PIX ENVIADO\nMERCADO PAGO',
        amountCents: -7_393,
        currency: 'BRL',
      }),
    )

    const result = await readStatement({ ...baseInput, aiConsent: true })
    const diagnostics = JSON.parse(
      result.diagnostics.extractionDiagnosticsJson!,
    )

    expect(mocks.generateText).toHaveBeenCalledOnce()
    expect(result).toMatchObject({
      parser: 'pdf_inspector',
      parserId: 'nubank/account-statement/v1',
      parserVersion: '1',
      transactions: [
        expect.objectContaining({ raw: { source: 'deterministic' } }),
      ],
      diagnostics: { blockingReason: null },
    })
    expect(diagnostics.aiConfirmation).toMatchObject({
      status: 'agreement',
      deterministicTransactionCount: 1,
      aiTransactionCount: 1,
      missingFromAiCount: 0,
      unexpectedFromAiCount: 0,
    })
  })

  it('bloqueia a consolidação quando valor ou evidência da IA divergem', async () => {
    mocks.generateText.mockResolvedValue(
      aiOutput({
        externalId: 'op-diferente',
        postedAt: '2026-08-07',
        description: 'Saldo após a transação',
        amountCents: 2_607,
        currency: 'BRL',
      }),
    )

    const result = await readStatement({ ...baseInput, aiConsent: true })
    const diagnostics = JSON.parse(
      result.diagnostics.extractionDiagnosticsJson!,
    )

    expect(result.parser).toBe('pdf_inspector')
    expect(result.transactions).toEqual([deterministicTransaction])
    expect(result.diagnostics.blockingReason).toContain(
      'A confirmação por IA divergiu do parser determinístico',
    )
    expect(result.diagnostics.blockingReason).toContain('valores ou moedas')
    expect(result.diagnostics.blockingReason).toContain('descrições ou IDs')
    expect(diagnostics.aiConfirmation).toMatchObject({
      status: 'divergent',
      amountsMatch: false,
      descriptionsAndIdsMatch: false,
      missingFromAiCount: 1,
      unexpectedFromAiCount: 1,
    })
  })

  it('detecta divergência de data mesmo com o mesmo total e descrição', () => {
    const comparison = comparePdfExtractions(
      [deterministicTransaction],
      [{ ...deterministicTransaction, postedAt: '2026-08-08' }],
    )

    expect(comparison).toMatchObject({
      status: 'divergent',
      datesMatch: false,
      amountsMatch: true,
      dateAmountPairsMatch: false,
      descriptionsAndIdsMatch: true,
    })
  })

  it('bloqueia para revisão se a confirmação autorizada falhar', async () => {
    mocks.generateText.mockRejectedValue(new Error('serviço indisponível'))

    const result = await readStatement({ ...baseInput, aiConsent: true })
    const diagnostics = JSON.parse(
      result.diagnostics.extractionDiagnosticsJson!,
    )

    expect(result.parser).toBe('pdf_inspector')
    expect(result.transactions).toEqual([deterministicTransaction])
    expect(result.diagnostics.blockingReason).toContain(
      'A confirmação por IA não pôde ser concluída',
    )
    expect(diagnostics.aiConfirmation).toMatchObject({
      status: 'failed',
      deterministicTransactionCount: 1,
      aiTransactionCount: null,
      error: 'serviço indisponível',
    })
  })

  it('não chama a IA quando não há consentimento', async () => {
    const result = await readStatement({ ...baseInput, aiConsent: false })
    const diagnostics = JSON.parse(
      result.diagnostics.extractionDiagnosticsJson!,
    )

    expect(mocks.generateText).not.toHaveBeenCalled()
    expect(result.diagnostics.blockingReason).toBeNull()
    expect(diagnostics.aiConfirmation.status).toBe('not_requested')
  })

  it('mantém o fallback por IA quando o parser determinístico não extrai nada', async () => {
    mocks.inspectPdfStatement.mockResolvedValue(inspectionWith([]))
    mocks.generateText.mockResolvedValue(aiOutput())

    const result = await readStatement({ ...baseInput, aiConsent: true })
    const diagnostics = JSON.parse(
      result.diagnostics.extractionDiagnosticsJson!,
    )

    expect(result.parser).toBe('pdf_ai')
    expect(result.transactions).toHaveLength(1)
    expect(result.diagnostics.blockingReason).toContain(
      'não possui prova posicional completa',
    )
    expect(diagnostics.aiConfirmation.status).toBe('fallback_unverified')
  })
})
