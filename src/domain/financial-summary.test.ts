import { describe, expect, it } from 'vitest'

import { buildFinancialSummary } from './financial-summary'

const base = {
  id: 'expense',
  postedAt: '2026-08-10',
  amountCents: -10_000,
  status: 'confirmed' as const,
  categoryId: 'food',
  bucket: 'essential',
  incomeBaseEligible: false,
  scopeType: 'person' as const,
  accountPurpose: 'operating' as const,
}

function summarize(
  overrides: Partial<Parameters<typeof buildFinancialSummary>[0]> = {},
) {
  return buildFinancialSummary({
    month: '2026-08',
    transactions: [base],
    splits: [],
    reconciliations: [],
    recurrenceActuals: [],
    investmentMovements: [],
    recurrenceCandidateTransactionIds: [],
    netWorthCents: 1_000_000,
    missingBalanceConversionCount: 0,
    missingRecurrenceConversionCount: 0,
    reviewImportCount: 0,
    overdueRecurrenceCount: 0,
    unverifiedBalanceCount: 0,
    ...overrides,
  })
}

describe('resumo financeiro único', () => {
  it('faz gastos baterem com essenciais mais estilo de vida e desconta estornos', () => {
    const result = summarize({
      transactions: [base, { ...base, id: 'refund', amountCents: 2_000 }],
    })
    expect(result.budgetActual.essential).toBe(8_000)
    expect(result.currentExpenseCents).toBe(8_000)
  })

  it('mantém impostos fora dos quatro envelopes da estratégia', () => {
    const result = summarize({
      transactions: [{ ...base, bucket: 'tax' }],
    })
    expect(result.currentExpenseCents).toBe(0)
    expect(result.budgetActual.essential).toBe(0)
    expect(result.budgetActual.lifestyle).toBe(0)
  })

  it('inclui apenas rendas elegíveis na renda familiar', () => {
    const result = summarize({
      transactions: [
        {
          ...base,
          id: 'salary',
          amountCents: 20_000,
          bucket: 'income',
          incomeBaseEligible: true,
        },
        {
          ...base,
          id: 'yield',
          amountCents: 900,
          bucket: 'income',
          incomeBaseEligible: false,
        },
      ],
    })
    expect(result.currentIncomeCents).toBe(20_000)
  })

  it('não duplica receita nas distribuições confirmadas entre PF e PJ', () => {
    const result = summarize({
      transactions: [
        {
          ...base,
          id: 'profit',
          amountCents: 25_000,
          categoryId: 'profit_distribution_income',
          bucket: 'income',
          incomeBaseEligible: true,
        },
      ],
      reconciliations: [
        {
          type: 'profit_distribution',
          status: 'confirmed',
          transactionIds: ['company-leg', 'profit'],
        },
      ],
    })
    expect(result.currentIncomeCents).toBe(0)
  })

  it('conta aporte uma vez pela posição vinculada à transação', () => {
    const result = summarize({
      transactions: [
        { ...base, id: 'source', categoryId: 'transfer', bucket: 'excluded' },
        {
          ...base,
          id: 'destination',
          amountCents: 10_000,
          categoryId: 'transfer',
          bucket: 'excluded',
        },
      ],
      investmentMovements: [
        {
          transactionId: 'destination',
          kind: 'contribution',
          baseAmountCents: 10_000,
          goalType: null,
        },
      ],
    })
    expect(result.budgetActual.investment).toBe(10_000)
    expect(result.currentExpenseCents).toBe(0)
  })

  it.each([
    ['contribution', null, 10_000, 0],
    ['withdrawal', null, -10_000, 0],
    ['contribution', 'emergency_reserve', 0, 10_000],
    ['withdrawal', 'emergency_reserve', 0, -10_000],
  ] as const)(
    'calcula %s conforme o objetivo da posição',
    (kind, goalType, investment, reserve) => {
      const result = summarize({
        transactions: [
          {
            ...base,
            id: 'movement',
            postedAt: '2026-08-01',
            amountCents: 10_000,
          },
        ],
        investmentMovements: [
          {
            transactionId: 'movement',
            kind,
            baseAmountCents: 10_000,
            goalType,
          },
        ],
      })
      expect(result.budgetActual).toMatchObject({ investment, reserve })
    },
  )

  it('não conta distribuição categorizada sem grupo confirmado', () => {
    const result = summarize({
      transactions: [
        {
          ...base,
          id: 'profit',
          amountCents: 25_000,
          categoryId: 'profit_distribution_income',
          bucket: 'income',
          incomeBaseEligible: true,
        },
      ],
    })
    expect(result.currentIncomeCents).toBe(0)
  })

  it('leva transações pendentes categorizadas ao projetado sem duplicar candidato recorrente', () => {
    const pending = {
      ...base,
      id: 'pending',
      status: 'pending' as const,
      amountCents: -5_000,
    }
    expect(summarize({ transactions: [pending] }).budgetPending.essential).toBe(
      5_000,
    )
    expect(
      summarize({
        transactions: [pending],
        recurrenceCandidateTransactionIds: ['pending'],
      }).budgetPending.essential,
    ).toBe(0)
  })

  it('não repete em agosto um pagamento recorrente empresarial de julho', () => {
    const result = summarize({
      transactions: [
        {
          ...base,
          id: 'company-payment',
          postedAt: '2026-07-10',
          scopeType: 'company_br',
        },
      ],
      recurrenceActuals: [
        {
          transactionId: 'company-payment',
          amountCents: 10_000,
          bucket: 'essential',
          categoryConflict: false,
        },
      ],
    })
    expect(result.budgetActual.essential).toBe(0)
  })

  it('bloqueia o fechamento quando existe recorrência vencida', () => {
    expect(summarize({ overdueRecurrenceCount: 1 }).integrity).toMatchObject({
      closingBlockerCount: 1,
    })
  })

  it('expõe recorrência empresarial sem conversão para a moeda-base', () => {
    const result = summarize({ missingRecurrenceConversionCount: 1 })
    expect(result.integrity.issues).toContainEqual({
      code: 'missing_base_conversion',
      count: 1,
      blocksClosing: true,
    })
  })

  it('não deixa conflito recorrente antigo bloquear o mês atual', () => {
    const result = summarize({
      transactions: [{ ...base, id: 'old', postedAt: '2026-07-10' }],
      recurrenceActuals: [
        {
          transactionId: 'old',
          amountCents: 10_000,
          bucket: 'essential',
          categoryConflict: true,
        },
      ],
    })
    expect(
      result.integrity.issues.find(
        (issue) => issue.code === 'recurrence_category_conflict',
      ),
    ).toBeUndefined()
  })

  it('marca o resumo parcial quando há despesa confirmada sem categoria', () => {
    const result = summarize({
      transactions: [
        { ...base, categoryId: 'uncategorized', bucket: 'excluded' },
      ],
    })
    expect(result.integrity).toMatchObject({
      partial: true,
      closingBlockerCount: 1,
    })
  })
})
