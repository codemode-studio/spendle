import { describe, expect, it } from 'vitest'
import { buildCommitmentBudget } from './commitment-budget'
import { financialHealth } from './financial-health'

const base = () =>
  buildCommitmentBudget({
    month: '2026-09',
    today: '2026-09-06',
    incomeCents: 100000,
    targets: {
      essential: 40000,
      lifestyle: 20000,
      investment: 30000,
      reserve: 10000,
    },
    transactions: [],
    statements: [],
    recurrences: [],
    coveragePartial: false,
  })
describe('financial health presentation', () => {
  it('does not call an incomplete positive margin healthy', () => {
    const budget = base()
    budget.warnings.push('Cobertura parcial')
    expect(financialHealth(budget)).toMatchObject({
      tone: 'warning',
      incomplete: true,
      deficit: false,
    })
  })
  it('uses the margin after goals to flag a shortfall', () => {
    const budget = base()
    budget.remainingCents = 10000
    budget.remainingAfterGoalsCents = -30000
    expect(financialHealth(budget)).toMatchObject({
      tone: 'danger',
      deficit: true,
    })
  })
  it('flags overspending even when the overall month still fits', () => {
    const budget = base()
    budget.buckets[1].remainingCents = -100
    expect(financialHealth(budget)).toMatchObject({
      tone: 'warning',
      deficit: false,
    })
  })
  it('requires a reference income before judging health', () => {
    const budget = base()
    budget.incomeCents = 0
    expect(financialHealth(budget).label).toBe('Defina a renda de referência')
  })
})
