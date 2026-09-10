import { describe, expect, it } from 'vitest'
import { buildMonthlyCashFlow } from './monthly-cash-flow'

type Facts = Parameters<typeof buildMonthlyCashFlow>[0]

function account(overrides: Partial<Facts['accounts'][number]> = {}) {
  return {
    id: 'checking',
    active: true,
    purpose: 'operating',
    currency: 'BRL',
    initialBalanceCents: 0,
    statementBalanceAt: '2026-08-31',
    statementBalanceCents: 100000,
    ...overrides,
  }
}
function transaction(
  id: string,
  amountCents: number,
  overrides: Partial<Facts['transactions'][number]> = {},
): Facts['transactions'][number] {
  return {
    id,
    postedAt: '2026-09-07',
    amountCents,
    baseAmountCents: null,
    baseCurrency: 'BRL',
    currency: 'BRL',
    description: 'Recebimento',
    status: 'confirmed',
    accountId: 'checking',
    creditCardId: null,
    counterpartyAccountId: null,
    categoryId: 'income',
    account: { ownershipScopeId: 'family' },
    creditCard: null,
    ...overrides,
  }
}
function recurrence(
  overrides: Partial<Facts['recurrences'][number]> = {},
): Facts['recurrences'][number] {
  return {
    id: 'income',
    name: 'Recebimento',
    categoryId: 'income',
    active: true,
    amountCents: 10000,
    currency: 'BRL',
    direction: 'income',
    amountMode: 'fixed',
    destinationMode: 'fixed',
    accountId: 'checking',
    creditCardId: null,
    nextDate: '2026-09-20',
    scheduleAnchor: '2026-09-20',
    frequency: 'monthly',
    dateToleranceDays: 3,
    amountToleranceBps: 100,
    ...overrides,
  }
}
function facts(overrides: Partial<Facts> = {}): Facts {
  return {
    month: '2026-09',
    referenceDate: '2026-09-08',
    baseCurrency: 'BRL',
    accounts: [account()],
    transactions: [],
    scopes: [{ id: 'family', type: 'household' }],
    recurrences: [],
    occurrences: [],
    checkpoints: [],
    exchangeRates: [],
    reconciliations: [],
    commitments: { forecasting: true, lines: [], savingsRemainingCents: 0 },
    ...overrides,
  }
}

