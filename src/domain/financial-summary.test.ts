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

  it('conta a ponta familiar de uma distribuição de lucros confirmada', () => {
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
    expect(result.currentIncomeCents).toBe(25_000)
  })

  it('conta aporte uma vez pelo destino de uma transferência confirmada', () => {
    const result = summarize({
      transactions: [
        { ...base, id: 'source', categoryId: 'transfer', bucket: 'excluded' },
        {
          ...base,
          id: 'destination',
          amountCents: 10_000,
          categoryId: 'transfer',
          bucket: 'excluded',
          accountPurpose: 'investment',
        },
      ],
      reconciliations: [
        {
          type: 'transfer',
          status: 'confirmed',
          transactionIds: ['source', 'destination'],
        },
      ],
    })
    expect(result.budgetActual.investment).toBe(10_000)
    expect(result.currentExpenseCents).toBe(0)
  })

  it.each([
    ['operating', 'investment', 10_000, 0],
    ['investment', 'operating', -10_000, 0],
    ['operating', 'reserve', 0, 10_000],
    ['reserve', 'operating', 0, -10_000],
    ['reserve', 'investment', 10_000, -10_000],
    ['investment', 'reserve', -10_000, 10_000],
    ['investment', 'investment', 0, 0],
  ] as const)(
    'calcula a transição líquida %s → %s',
    (sourcePurpose, destinationPurpose, investment, reserve) => {
      const result = summarize({
        transactions: [
          {
            ...base,
            id: 'source',
            postedAt: '2026-07-31',
            accountPurpose: sourcePurpose,
          },
          {
            ...base,
            id: 'destination',
            postedAt: '2026-08-01',
            amountCents: 10_000,
            accountPurpose: destinationPurpose,
          },
        ],
        reconciliations: [
          {
            type: 'transfer',
            status: 'confirmed',
            transactionIds: ['source', 'destination'],
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
