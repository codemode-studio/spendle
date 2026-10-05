import { describe, expect, it } from 'vitest'

import type { FamilyTransaction } from './ledger'
import {
  baseAmount,
  fullPeriod,
  isSpending,
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

describe('predicados do razão familiar', () => {
  it.each(['essential', 'lifestyle', 'tax', 'business'])(
    'trata %s como gasto analítico',
    (bucket) => {
      expect(isSpending(entry(bucket, '2026-08-01', -1_000, { bucket }))).toBe(
        true,
      )
    },
  )

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

describe('valor-base', () => {
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

  it('calcula o histórico completo até hoje', () => {
    const entries = [
      { postedAt: '2026-07-10' },
      { postedAt: '2026-08-15' },
      { postedAt: '2026-07-01' },
    ]
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
