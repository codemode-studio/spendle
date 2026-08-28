import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { evaluateImportAudit, summarizeImport } from '#/domain/import-audit'

import { parsePdfBufferWithAi, readStatement } from './statement-reader.server'

const fixtureDirectory = process.env.PDF_IMPORT_FIXTURE_DIR
const nubankFixturePath = process.env.NUBANK_PDF_FIXTURE_PATH
const interCardFixturePath = process.env.INTER_CARD_PDF_FIXTURE_PATH
const nubankCardFixturePath = process.env.NUBANK_CARD_PDF_FIXTURE_PATH
const runLiveAi = process.env.RUN_LIVE_AI_PDF_TESTS === '1'

function auditCardStatement(result: Awaited<ReturnType<typeof readStatement>>) {
  const summary = summarizeImport(
    result.transactions,
    result.sourceTransactionCount,
  )
  return evaluateImportAudit({
    targetType: 'card',
    sourceTransactionCount: summary.sourceTransactionCount,
    parsedTransactionCount: summary.parsedTransactionCount,
    invalidTransactionCount: summary.invalidTransactionCount,
    openingBalanceCents: result.controls.openingBalanceCents,
    openingBalanceAt: result.controls.openingBalanceAt,
    closingBalanceCents: result.controls.closingBalanceCents,
    balanceAsOf: result.controls.balanceAsOf,
    statementPeriodStart: result.coverage.periodStart,
    anchorBalanceCents: null,
    anchorBalanceAt: null,
    existingMovementCents: 0,
    newMovementCents: summary.netMovementCents,
    documentMovementCents: summary.netMovementCents,
  })
}

const fixtures = [
  {
    filename: 'pdf_260826105418.pdf',
    transactionCount: 37,
    openingBalanceCents: 110_081,
    closingBalanceCents: 61_815,
    sampleExternalId: '1743176264307',
    sampleTransactionCents: 48,
  },
  {
    filename: 'pdf_260826105450.pdf',
    transactionCount: 35,
    openingBalanceCents: 116_063,
    closingBalanceCents: 9_579,
    sampleExternalId: '1746071460019',
    sampleTransactionCents: 50,
  },
  {
    filename: 'pdf_260826105503.pdf',
    transactionCount: 39,
    openingBalanceCents: 61_815,
    closingBalanceCents: 116_063,
    sampleExternalId: '1744539409425',
    sampleTransactionCents: 29,
  },
]

describe.skipIf(!fixtureDirectory)('PDFs reais do Mercado Pago', () => {
  for (const fixture of fixtures) {
    it(`extrai Valor e não Saldo de ${fixture.filename}`, async () => {
      const buffer = await readFile(
        resolve(fixtureDirectory!, fixture.filename),
      )
      const result = await readStatement({
        buffer,
        filename: fixture.filename,
        targetType: 'account',
        targetCurrency: 'BRL',
        targetInstitution: 'Mercado Pago',
        targetIdentifiers: ['9508'],
        aiConsent: false,
        learnedCoverageTemplates: [],
      })

      expect(result.parser).toBe('pdf_inspector')
      expect(result.transactions).toHaveLength(fixture.transactionCount)
      expect(
        result.transactions.find(
          (transaction) => transaction.externalId === fixture.sampleExternalId,
        )?.amountCents,
      ).toBe(fixture.sampleTransactionCents)
      expect(result.controls).toMatchObject({
        openingBalanceCents: fixture.openingBalanceCents,
        closingBalanceCents: fixture.closingBalanceCents,
      })
      expect(
        fixture.openingBalanceCents +
          result.transactions.reduce(
            (total, transaction) => total + transaction.amountCents,
            0,
          ),
      ).toBe(fixture.closingBalanceCents)
    })

    it.skipIf(!runLiveAi)(
      `a IA usa Valor, não Saldo, em ${fixture.filename}`,
      async () => {
        const buffer = await readFile(
          resolve(fixtureDirectory!, fixture.filename),
        )
        const transactions = await parsePdfBufferWithAi(
          buffer,
          fixture.filename,
        )

        expect(transactions).toHaveLength(fixture.transactionCount)
        expect(
          transactions.find(
            (transaction) =>
              transaction.externalId === fixture.sampleExternalId,
          )?.amountCents,
        ).toBe(fixture.sampleTransactionCents)
        expect(
          fixture.openingBalanceCents +
            transactions.reduce(
              (total, transaction) => total + transaction.amountCents,
              0,
            ),
        ).toBe(fixture.closingBalanceCents)
      },
      180_000,
    )
  }
})

