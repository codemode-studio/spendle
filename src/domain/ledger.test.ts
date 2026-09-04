import { describe, expect, it } from 'vitest'

import type { FamilyTransaction, LedgerSnapshot } from './ledger'
import {
  baseAmount,
  familyTransactions,
  fullPeriod,
  internalTransferIds,
  isBudgetSpendingBucket,
  isFamilyScope,
  isSpending,
  ledgerSpan,
  recurrenceMatchedIds,
  spendingByCategory,
} from './ledger'

function entry(
  id: string,
  postedAt: string,
  amountCents: number,
  overrides: Partial<FamilyTransaction> = {},
): FamilyTransaction {
  return {
    id: `${id}-${postedAt}`,
    postedAt,
    description: id,
    normalized: id,
    amountCents,
    categoryId: id,
    categoryName: id,
    color: '#123456',
    bucket: 'essential',
    source: 'account',
    uncategorized: false,
    ...overrides,
  }
}

function snapshot(): LedgerSnapshot {
  return {
    scopes: [
      { id: 'family', type: 'person' },
      { id: 'company', type: 'company_br' },
    ],
    transactions: [],
    reconciliations: [],
    recurrences: [],
  }
}

describe('predicados do razão familiar', () => {
  it('aceita escopos da família e rejeita as duas empresas', () => {
    expect(isFamilyScope(null)).toBe(true)
    expect(isFamilyScope('household')).toBe(true)
    expect(isFamilyScope({ type: 'person' })).toBe(true)
    expect(isFamilyScope('company_br')).toBe(false)
    expect(isFamilyScope({ type: 'company_us' })).toBe(false)
  })

  it.each(['essential', 'lifestyle', 'tax'])(
    'trata %s como gasto analítico',
    (bucket) => {
      expect(isSpending(entry(bucket, '2026-08-01', -1_000, { bucket }))).toBe(
        true,
      )
    },
  )

  it('mantém imposto fora dos envelopes do orçamento', () => {
    expect(isBudgetSpendingBucket('essential')).toBe(true)
    expect(isBudgetSpendingBucket('lifestyle')).toBe(true)
    expect(isBudgetSpendingBucket('tax')).toBe(false)
  })

  it('rejeita entradas, aportes, créditos e linhas sem categoria', () => {
    expect(isSpending(entry('income', '2026-08-01', 1_000))).toBe(false)
    expect(
      isSpending(entry('reserve', '2026-08-01', -1_000, { bucket: 'reserve' })),
    ).toBe(false)
    expect(
      isSpending(
        entry('uncategorized', '2026-08-01', -1_000, {
          categoryId: null,
          bucket: null,
          uncategorized: true,
        }),
      ),
    ).toBe(false)
  })
})

