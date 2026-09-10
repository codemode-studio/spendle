import type * as PdfInspector from '@firecrawl/pdf-inspector'
import type * as PdfParserRegistry from './pdf-parsers/registry.server'
import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { inspectPdfStatement } from './pdf-inspector.server'
import { readStatement } from './statement-reader.server'

const extraction = vi.hoisted(() => ({
  dropPositions: false,
  unknownLayout: false,
}))

vi.mock('@firecrawl/pdf-inspector', async (importOriginal) => {
  const original = await importOriginal<typeof PdfInspector>()
  return {
    ...original,
    extractPagesMarkdownAsync: async (
      ...args: Parameters<typeof original.extractPagesMarkdownAsync>
    ) => {
      const result = await original.extractPagesMarkdownAsync(...args)
      return {
        ...result,
        pages: result.pages.map((page) => ({ ...page, markdown: '' })),
      }
    },
    extractTextWithPositions: (
      ...args: Parameters<typeof original.extractTextWithPositions>
    ) =>
      extraction.dropPositions
        ? []
        : original.extractTextWithPositions(...args),
  }
})

vi.mock('./pdf-parsers/registry.server', async (importOriginal) => {
  const original = await importOriginal<typeof PdfParserRegistry>()
  return {
    ...original,
    selectPdfStatementParser: (
      ...args: Parameters<typeof original.selectPdfStatementParser>
    ) =>
      extraction.unknownLayout
        ? null
        : original.selectPdfStatementParser(...args),
  }
})

async function readFixture() {
  return readStatement({
    buffer: await readFile(
      new URL('./fixtures/synthetic-mercado-pago.pdf', import.meta.url),
    ),
    filename: 'synthetic-mercado-pago.pdf',
    targetType: 'account',
    targetCurrency: 'BRL',
    targetInstitution: 'Mercado Pago',
    targetIdentifiers: [],
    aiConsent: false,
    learnedCoverageTemplates: [],
  })
}

afterEach(() => {
  extraction.dropPositions = false
  extraction.unknownLayout = false
})

describe('perda de Markdown com parser institucional', () => {
  it('aceita extração posicionada completa e reconciliada mesmo sem Markdown', async () => {
    const result = await readFixture()
    expect(result.transactions.map((row) => row.amountCents)).toEqual([
      100_000, -10_000,
    ])
    expect(result.diagnostics.blockingReason).toBeNull()
  })

  it('mantém o bloqueio por perda de Markdown para layouts desconhecidos', async () => {
    extraction.unknownLayout = true
    const result = await inspectPdfStatement(
      await readFile(
        new URL('./fixtures/synthetic-mercado-pago.pdf', import.meta.url),
      ),
      'account',
    )
    expect(result.diagnostics.layoutId).toBeNull()
    expect(result.diagnostics.suspiciousTextLoss).toBe(true)
  })

  it('continua rejeitando a perda de lançamentos na extração posicionada', async () => {
    extraction.dropPositions = true
    await expect(readFixture()).rejects.toThrow()
  })
})