describe('monthly cash flow from financial facts', () => {
  it('counts paid commitments, own transfers and a pending recurrence only once, preserving cents and inputs', () => {
    const input = facts({
      accounts: [
        account(),
        account({ id: 'other', statementBalanceCents: 20000 }),
      ],
      transactions: [
        transaction('income', 20001),
        transaction('expense', -10001),
        transaction('transfer-out', -5001),
        transaction('transfer-in', 5001, { accountId: 'other' }),
        transaction('pending', 10000, {
          status: 'pending',
          postedAt: '2026-09-20',
        }),
      ],
      recurrences: [recurrence()],
      occurrences: [
        {
          id: 'occurrence',
          recurrenceId: 'income',
          expectedDate: '2026-09-20',
          expectedAmountCents: 10000,
          currency: 'BRL',
          direction: 'income',
          categoryId: 'income',
          status: 'expected',
        },
      ],
      reconciliations: [
        {
          type: 'transfer',
          status: 'confirmed',
          transactionIds: ['transfer-out', 'transfer-in'],
        },
      ],
      commitments: {
        forecasting: true,
        lines: [
          { cents: 10001, paidCents: 10001 },
          { cents: 30002, paidCents: 0 },
        ],
        savingsRemainingCents: 10000,
      },
    })
    const before = structuredClone(input)
    expect(buildMonthlyCashFlow(input)).toEqual({
      forecasting: true,
      openingCashCents: 120000,
      cashCents: 130000,
      receivedCents: 20001,
      paidCents: 10001,
      expectedIncomeCents: 10000,
      remainingExpenseCents: 30002,
      goalRemainingCents: 10000,
      closingCashCents: 109998,
      afterGoalsCents: 99998,
      unexplainedChangeCents: 0,
    })
    expect(input).toEqual(before)
  })

  it('reconstructs historical cash around a dated anchor and disables forecasts', () => {
    const input = facts({
      month: '2026-08',
      accounts: [
        account({
          statementBalanceAt: '2026-09-05',
          statementBalanceCents: 10000,
        }),
      ],
      transactions: [
        transaction('august', 5000, { postedAt: '2026-08-20' }),
        transaction('anchor-day', 4000, { postedAt: '2026-09-05' }),
        transaction('after-anchor', -1001, { postedAt: '2026-09-06' }),
      ],
      recurrences: [recurrence()],
      commitments: {
        forecasting: false,
        lines: [{ cents: 50000, paidCents: 0 }],
        savingsRemainingCents: 50000,
      },
    })
    expect(buildMonthlyCashFlow(input)).toMatchObject({
      openingCashCents: null,
      cashCents: 6000,
      receivedCents: 5000,
      expectedIncomeCents: 0,
      remainingExpenseCents: 0,
      closingCashCents: 6000,
      afterGoalsCents: 6000,
      unexplainedChangeCents: null,
    })
    expect(buildMonthlyCashFlow({ ...input, month: '2026-09' })).toMatchObject({
      openingCashCents: 6000,
      cashCents: 8999,
      receivedCents: 4000,
      paidCents: 1001,
      unexplainedChangeCents: 0,
    })
  })

  it.each(['direct', 'inverse'] as const)(
    'uses dated %s FX for balances, persisted FX for receipts and latest FX for expected income',
    (direction) => {
      const rate = (date: string, value: number) => ({
        date,
        fromCurrency: direction === 'direct' ? 'USD' : 'BRL',
        toCurrency: direction === 'direct' ? 'BRL' : 'USD',
        rateMicros: direction === 'direct' ? value : Math.round(1e12 / value),
      })
      const input = facts({
        accounts: [account({ currency: 'USD', statementBalanceCents: 10000 })],
        transactions: [
          transaction('receipt', 1000, {
            currency: 'USD',
            baseCurrency: 'BRL',
            baseAmountCents: 4999,
          }),
        ],
        exchangeRates: [
          rate('2026-08-31', 4000000),
          rate('2026-10-01', 8000000),
          rate('2026-09-01', 5000000),
        ],
        recurrences: [recurrence({ currency: 'USD', amountCents: 1000 })],
      })
      expect(buildMonthlyCashFlow(input)).toMatchObject({
        openingCashCents: 40000,
        cashCents: 55000,
        receivedCents: 4999,
        expectedIncomeCents: 8000,
        closingCashCents: 63000,
        unexplainedChangeCents: 10001,
      })
    },
  )

  it('keeps missing historical balances or currency conversions unknown', () => {
    expect(
      buildMonthlyCashFlow(
        facts({
          accounts: [account({ currency: 'USD' })],
        }),
      ),
    ).toMatchObject({
      cashCents: null,
      closingCashCents: null,
      afterGoalsCents: null,
    })
    expect(
      buildMonthlyCashFlow(
        facts({
          month: '2026-08',
          accounts: [
            account({
              statementBalanceAt: null,
              statementBalanceCents: null,
              initialBalanceCents: 100,
            }),
          ],
        }),
      ),
    ).toMatchObject({ openingCashCents: null, cashCents: null })
  })

  it('excludes inactive and non-operating accounts and does not invent future cash', () => {
    const input = facts({
      accounts: [
        account(),
        account({ id: 'inactive', active: false }),
        account({ id: 'reserve', purpose: 'reserve' }),
      ],
    })
    expect(buildMonthlyCashFlow(input).cashCents).toBe(100000)
    expect(buildMonthlyCashFlow({ ...input, month: '2026-10' })).toMatchObject({
      cashCents: null,
      closingCashCents: null,
    })
  })
})