describe('valor-base e exclusões', () => {
  it('prefere o valor-base e só usa o valor original como fallback em BRL', () => {
    expect(
      baseAmount({
        baseAmountCents: 550,
        currency: 'USD',
        amountCents: 100,
      }),
    ).toBe(550)
    expect(
      baseAmount({ baseAmountCents: null, currency: 'BRL', amountCents: 100 }),
    ).toBe(100)
    expect(
      baseAmount({ baseAmountCents: null, currency: 'USD', amountCents: 100 }),
    ).toBeNull()
  })

  it('reúne apenas transferências e pagamentos confirmados', () => {
    const data = snapshot()
    data.reconciliations = [
      {
        status: 'confirmed',
        type: 'transfer',
        links: [{ transactionId: 'transfer' }],
      },
      {
        status: 'confirmed',
        type: 'refund',
        links: [{ transactionId: 'refund' }],
      },
      {
        status: 'suggested',
        type: 'card_payment',
        links: [{ transactionId: 'suggested' }],
      },
    ]
    expect([...internalTransferIds(data)]).toEqual(['transfer'])
  })

  it('reúne somente vínculos de recorrência aceitos', () => {
    const data = snapshot()
    data.recurrences = [
      {
        occurrences: [
          {
            matches: [
              { transactionId: 'confirmed', status: 'confirmed' },
              { transactionId: 'automatic', status: 'auto_confirmed' },
              { transactionId: 'suggested', status: 'suggested' },
            ],
          },
        ],
      },
    ]
    expect([...recurrenceMatchedIds(data)]).toEqual(['confirmed', 'automatic'])
  })

  it('achata somente lançamentos confirmados que pertencem à família', () => {
    const data = snapshot()
    const transaction = (
      id: string,
      overrides: Partial<LedgerSnapshot['transactions'][number]> = {},
    ): LedgerSnapshot['transactions'][number] => ({
      id,
      postedAt: '2026-08-10',
      description: id,
      normalizedDescription: id,
      amountCents: -1_000,
      baseAmountCents: null,
      currency: 'BRL',
      status: 'confirmed',
      counterpartyAccountId: null,
      creditCardId: null,
      account: { ownershipScopeId: 'family' },
      creditCard: null,
      category: {
        id: 'food',
        name: 'Alimentação',
        color: '#123456',
        bucket: 'essential',
      },
      ...overrides,
    })
    data.transactions = [
      transaction('kept'),
      transaction('company', { account: { ownershipScopeId: 'company' } }),
      transaction('pending', { status: 'pending' }),
      transaction('counterparty', { counterpartyAccountId: 'other-account' }),
      transaction('business', {
        category: {
          id: 'business',
          name: 'Empresa',
          color: '#000000',
          bucket: 'business',
        },
      }),
      transaction('foreign', { currency: 'USD' }),
      transaction('uncategorized', { category: null }),
      transaction('transfer'),
    ]
    data.reconciliations = [
      {
        status: 'confirmed',
        type: 'card_payment',
        links: [{ transactionId: 'transfer' }],
      },
    ]

    expect(familyTransactions(data).map((item) => item.id)).toEqual([
      'kept',
      'uncategorized',
    ])
    expect(familyTransactions(data)[1]).toMatchObject({
      categoryId: null,
      categoryName: 'Sem categoria',
      uncategorized: true,
    })
  })
})

describe('gastos por categoria', () => {
  it('compara mapas, participação e variação com a janela anterior escalada', () => {
    const result = spendingByCategory(
      [
        entry('food', '2026-08-02', -6_000),
        entry('food', '2026-08-05', -4_000),
        entry('housing', '2026-08-08', -30_000),
        entry('food', '2026-07-20', -10_000),
        entry('housing', '2026-07-25', -20_000),
        entry('old-only', '2026-07-28', -8_000),
      ],
      { start: '2026-08-01', end: '2026-08-10' },
      { start: '2026-07-12', end: '2026-07-31' },
    )

    expect(result.current.get('food')).toMatchObject({
      cents: 10_000,
      count: 2,
    })
    expect(result.previous.get('food')).toBe(5_000)
    expect(result.totalCents).toBe(40_000)
    expect(result.previousTotalCents).toBe(19_000)
    expect(result.spendingCount).toBe(3)
    expect(result.items.find((item) => item.id === 'food')).toMatchObject({
      share: 0.25,
      previousCents: 5_000,
      deltaCents: 5_000,
      deltaRatio: 1,
    })
    expect(result.items.find((item) => item.id === 'old-only')).toMatchObject({
      cents: 0,
      previousCents: 4_000,
      deltaRatio: -1,
    })
  })

  it('calcula a extensão do razão e o histórico completo até hoje', () => {
    const entries = [
      { postedAt: '2026-07-10' },
      { postedAt: '2026-08-15' },
      { postedAt: '2026-07-01' },
    ]
    expect(ledgerSpan(entries)).toEqual({
      start: '2026-07-01',
      end: '2026-08-15',
    })
    expect(fullPeriod(entries, '2026-09-04')).toEqual({
      start: '2026-07-01',
      end: '2026-09-04',
    })
    expect(fullPeriod([], '2026-09-04')).toEqual({
      start: '2026-09-04',
      end: '2026-09-04',
    })
  })
})
