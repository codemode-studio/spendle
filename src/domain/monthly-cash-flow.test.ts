import { describe, expect, it } from 'vitest'
import { buildMonthlyCashFlow, recordedBalanceAt } from './monthly-cash-flow'

describe('monthly cash flow', () => {
  it('starts from current cash and counts only future movements, not received income or paid bills again', () => {
    const flow = buildMonthlyCashFlow({
      forecasting: true,
      openingCashCents: 100000,
      cashCents: 85001,
      receivedCents: 50001,
      paidCents: 65000,
      expectedIncomeCents: 20000,
      remainingExpenseCents: 30002,
      goalRemainingCents: 10000,
    })
    expect(flow.closingCashCents).toBe(74999)
    expect(flow.afterGoalsCents).toBe(64999)
    expect(flow.unexplainedChangeCents).toBe(0)
  })
  it('keeps historical cash free of current forecasts and exposes an unexplained movement', () => {
    const flow = buildMonthlyCashFlow({
      forecasting: false,
      openingCashCents: 10000,
      cashCents: 9000,
      receivedCents: 0,
      paidCents: 999,
      expectedIncomeCents: 50000,
      remainingExpenseCents: 50000,
      goalRemainingCents: 50000,
    })
    expect(flow.closingCashCents).toBe(9000)
    expect(flow.afterGoalsCents).toBe(9000)
    expect(flow.unexplainedChangeCents).toBe(-1)
  })
  it('reconstructs balances on either side of a dated statement without counting the anchor day twice', () => {
    const input = {
      initialCents: 0,
      anchors: [{ date: '2026-09-05', cents: 10000 }],
      movements: [
        { date: '2026-08-20', cents: 5000 },
        { date: '2026-09-05', cents: 4000 },
        { date: '2026-09-06', cents: -1001 },
      ],
    }
    expect(recordedBalanceAt({ ...input, date: '2026-08-31' })).toBe(6000)
    expect(recordedBalanceAt({ ...input, date: '2026-09-06' })).toBe(8999)
    expect(recordedBalanceAt({ ...input, date: '2026-07-31' })).toBeNull()
  })
  it('does not turn a missing historical balance into zero', () => {
    const flow = buildMonthlyCashFlow({
      forecasting: false,
      openingCashCents: null,
      cashCents: null,
      receivedCents: 10,
      paidCents: 0,
      expectedIncomeCents: 0,
      remainingExpenseCents: 0,
      goalRemainingCents: 0,
    })
    expect(flow.closingCashCents).toBeNull()
    expect(flow.unexplainedChangeCents).toBeNull()
  })
})
