import { describe, expect, it } from 'vitest'

import {
  canCommitImportAudit,
  classifyImportReviewGuidance,
  getEffectiveImportValidationState,
  evaluateImportAudit,
  getImportBalanceReview,
  getImportCoverageProvenance,
  identifyDuplicateReasons,
  nextValidationState,
  summarizeImport,
  hasImportDestinationConflict,
} from './import-audit'
import type {
  ImportAuditReasonCode,
  ImportReviewGuidanceInput,
} from './import-audit'

const baseGuidanceInput: ImportReviewGuidanceInput = {
  targetType: 'account',
  parser: 'csv',
  validationStatus: 'divergent',
  reasonCode: null,
  validationMessage: null,
  parsedTransactionCount: 2,
  sourceTransactionCount: 2,
  closingBalanceCents: null,
  balanceDifferenceCents: null,
  invalidTransactionCount: 0,
  conflictReasonCode: null,
  hasPendingCorrection: false,
  hasStatementMatchCandidates: false,
  hasMissingStatementTransactions: false,
  hasBalanceConflict: false,
}

describe('auditoria de importação', () => {
  it('permite aviso somente depois da confirmação manual', () => {
    expect(canCommitImportAudit('warning', false)).toBe(false)
    expect(canCommitImportAudit('warning', true)).toBe(true)
    expect(canCommitImportAudit('reconciled', false)).toBe(true)
    expect(canCommitImportAudit('divergent', true)).toBe(false)
  })

  it.each([
    [
      'arquivo idêntico legado',
      {
        validationStatus: 'divergent' as const,
        validationReason: null,
        validationMessage:
          'O mesmo arquivo já foi associado a outro destino. O lote foi bloqueado.',
      },
      'identical_file',
    ],
    [
      'documento de cartão ligado a uma conta',
      {
        validationStatus: 'divergent' as const,
        validationReason: null,
        validationMessage: null,
        accountId: 'account-1',
        documentKind: 'card_statement' as const,
      },
      'destination_conflict',
    ],
    [
      'arquivo idêntico vivo sobre motivo pronto persistido',
      {
        validationStatus: 'imported' as const,
        validationReason: 'ready' as const,
        validationMessage:
          'O mesmo arquivo já foi associado a outro destino. O lote foi bloqueado.',
      },
      'identical_file',
    ],
    [
      'extração com página em OCR',
      {
        validationStatus: 'divergent' as const,
        validationReason: null,
        validationMessage: null,
        parser: 'pdf_inspector' as const,
        pagesNeedingOcrJson: '[2]',
      },
      'blocked',
    ],
    [
      'diferença de saldo',
      {
        validationStatus: 'divergent' as const,
        validationReason: null,
        validationMessage: null,
        balanceDifferenceCents: 500,
      },
      'balance_mismatch',
    ],
  ])('deriva o motivo efetivo de %s', (_, row, expected) => {
    const state = getEffectiveImportValidationState(row)
    const canRemediate = expected === 'balance_mismatch'
    expect(state).toMatchObject({
      reason: expected,
      committable: false,
      remediation: {
        links: canRemediate,
        exclusions: canRemediate,
        checkpointReplacement: canRemediate,
      },
    })
  })

  describe('orientação da revisão', () => {
    const cases: Array<{
      name: string
      input: Partial<ImportReviewGuidanceInput>
      expectedKind: ImportAuditReasonCode
      expected?: Record<string, unknown>
    }> = [
      {
        name: 'pronto após reconciliação',
        input: { validationStatus: 'reconciled' },
        expectedKind: 'ready',
        expected: { mode: 'reconciled' },
      },
      {
        name: 'pronto para importação com saldo',
        input: {
          validationStatus: 'imported',
          closingBalanceCents: 10_000,
        },
        expectedKind: 'ready',
        expected: { mode: 'imported' },
      },
      {
        name: 'saldo pendente em importação aceita',
        input: { validationStatus: 'imported' },
        expectedKind: 'needs_balance',
        expected: { mode: 'imported', sourceType: 'csv' },
      },
      {
        name: 'saldo pendente com revisão manual',
        input: {
          targetType: 'card',
          parser: 'ofx',
          validationStatus: 'warning',
        },
        expectedKind: 'needs_balance',
        expected: { mode: 'manual_review', sourceType: 'ofx' },
      },
      {
        name: 'revisão manual por contagem não confiável',
        input: {
          validationStatus: 'warning',
          closingBalanceCents: 10_000,
          sourceTransactionCount: null,
        },
        expectedKind: 'needs_manual_review',
        expected: { reason: 'unreliable_count' },
      },
      {
        name: 'correção bancária pendente',
        input: { hasPendingCorrection: true },
        expectedKind: 'pending_correction',
      },
      {
        name: 'arquivo idêntico usado em outro destino',
        input: {
          validationMessage: 'Mensagem de exibição sem palavras especiais.',
          conflictReasonCode: 'identical_file',
        },
        expectedKind: 'identical_file',
      },
      {
        name: 'documento incompatível com o destino',
        input: {
          validationMessage: 'Mensagem de exibição sem palavras especiais.',
          conflictReasonCode: 'destination_conflict',
        },
        expectedKind: 'destination_conflict',
      },
      {
        name: 'lançamentos ausentes na fatura',
        input: { hasMissingStatementTransactions: true },
        expectedKind: 'missing_statement_transactions',
      },
      {
        name: 'candidatos de vínculo da fatura',
        input: { hasStatementMatchCandidates: true },
        expectedKind: 'statement_match_candidates',
      },
      {
        name: 'linhas inválidas',
        input: { invalidTransactionCount: 3 },
        expectedKind: 'invalid_rows',
        expected: { invalidTransactionCount: 3 },
      },
      {
        name: 'diferença de saldo',
        input: { balanceDifferenceCents: -500 },
        expectedKind: 'balance_mismatch',
        expected: { balanceDifferenceCents: -500 },
      },
      {
        name: 'bloqueio sem regra mais específica',
        input: {
          validationMessage:
            'Este arquivo idêntico menciona outro destino apenas para exibição.',
        },
        expectedKind: 'blocked',
      },
    ]
    const allKinds = {
      ready: true,
      needs_balance: true,
      needs_manual_review: true,
      pending_correction: true,
      identical_file: true,
      destination_conflict: true,
      missing_statement_transactions: true,
      statement_match_candidates: true,
      invalid_rows: true,
      balance_mismatch: true,
      blocked: true,
    } satisfies Record<ImportAuditReasonCode, true>

    it.each(cases)('$name', ({ input, expectedKind, expected }) => {
      const guidance = classifyImportReviewGuidance({
        ...baseGuidanceInput,
        ...input,
      })

      expect(guidance).toMatchObject({ kind: expectedKind, ...expected })
    })

    it('cobre todos os tipos de orientação', () => {
      expect(new Set(cases.map((item) => item.expectedKind))).toEqual(
        new Set(Object.keys(allKinds)),
      )
    })

    it.each([
      ['blocked', 'reconciled'],
      ['identical_file', 'imported'],
      ['destination_conflict', 'reconciled'],
    ] as const)(
      'mantém o bloqueio %s mesmo com status %s',
      (validationReason, validationStatus) => {
        expect(
          getEffectiveImportValidationState({
            accountId: 'account-1',
            validationReason,
            validationStatus,
            validationMessage: null,
          }),
        ).toMatchObject({
          reason: validationReason,
          committable: false,
          remediation: {
            links: false,
            exclusions: false,
            checkpointReplacement: false,
          },
        })
      },
    )

    it('bloqueia um destino incompatível mesmo com motivo pronto persistido', () => {
      expect(
        getEffectiveImportValidationState(
          {
            accountId: 'account-1',
            validationReason: 'ready',
            validationStatus: 'imported',
            validationMessage: null,
          },
          { hasDestinationConflict: true },
        ),
      ).toMatchObject({
        status: 'divergent',
        reason: 'destination_conflict',
        committable: false,
        remediation: {
          links: false,
          exclusions: false,
          checkpointReplacement: false,
        },
      })
    })

    it.each([
      'statement_match_candidates',
      'needs_manual_review',
      'needs_balance',
      'balance_mismatch',
    ] as const)(
      'libera o motivo corrigível %s após conciliação',
      (validationReason) => {
        expect(
          getEffectiveImportValidationState({
            accountId: 'account-1',
            validationReason,
            validationStatus: 'reconciled',
            validationMessage: null,
          }),
        ).toMatchObject({
          reason: 'ready',
          committable: true,
          remediation: {
            links: true,
            exclusions: true,
            checkpointReplacement: true,
          },
        })
      },
    )

    it.each(['pending_correction', null] as const)(
      'pede saldo após aceitar importação com motivo anterior %s',
      (validationReason) => {
        expect(
          getEffectiveImportValidationState({
            accountId: 'account-1',
            validationReason,
            validationStatus: 'imported',
            validationMessage: null,
            closingBalanceCents: null,
          }),
        ).toMatchObject({ reason: 'needs_balance', committable: true })
      },
    )

    it('mostra candidatos encontrados para lançamentos antes ausentes', () => {
      expect(
        getEffectiveImportValidationState(
          {
            creditCardId: 'card-1',
            validationReason: 'missing_statement_transactions',
            validationStatus: 'divergent',
            validationMessage: null,
          },
          { hasStatementMatchCandidates: true },
        ),
      ).toMatchObject({
        reason: 'statement_match_candidates',
        committable: false,
        remediation: {
          links: true,
          exclusions: true,
          checkpointReplacement: true,
        },
      })
    })

    it.each(['blocked', 'identical_file', 'destination_conflict'] as const)(
      'mantém o bloqueio forte %s durante uma reavaliação lateral',
      (validationReason) => {
        expect(
          nextValidationState({
            current: {
              validationStatus: 'divergent',
              validationReason,
              validationMessage: 'Motivo original do bloqueio.',
            },
            evaluated: {
              validationStatus: 'imported',
              validationReason: 'needs_balance',
              validationMessage: 'A reavaliação aceitaria o lote.',
            },
          }),
        ).toEqual({
          validationStatus: 'divergent',
          validationReason,
          validationMessage: 'Motivo original do bloqueio.',
        })
      },
    )

    it('permite que motivos corrigíveis avancem após reavaliação', () => {
      expect(
        nextValidationState({
          current: {
            validationStatus: 'divergent',
            validationReason: 'missing_statement_transactions',
            validationMessage: 'Ainda faltam lançamentos.',
          },
          evaluated: {
            validationStatus: 'imported',
            validationReason: 'needs_balance',
            validationMessage: 'Falta apenas o total de fechamento.',
          },
        }),
      ).toEqual({
        validationStatus: 'imported',
        validationReason: 'needs_balance',
        validationMessage: 'Falta apenas o total de fechamento.',
      })
    })

    it('preserva uma diferença de saldo desconhecida na orientação', () => {
      expect(
        classifyImportReviewGuidance({
          ...baseGuidanceInput,
          reasonCode: 'balance_mismatch',
          balanceDifferenceCents: null,
        }),
      ).toMatchObject({
        kind: 'balance_mismatch',
        balanceDifferenceCents: null,
      })
    })

    it('prioriza linhas inválidas antes de diferenças da fatura', () => {
      expect(
        classifyImportReviewGuidance({
          ...baseGuidanceInput,
          invalidTransactionCount: 2,
          hasStatementMatchCandidates: true,
          hasMissingStatementTransactions: true,
        }),
      ).toMatchObject({
        kind: 'invalid_rows',
        invalidTransactionCount: 2,
      })
    })

    it('distingue período declarado confiável de mera atividade', () => {
      expect(
        getImportCoverageProvenance({
          source: 'filename',
          periodStart: '2026-08-01',
          periodEnd: '2026-08-31',
        }),
      ).toEqual({
        source: 'filename',
        evidence: 'declared_period',
        reliable: true,
      })
      expect(
        getImportCoverageProvenance({
          source: 'activity',
          periodStart: '2026-08-03',
          periodEnd: '2026-08-20',
        }),
      ).toEqual({
        source: 'activity',
        evidence: 'activity_only',
        reliable: false,
      })
    })

    it('estrutura o estado de saldo sem produzir texto de interface', () => {
      expect(
        getImportBalanceReview({
          targetType: 'account',
          closingBalanceCents: null,
          balanceDifferenceCents: null,
        }),
      ).toEqual({ kind: 'missing', targetType: 'account' })
      expect(
        getImportBalanceReview({
          targetType: 'card',
          closingBalanceCents: 10_000,
          balanceDifferenceCents: 500,
        }),
      ).toEqual({ kind: 'difference', differenceCents: 500 })
    })
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
      reasonCode: 'balance_mismatch',
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
      reasonCode: 'ready',
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
      reasonCode: 'needs_balance',
      status: 'imported',
      message:
        'Todos os lançamentos foram lidos. O arquivo não informa saldo final; confirme um saldo datado na conta para iniciar a reconciliação.',
    })
  })
})

describe('hasImportDestinationConflict', () => {
  it('treats an unmatchable detected identifier as a conflict, like the original guard', () => {
    expect(
      hasImportDestinationConflict(
        { detectedInstitution: null, detectedLastFour: '12' },
        { targetInstitutionName: null, targetIdentifiers: ['1234'] },
      ),
    ).toBe(true)
  })

  it('does not conflict when the detected last four matches a target identifier', () => {
    expect(
      hasImportDestinationConflict(
        { detectedInstitution: null, detectedLastFour: '•••• 1234' },
        { targetInstitutionName: null, targetIdentifiers: ['xx1234'] },
      ),
    ).toBe(false)
  })
})
