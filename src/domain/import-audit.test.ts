import { describe, expect, it } from 'vitest'

import {
  canCommitImportAudit,
  evaluateImportAudit,
  identifyDuplicateReasons,
  summarizeImport,
} from './import-audit'

describe('auditoria de importação', () => {
  it('permite aviso somente depois da confirmação manual', () => {
    expect(canCommitImportAudit('warning', false)).toBe(false)
    expect(canCommitImportAudit('warning', true)).toBe(true)
    expect(canCommitImportAudit('reconciled', false)).toBe(true)
    expect(canCommitImportAudit('divergent', true)).toBe(false)
  })

  it('preserva duas compras legítimas idênticas no mesmo arquivo', () => {
    expect(
      identifyDuplicateReasons(
        [
          { fingerprint: 'same', externalId: null },
          { fingerprint: 'same', externalId: null },
        ],
        [],
      ),
    ).toEqual([null, null])
  })

  it('deduplica sobreposição por multiplicidade sem perder repetição legítima', () => {
    expect(
      identifyDuplicateReasons(
        [
          { fingerprint: 'same', externalId: null },
          { fingerprint: 'same', externalId: null },
        ],
        [{ fingerprint: 'same', externalId: null }],
      ),
    ).toEqual(['fingerprint_overlap', null])
  })

  it('prioriza o identificador bancário para duplicidade', () => {
    expect(
      identifyDuplicateReasons(
        [{ fingerprint: 'new-description', externalId: 'fit-1' }],
        [{ fingerprint: 'old-description', externalId: 'fit-1' }],
      ),
    ).toEqual(['external_id'])
  })

  it('deduplica evidência exata entre fontes com e sem identificador', () => {
    expect(
      identifyDuplicateReasons(
        [{ fingerprint: 'same', externalId: null }],
        [{ fingerprint: 'same', externalId: 'bank-123' }],
      ),
    ).toEqual(['fingerprint_overlap'])
    expect(
      identifyDuplicateReasons(
        [{ fingerprint: 'same', externalId: 'new-bank-id' }],
        [{ fingerprint: 'same', externalId: null }],
      ),
    ).toEqual(['fingerprint_overlap'])
  })

  it('preserva compras idênticas com identificadores bancários distintos', () => {
    expect(
      identifyDuplicateReasons(
        [{ fingerprint: 'same', externalId: 'E2' }],
        [{ fingerprint: 'same', externalId: 'E1' }],
      ),
    ).toEqual([null])
    expect(
      identifyDuplicateReasons(
        [
          { fingerprint: 'same', externalId: null },
          { fingerprint: 'same', externalId: 'E2' },
        ],
        [
          { fingerprint: 'same', externalId: 'E1' },
          { fingerprint: 'same', externalId: null },
        ],
      ),
    ).toEqual(['fingerprint_overlap', 'fingerprint_overlap'])
    expect(
      identifyDuplicateReasons(
        [
          { fingerprint: 'same', externalId: 'E2' },
          { fingerprint: 'same', externalId: null },
        ],
        [
          { fingerprint: 'same', externalId: 'E1' },
          { fingerprint: 'same', externalId: null },
        ],
      ),
    ).toEqual(['fingerprint_overlap', 'fingerprint_overlap'])
  })

  it('calcula os totais de controle sem misturar sinais', () => {
    expect(
      summarizeImport(
        [
          { postedAt: '2026-08-02', amountCents: -2_500 },
          { postedAt: '2026-08-01', amountCents: 10_000 },
        ],
        2,
      ),
    ).toMatchObject({
      parsedTransactionCount: 2,
      invalidTransactionCount: 0,
      periodStart: '2026-08-01',
      periodEnd: '2026-08-02',
      totalCreditsCents: 10_000,
      totalDebitsCents: 2_500,
      netMovementCents: 7_500,
    })
  })

  it('bloqueia uma diferença de saldo comprovável', () => {
    expect(
      evaluateImportAudit({
        targetType: 'account',
        sourceTransactionCount: 1,
        parsedTransactionCount: 1,
        invalidTransactionCount: 0,
        openingBalanceCents: null,
        openingBalanceAt: null,
        closingBalanceCents: 12_000,
        balanceAsOf: '2026-08-02',
        statementPeriodStart: '2026-08-01',
        anchorBalanceCents: 10_000,
        anchorBalanceAt: '2026-07-31',
        existingMovementCents: 0,
        newMovementCents: 1_000,
      }),
    ).toMatchObject({
      status: 'divergent',
      expectedBalanceCents: 11_000,
      balanceDifferenceCents: 1_000,
    })
  })

  it('bloqueia saldo inicial que contradiz o checkpoint na mesma data', () => {
    expect(
      evaluateImportAudit({
        targetType: 'account',
        sourceTransactionCount: 1,
        parsedTransactionCount: 1,
        invalidTransactionCount: 0,
        openingBalanceCents: 200_000,
        openingBalanceAt: '2026-08-01',
        closingBalanceCents: 190_000,
        balanceAsOf: '2026-08-31',
        statementPeriodStart: '2026-08-01',
        anchorBalanceCents: 100_000,
        anchorBalanceAt: '2026-07-31',
        existingMovementCents: 0,
        newMovementCents: -10_000,
        documentMovementCents: -10_000,
      }),
    ).toMatchObject({
      status: 'divergent',
      expectedBalanceCents: 100_000,
      balanceDifferenceCents: 100_000,
    })
  })

  it('reconcilia internamente o documento com todas as linhas, inclusive duplicatas do razão', () => {
    expect(
      evaluateImportAudit({
        targetType: 'account',
        sourceTransactionCount: 1,
        parsedTransactionCount: 1,
        invalidTransactionCount: 0,
        openingBalanceCents: 100_000,
        openingBalanceAt: '2026-07-31',
        closingBalanceCents: 90_000,
        balanceAsOf: '2026-08-31',
        statementPeriodStart: '2026-08-01',
        anchorBalanceCents: 100_000,
        anchorBalanceAt: '2026-07-31',
        existingMovementCents: -10_000,
        newMovementCents: 0,
        documentMovementCents: -10_000,
      }),
    ).toMatchObject({
      status: 'reconciled',
      expectedBalanceCents: 90_000,
      balanceDifferenceCents: 0,
    })
  })

  it('estabelece o primeiro ponto de controle com OFX estrutural completo', () => {
    expect(
      evaluateImportAudit({
        targetType: 'account',
        sourceTransactionCount: 2,
        parsedTransactionCount: 2,
        invalidTransactionCount: 0,
        openingBalanceCents: null,
        openingBalanceAt: null,
        closingBalanceCents: 25_000,
        balanceAsOf: '2026-06-30',
        statementPeriodStart: '2026-06-01',
        anchorBalanceCents: null,
        anchorBalanceAt: null,
        existingMovementCents: 0,
        newMovementCents: 5_000,
      }),
    ).toMatchObject({
      status: 'imported',
      balanceDifferenceCents: null,
    })
  })

  it('reconcilia a fatura pelo total de compras e créditos', () => {
    expect(
      evaluateImportAudit({
        targetType: 'card',
        sourceTransactionCount: null,
        parsedTransactionCount: 3,
        invalidTransactionCount: 0,
        openingBalanceCents: null,
        openingBalanceAt: null,
        closingBalanceCents: 18_000,
        balanceAsOf: '2026-06-09',
        statementPeriodStart: '2026-05-10',
        anchorBalanceCents: null,
        anchorBalanceAt: null,
        existingMovementCents: 0,
        newMovementCents: -18_000,
      }),
    ).toMatchObject({
      status: 'reconciled',
      expectedBalanceCents: 18_000,
      balanceDifferenceCents: 0,
    })
  })

  it('explica a ação necessária quando o arquivo não informa saldo final', () => {
    expect(
      evaluateImportAudit({
        targetType: 'account',
        sourceTransactionCount: 2,
        parsedTransactionCount: 2,
        invalidTransactionCount: 0,
        openingBalanceCents: null,
        openingBalanceAt: null,
        closingBalanceCents: null,
        balanceAsOf: null,
        statementPeriodStart: '2026-08-01',
        anchorBalanceCents: null,
        anchorBalanceAt: null,
        existingMovementCents: 0,
        newMovementCents: 5_000,
      }),
    ).toMatchObject({
      status: 'imported',
      message:
        'Todos os lançamentos foram lidos. O arquivo não informa saldo final; confirme um saldo datado na conta para iniciar a reconciliação.',
    })
  })
})