describe.skipIf(!nubankFixturePath)('PDF real do Nubank', () => {
  it('não confunde contrapartes com o emissor e reconcilia o período', async () => {
    const buffer = await readFile(nubankFixturePath!)
    const result = await readStatement({
      buffer,
      filename: 'NU_54686607_01AGO2026_23AGO2026.pdf',
      targetType: 'account',
      targetCurrency: 'BRL',
      targetInstitution: 'Nubank',
      targetIdentifiers: ['5468660-7'],
      aiConsent: false,
      learnedCoverageTemplates: [],
    })

    expect(result).toMatchObject({
      parser: 'pdf_inspector',
      documentKind: 'bank_statement',
      identity: {
        institution: 'Nubank',
        lastFour: '6607',
        currency: 'BRL',
      },
      controls: {
        openingBalanceCents: 10_130,
        closingBalanceCents: 2_607,
        balanceAsOf: '2026-08-23',
      },
      coverage: {
        periodStart: '2026-08-01',
        periodEnd: '2026-08-23',
        periodSource: 'metadata',
      },
    })
    expect(
      result.transactions.map((transaction) => transaction.amountCents),
    ).toEqual([158_649, -160_000, 2_500_000, -2_325_490, -173_289, -7_393])
    expect(
      result.controls.openingBalanceCents! +
        result.transactions.reduce(
          (total, transaction) => total + transaction.amountCents,
          0,
        ),
    ).toBe(result.controls.closingBalanceCents)
    expect(result.diagnostics.blockingReason).toBeNull()
  })
})

describe.skipIf(!interCardFixturePath)('fatura real do cartão Inter', () => {
  it('fecha compras, ciclo, vencimento e ignora o pagamento anterior', async () => {
    const buffer = await readFile(interCardFixturePath!)
    const result = await readStatement({
      buffer,
      filename: 'fatura-inter-2026-05.pdf',
      targetType: 'card',
      targetCurrency: 'BRL',
      targetInstitution: 'Inter',
      targetIdentifiers: ['3879', '1574'],
      aiConsent: false,
      learnedCoverageTemplates: [],
    })

    expect(result).toMatchObject({
      parser: 'pdf_inspector',
      parserId: 'inter/card-statement/v1',
      parserVersion: '1',
      documentKind: 'card_statement',
      sourceTransactionCount: 57,
      identity: {
        institution: 'Inter',
        lastFour: '3879',
        currency: 'BRL',
      },
      controls: {
        closingBalanceCents: 2_258_354,
        closingBalanceType: 'card_statement',
        balanceAsOf: '2026-05-08',
        dueDate: '2026-05-15',
      },
      coverage: {
        periodStart: '2026-04-09',
        periodEnd: '2026-05-08',
        periodSource: 'metadata',
        confidence: 'high',
      },
    })
    expect(result.transactions).toHaveLength(57)
    expect(
      result.transactions.reduce(
        (total, transaction) => total + transaction.amountCents,
        0,
      ),
    ).toBe(-2_258_354)
    expect(
      result.transactions.find((transaction) =>
        transaction.description.includes('CLINICA DR ROMAO'),
      ),
    ).toMatchObject({ postedAt: '2026-04-20', amountCents: -1_166_666 })
    expect(
      result.transactions.some((transaction) =>
        /pagamento on line/i.test(transaction.description),
      ),
    ).toBe(false)
    expect(result.diagnostics.blockingReason).toBeNull()
    expect(auditCardStatement(result)).toMatchObject({
      status: 'reconciled',
      expectedBalanceCents: 2_258_354,
      balanceDifferenceCents: 0,
    })
  })
})

describe.skipIf(!nubankCardFixturePath)('fatura real do cartão Nubank', () => {
  it('fecha compras, outros lançamentos e exclui o pagamento anterior', async () => {
    const buffer = await readFile(nubankCardFixturePath!)
    const result = await readStatement({
      buffer,
      filename: 'Nubank_2026-08-09.pdf',
      targetType: 'card',
      targetCurrency: 'BRL',
      targetInstitution: 'Nubank',
      targetIdentifiers: ['1889', '2923', '8590'],
      aiConsent: false,
      learnedCoverageTemplates: [],
    })

    expect(result).toMatchObject({
      parser: 'pdf_inspector',
      parserId: 'nubank/card-statement/v1',
      parserVersion: '1',
      documentKind: 'card_statement',
      sourceTransactionCount: 137,
      identity: {
        institution: 'Nubank',
        lastFour: '2923',
        currency: 'BRL',
      },
      controls: {
        closingBalanceCents: 2_325_490,
        closingBalanceType: 'card_statement',
        balanceAsOf: '2026-08-02',
        dueDate: '2026-08-10',
      },
      coverage: {
        periodStart: '2026-07-02',
        periodEnd: '2026-08-02',
        periodSource: 'metadata',
        confidence: 'high',
      },
    })
    expect(result.transactions).toHaveLength(137)
    expect(
      result.transactions.reduce(
        (total, transaction) => total + transaction.amountCents,
        0,
      ),
    ).toBe(-2_325_490)
    expect(
      result.transactions.find((transaction) =>
        transaction.description.startsWith('Pagamento*Estetica'),
      )?.amountCents,
    ).toBe(-28_500)
    expect(
      result.transactions.find(
        (transaction) => transaction.description === 'Plano NuCel',
      )?.amountCents,
    ).toBe(-7_000)
    expect(
      result.transactions.some((transaction) =>
        /^pagamento em\b/i.test(transaction.description),
      ),
    ).toBe(false)
    expect(result.diagnostics.blockingReason).toBeNull()
    expect(auditCardStatement(result)).toMatchObject({
      status: 'reconciled',
      expectedBalanceCents: 2_325_490,
      balanceDifferenceCents: 0,
    })
  })
})
