import { describe, expect, it } from 'vitest'
import { shiftDays } from '#/domain/period'
import type { CashProjection } from './cash-projection'
import { simulateRecovery } from './forecast'

function projection(
  balances: number[],
  dailyVariableCents = 100,
): CashProjection {
  return {
    today: '2026-09-09',
    scheduled: [],
    points: balances.map((balanceCents, i) => ({
      date: shiftDays('2026-09-09', i),
      balanceCents,
    })),
    todayIndex: 0,
    lowPoint: null,
    in30Cents: balances.at(-1)!,
    dailyVariableCents,
    recurringEstimateTransactionIds: [],
    largestHistoricalExpenses: [],
    assumptions: {
      days: balances.length - 1,
      startingCents: balances[0],
      estimatedIncomeCents: 0,
      estimatedRecurrenceCents: 0,
      closedCardCents: 0,
      scheduledCardCents: 0,
      estimatedCardCents: 0,
      historicalEstimateCents: dailyVariableCents * (balances.length - 1),
    },
  }
}

describe('cash recovery simulation', () => {
  it('protects an early cash shortfall even when the ending balance recovers', () => {
    const cash = projection([10000, -1000, -2000, 20000])
    const result = simulateRecovery(cash, 0, 0, 1000)
    expect(result.firstNegative?.date).toBe('2026-09-10')
    expect(result.minimum.date).toBe('2026-09-11')
    expect(result.requiredMonthlyCents).toBe(30000)
    const adjusted = simulateRecovery(
      cash,
      0,
      result.requiredMonthlyCents,
      1000,
    )
    expect(adjusted.simulatedFirstNegative).toBeNull()
    expect(adjusted.remainingMonthlyCents).toBe(0)
  })

  it('requires enough to recover depletion and accumulate the strategy target', () => {
    const cash = projection(
      Array.from({ length: 61 }, (_, day) => 100000 - day * 1000),
    )
    const result = simulateRecovery(cash, 0, 0, 20000)
    expect(result.monthlyBalanceCents).toBe(-30000)
    expect(result.requiredMonthlyCents).toBe(50000)
    const adjusted = simulateRecovery(cash, 0, 50000, 20000)
    expect(adjusted.simulatedEndingCents).toBe(140000)
    expect(adjusted.remainingMonthlyCents).toBe(0)
  })

  it('preserves cents and history and caps reductions to historical consumption', () => {
    const cash = projection([10000, 8001, 6002, 4003], 101)
    cash.todayIndex = 1
    const before = structuredClone(cash)
    const result = simulateRecovery(cash, 150, 1, 0)
    expect(result.reductionMonthlyCents).toBe(3030)
    expect(result.points.slice(0, 2)).toEqual(cash.points.slice(0, 2))
    expect(result.simulatedEndingCents).toBe(4205)
    expect(
      result.points.every((point) => Number.isSafeInteger(point.balanceCents)),
    ).toBe(true)
    expect(cash).toEqual(before)
  })

  it('does not demand extra savings if the forecast already covers the target', () => {
    const cash = projection(Array.from({ length: 31 }, (_, day) => day * 1000))
    expect(simulateRecovery(cash, 0, 0, 20000).requiredMonthlyCents).toBe(0)
  })

  it('ignores invalid or negative controls and handles zero variable spending', () => {
    const cash = projection([0, 0, 0], 0)
    expect(simulateRecovery(cash, -20, -500, 0).improvementMonthlyCents).toBe(0)
    expect(simulateRecovery(cash, NaN, Infinity, 0).simulatedEndingCents).toBe(
      0,
    )
  })
})
