import { describe, expect, it } from 'vitest'
import { buildFamilyMonth } from './family-month'
import { buildCommitmentBudget } from './commitment-budget'
import type { CommitmentLine } from './commitment-budget'

const targets = {
  essential: 50000,
  lifestyle: 30000,
  investment: 15000,
  reserve: 5000,
}
const line = (patch: Partial<CommitmentLine>): CommitmentLine => ({
  id: 'expense',
  description: 'Compra',
  date: '2026-09-15',
  cents: 12001,
  categoryId: 'shopping',
  bucket: 'lifestyle',
  certainty: 'documented',
  paidCents: 0,
  origin: 'card',
  ...patch,
})
const make = (lines: CommitmentLine[], month = '2026-09') =>
  buildFamilyMonth({
    month,
    referenceMonth: '2026-09',
    closed: false,
    incomeCents: 90001,
    plannedIncomeCents: 100000,
    targets,
    saved: { investment: 1000, reserve: 0 },
    budget: {
      ...buildCommitmentBudget({
        month,
        today: '2026-09-08',
        incomeCents: 100000,
        targets,
        transactions: [],
        statements: [],
        recurrences: [],
        coveragePartial: false,
      }),
      lines,
    },
  })

describe('family month', () => {
  it('includes bills in their due month, refunds and every category, with estimates separate', () => {
    const result = make([
      line({}),
      line({ id: 'refund', cents: -201 }),
      line({ id: 'unknown', cents: 333, bucket: 'other', categoryId: null }),
      line({
        id: 'forecast',
        cents: 5000,
        certainty: 'estimated',
        origin: 'variable',
      }),
    ])
    expect(result.knownExpenseCents).toBe(12133)
    expect(result.estimatedExpenseCents).toBe(5000)
    expect(result.expenseCents).toBe(17133)
    expect(result.expenses.reduce((sum, b) => sum + b.cents, 0)).toBe(
      result.expenseCents,
    )
    expect(result.plannedBalanceCents).toBe(82867)
    expect(result.recordedBalanceCents).toBe(77868)
    expect(result.balanceAfterGoalsCents).toBe(62867)
    expect(result.needsCategoryCount).toBe(1)
  })
  it('never counts a card purchase as saved money or reduces the savings goal with it', () => {
    const result = make([
      line({ cents: 329998, bucket: 'investment', categoryId: 'investment' }),
    ])
    expect(result.expenseCents).toBe(329998)
    expect(result.expenses.find((b) => b.bucket === 'other')?.cents).toBe(
      329998,
    )
    expect(result.savedCents).toBe(1000)
    expect(result.savingsRemainingCents).toBe(19000)
    expect(result.needsCategoryCount).toBe(1)
  })
  it('does not turn past forecasts into spending; preserves known bills and paid obligations', () => {
    const result = make(
      [
        line({ cents: 10001 }),
        line({
          id: 'forecast',
          cents: 99999,
          paidCents: 101,
          certainty: 'scheduled',
        }),
      ],
      '2026-08',
    )
    expect(result.knownExpenseCents).toBe(10102)
    expect(result.estimatedExpenseCents).toBe(0)
    expect(result.expenseCents).toBe(10102)
  })
  it('does not invent income when only a plan exists', () => {
    const result = buildFamilyMonth({ ...makeInput(), incomeCents: 0 })
    expect(result.incomeCents).toBe(0)
    expect(result.plannedIncomeCents).toBe(100000)
    expect(result.incomeMissing).toBe(true)
  })
})
function makeInput() {
  return {
    month: '2026-09',
    referenceMonth: '2026-09',
    closed: false,
    incomeCents: 0,
    plannedIncomeCents: 100000,
    targets,
    saved: { investment: 0, reserve: 0 },
    budget: buildCommitmentBudget({
      month: '2026-09',
      today: '2026-09-08',
      incomeCents: 100000,
      targets,
      transactions: [],
      statements: [],
      recurrences: [],
      coveragePartial: false,
    }),
  }
}
