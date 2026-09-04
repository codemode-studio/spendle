import { describe, expect, it } from 'vitest'

import type { FamilyTransaction } from '#/domain/ledger'
import { monthsInPeriod } from '#/domain/period'

import { analyzeCategories } from './analysis'

function spend(
  id: string,
  postedAt: string,
  cents: number,
  overrides: Partial<FamilyTransaction> = {},
): FamilyTransaction {
  return {
    id: `${id}-${postedAt}-${cents}`,
    postedAt,
    description: id,
    normalized: id,
    amountCents: -cents,
    categoryId: id,
    categoryName: id,
    color: '#000000',
    bucket: 'essential',
    source: 'account',
    uncategorized: false,
    ...overrides,
  }
}

describe('analyzeCategories', () => {
  const period = { start: '2026-06-15', end: '2026-08-14' }

  it('agrupa por categoria com série mensal e compara com o período anterior', () => {
    const result = analyzeCategories(
      [
        spend('food', '2026-06-20', 10_000),
        spend('food', '2026-07-05', 20_000),
        spend('food', '2026-08-01', 30_000),
        spend('housing', '2026-07-10', 100_000),
        // período anterior (16/abr a 14/jun)
        spend('food', '2026-05-10', 40_000),
        // fora dos dois períodos
        spend('food', '2026-03-01', 99_000),
        // receita e alocação não contam como gasto
        spend('food', '2026-07-01', -5_000, { bucket: 'income' }),
        spend('reserve', '2026-07-01', 7_000, { bucket: 'reserve' }),
        spend('uncategorized', '2026-07-02', 1_500, {
          categoryId: null,
          uncategorized: true,
        }),
      ],
      period,
    )
    expect(result.months.map((month) => month.key)).toEqual([
      '2026-06',
      '2026-07',
      '2026-08',
    ])
    expect(result.months.map((month) => month.partial)).toEqual([
      true,
      false,
      true,
    ])
    expect(result.totalCents).toBe(160_000)
    expect(result.spendingCount).toBe(4)
    expect(result.previousTotalCents).toBe(40_000)
    expect(result.deltaRatio).toBeCloseTo(3)
    expect(result.uncategorizedCents).toBe(1_500)
    expect(result.uncategorizedCount).toBe(1)
    expect(result.items.map((item) => item.id)).toEqual(['housing', 'food'])
    const food = result.items[1]
    expect(food.monthly).toEqual([10_000, 20_000, 30_000])
    expect(food.share).toBeCloseTo(60_000 / 160_000)
    expect(food.previousCents).toBe(40_000)
    expect(food.deltaRatio).toBeCloseTo(0.5)
    expect(result.items[0].deltaRatio).toBeNull()
  })

  it('média mensal usa o tamanho real do período', () => {
    const result = analyzeCategories([spend('food', '2026-07-01', 30_000)], {
      start: '2026-06-01',
      end: '2026-08-31',
    })
    expect(result.averageMonthlyCents).toBeGreaterThan(9_800)
    expect(result.averageMonthlyCents).toBeLessThan(10_200)
  })

  it('monthsInPeriod rotula meses em português', () => {
    const months = monthsInPeriod({ start: '2026-12-20', end: '2027-01-10' })
    expect(months.map((month) => month.label)).toEqual(['dez', 'jan'])
    expect(months[1]?.fullLabel).toBe('janeiro de 2027')
  })
})
