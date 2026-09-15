import { describe, expect, it } from 'vitest'
import { shiftDays } from './period'
import { addRecurrencePeriod } from './recurrence-schedule'
import {
  buildMonthlyCashFlow,
  projectCash,
  trimCashProjection,
} from './monthly-cash-flow'

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

type ProjectionFacts = Parameters<typeof projectCash>[0]

/**
 * Conta operacional com saldo zero conferido hoje: movimentos anteriores não
 * mudam o caixa de partida, então cada teste controla o ponto inicial.
 */
type Mutable<T> = {
  -readonly [K in keyof T]: T[K] extends ReadonlyArray<infer U>
    ? Array<U>
    : T[K]
}

function projectionFacts(
  today: string,
): Mutable<ProjectionFacts> & { expectedDates: string[] } {
  const firstDate = shiftDays(today, 1)
  const secondDate = addRecurrencePeriod(firstDate, 'monthly', firstDate)
  const thirdDate = addRecurrencePeriod(secondDate, 'monthly', firstDate)
  const expectedDates = [firstDate, secondDate, thirdDate]
  return {
    expectedDates,
    baseCurrency: 'BRL',
    accounts: [
      account({
        id: 'operating-account',
        statementBalanceAt: today,
        statementBalanceCents: 0,
      }),
    ],
    scopes: [{ id: 'family', type: 'household' }],
    checkpoints: [],
    exchangeRates: [],
    reconciliations: [],
    categories: [
      { id: 'food', bucket: 'essential' },
      { id: 'housing', bucket: 'essential' },
      { id: 'health', bucket: 'essential' },
      { id: 'subscriptions', bucket: 'essential' },
      { id: 'reserve', bucket: 'reserve' },
      { id: 'uncategorized', bucket: 'excluded' },
    ],
    cards: [],
    installmentPlans: [],
    knowledgeReferences: [],
    matches: [],
    transactions: [],
    recurrences: [
      recurrence({
        id: 'monthly-recurrence',
        name: 'Compromisso mensal',
        categoryId: 'housing',
        direction: 'expense',
        amountCents: 10000,
        nextDate: firstDate,
        scheduleAnchor: firstDate,
        accountId: null,
        dateToleranceDays: 15,
      }),
    ],
    occurrences: expectedDates.map((expectedDate, index) => ({
      id: `occurrence-${index + 1}`,
      recurrenceId: 'monthly-recurrence',
      expectedDate,
      expectedAmountCents: 10000,
      currency: 'BRL',
      direction: 'expense',
      categoryId: 'housing',
      status: 'expected',
    })),
  }
}

function spend(
  id: string,
  today: string,
  amountCents: number,
  overrides: Partial<ProjectionFacts['transactions'][number]> = {},
) {
  return transaction(id, amountCents, {
    postedAt: shiftDays(today, -1),
    accountId: 'operating-account',
    description: id,
    categoryId: 'food',
    ...overrides,
  })
}

describe('cash projection from financial facts', () => {
  const today = '2026-09-04'

  it('schedules every expected monthly occurrence within 90 days and moves cash on those dates', () => {
    const scenario = projectionFacts(today)
    const projection = projectCash(scenario, {
      today,
      daysBack: 0,
      daysAhead: 90,
    })
    expect(projection.scheduled.map((event) => event.date)).toEqual(
      scenario.expectedDates,
    )
    const changes = projection.points
      .slice(projection.todayIndex + 1)
      .filter(
        (point, index, future) =>
          point.balanceCents !==
          (index === 0 ? 0 : future[index - 1].balanceCents),
      )
    expect(changes.map((point) => point.date)).toEqual(scenario.expectedDates)
    expect(changes.map((point) => point.balanceCents)).toEqual([
      -10000, -20000, -30000,
    ])
  })

  it('starts from the same operating cash as the monthly summary, anchors included', () => {
    const scenario = projectionFacts(today)
    scenario.accounts = [
      account({
        id: 'operating-account',
        statementBalanceAt: null,
        statementBalanceCents: null,
        initialBalanceCents: 50000,
      }),
      account({
        id: 'pj',
        statementBalanceAt: shiftDays(today, -10),
        statementBalanceCents: 4801903,
      }),
      account({ id: 'reserve', purpose: 'reserve', statementBalanceCents: 1 }),
      account({ id: 'usd', currency: 'USD', statementBalanceCents: 100 }),
    ]
    scenario.checkpoints = [
      {
        accountId: 'operating-account',
        reviewState: 'verified',
        asOf: shiftDays(today, -3),
        balanceCents: 20000,
      },
    ]
    scenario.transactions = [
      transaction('after-anchor', -5000, {
        postedAt: shiftDays(today, -1),
        accountId: 'operating-account',
      }),
    ]

    const unknown = projectCash(scenario, { today, daysBack: 5, daysAhead: 30 })
    expect(unknown.assumptions.startingCents).toBeNull()
    expect(unknown.points).toEqual([])
    expect(unknown.in30Cents).toBeNull()
    expect(unknown.scheduled).toHaveLength(1)

    scenario.exchangeRates = [
      {
        date: shiftDays(today, -10),
        fromCurrency: 'USD',
        toCurrency: 'BRL',
        rateMicros: 5_000_000,
      },
    ]
    const projection = projectCash(scenario, {
      today,
      daysBack: 5,
      daysAhead: 30,
    })
    const summary = buildMonthlyCashFlow({
      ...scenario,
      month: today.slice(0, 7),
      referenceDate: today,
      commitments: { forecasting: false, lines: [], savingsRemainingCents: 0 },
    })
    expect(projection.assumptions.startingCents).toBe(summary.cashCents)
    // 50000 - 5000 (PF) + 4801903 (PJ) + 500 (USD convertido); reserva fora.
    expect(projection.assumptions.startingCents).toBe(4847403)
    // No dia do checkpoint o histórico segue a âncora, não o saldo atual.
    const anchored = projection.points.find(
      (point) => point.date === shiftDays(today, -3),
    )
    expect(anchored?.balanceCents).toBe(20000 + 4801903 + 500)
    // Antes da âncora, sem movimentos, o saldo é desconhecido: o histórico para.
    expect(
      projection.points
        .slice(0, projection.todayIndex + 1)
        .map((point) => point.date),
    ).toEqual([
      shiftDays(today, -3),
      shiftDays(today, -2),
      shiftDays(today, -1),
      today,
    ])
  })

  it('does not improve the forecast when the same outflow loses its category', () => {
    const scenario = projectionFacts(today)
    scenario.recurrences = []
    scenario.occurrences = []
    scenario.transactions = [spend('expense', today, -60000)]
    expect(
      projectCash(scenario, { today, daysBack: 0, daysAhead: 30 }).in30Cents,
    ).toBe(-30000)
    scenario.transactions = [
      spend('expense', today, -60000, { categoryId: 'uncategorized' }),
    ]
    expect(
      projectCash(scenario, { today, daysBack: 0, daysAhead: 30 }).in30Cents,
    ).toBe(-30000)
  })

  it('reserves new card purchases without repeating scheduled installments', () => {
    const scenario = projectionFacts(today)
    scenario.recurrences = []
    scenario.occurrences = []
    scenario.cards = [
      {
        id: 'card',
        name: 'Cartão',
        currency: 'BRL',
        upcomingStatements: [
          { dueDate: shiftDays(today, 5), amountCents: 20000 },
        ],
      },
    ]
    scenario.installmentPlans = [{ sourceTransactionId: 'installment' }]
    scenario.transactions = ['groceries', 'installment'].map((id) =>
      spend(id, today, -60000, { accountId: null, creditCardId: 'card' }),
    )
    const projection = projectCash(scenario, {
      today,
      daysBack: 0,
      daysAhead: 30,
    })
    expect(projection.dailyVariableCents).toBe(1000)
    expect(projection.in30Cents).toBe(-50000)
    expect(projection.assumptions.estimatedCardCents).toBe(20000)
  })

  it('does not project a past allocation as new consumption', () => {
    const scenario = projectionFacts(today)
    scenario.recurrences = []
    scenario.occurrences = []
    scenario.transactions = [
      spend('reserve', today, -60000, { categoryId: 'reserve' }),
    ]
    expect(
      projectCash(scenario, { today, daysBack: 0, daysAhead: 30 }).in30Cents,
    ).toBe(0)
  })

  it('keeps a card subscription in the average even when linked to a card recurrence', () => {
    const scenario = projectionFacts(today)
    scenario.cards = [
      { id: 'card', name: 'Cartão', currency: 'BRL', upcomingStatements: [] },
    ]
    scenario.recurrences = [
      { ...scenario.recurrences[0], creditCardId: 'card' },
    ]
    scenario.occurrences = scenario.occurrences.slice(0, 1)
    scenario.matches = [
      {
        occurrenceId: 'occurrence-1',
        transactionId: 'subscription',
        status: 'confirmed',
      },
    ]
    scenario.transactions = [
      spend('subscription', today, -6000, {
        accountId: null,
        creditCardId: 'card',
        categoryId: 'subscriptions',
      }),
    ]
    expect(
      projectCash(scenario, { today, daysBack: 0, daysAhead: 30 }).in30Cents,
    ).toBe(-3000)
  })

  it('projects 90 days even when only the next occurrence is recorded', () => {
    const scenario = projectionFacts(today)
    scenario.occurrences = scenario.occurrences.slice(0, 1)
    const projection = projectCash(scenario, {
      today,
      daysBack: 0,
      daysAhead: 90,
    })
    expect(projection.scheduled.map((event) => event.date)).toEqual(
      scenario.expectedDates,
    )
    expect(projection.points.at(-1)?.balanceCents).toBe(-30000)
  })

  it('does not recreate a paid or skipped commitment when completing the horizon', () => {
    const scenario = projectionFacts(today)
    scenario.occurrences[1].status = 'skipped'
    scenario.occurrences[2].status = 'matched'
    const projection = projectCash(scenario, {
      today,
      daysBack: 0,
      daysAhead: 90,
    })
    expect(projection.scheduled.map((event) => event.date)).toEqual([
      scenario.expectedDates[0],
    ])
    expect(projection.points.at(-1)?.balanceCents).toBe(-10000)
  })

  it('does not repeat in the variable average a payment recognised by the recurrence knowledge', () => {
    const scenario = projectionFacts(today)
    scenario.recurrences[0].amountCents = 60000
    scenario.recurrences[0].amountToleranceBps = 500
    scenario.occurrences.forEach((occurrence) => {
      occurrence.expectedAmountCents = 60000
    })
    scenario.knowledgeReferences = [
      { recurrenceId: 'monthly-recurrence', description: 'LOCADORA EXEMPLO' },
    ]
    scenario.transactions = [
      spend('rent-paid', today, -60000, {
        postedAt: shiftDays(today, -30),
        description: 'Pix enviado: "Cp :12345678-LOCADORA EXEMPLO"',
        categoryId: 'housing',
      }),
    ]
    const before = JSON.stringify(scenario)
    const projection = projectCash(scenario, {
      today,
      daysBack: 0,
      daysAhead: 30,
    })
    expect(projection.in30Cents).toBe(-60000)
    expect(projection.recurringEstimateTransactionIds).toEqual(['rent-paid'])
    expect(JSON.stringify(scenario)).toBe(before)

    scenario.recurrences.push({ ...scenario.recurrences[0], id: 'ambiguous' })
    scenario.knowledgeReferences.push({
      recurrenceId: 'ambiguous',
      description: 'LOCADORA EXEMPLO',
    })
    expect(
      projectCash(scenario, { today, daysBack: 0, daysAhead: 30 })
        .recurringEstimateTransactionIds,
    ).toEqual([])

    scenario.recurrences.pop()
    scenario.knowledgeReferences.pop()
    scenario.recurrences[0].active = false
    expect(
      projectCash(scenario, { today, daysBack: 0, daysAhead: 30 }).in30Cents,
    ).toBe(-30000)
  })

  it('explains estimated receipts, documents and repeated history separately', () => {
    const scenario = projectionFacts(today)
    scenario.recurrences.push(
      recurrence({
        id: 'income',
        name: 'Recebimento',
        amountCents: 60000,
        nextDate: scenario.expectedDates[0],
        scheduleAnchor: scenario.expectedDates[0],
        accountId: null,
      }),
    )
    scenario.occurrences.push({
      id: 'income-1',
      recurrenceId: 'income',
      expectedDate: scenario.expectedDates[0],
      expectedAmountCents: 60000,
      currency: 'BRL',
      direction: 'income',
      categoryId: 'income',
      status: 'expected',
    })
    scenario.cards = [
      {
        id: 'card',
        name: 'Cartão',
        currency: 'BRL',
        upcomingStatements: [
          {
            dueDate: shiftDays(today, 2),
            amountCents: 20000,
            certainty: 'closed',
          },
          {
            dueDate: shiftDays(today, 3),
            amountCents: 30000,
            certainty: 'installment_schedule',
          },
          { dueDate: shiftDays(today, 4), amountCents: 5000 },
        ],
      },
    ]
    scenario.transactions = [
      spend('one-off', today, -60000, {
        description: 'Pagamento a esclarecer',
        categoryId: 'uncategorized',
      }),
    ]
    const projection = projectCash(scenario, {
      today,
      daysBack: 0,
      daysAhead: 30,
    })
    expect(projection.assumptions).toEqual({
      days: 30,
      startingCents: 0,
      estimatedIncomeCents: 60000,
      estimatedRecurrenceCents: 10000,
      closedCardCents: 20000,
      scheduledCardCents: 30000,
      estimatedCardCents: 5000,
      historicalEstimateCents: 30000,
    })
    expect(projection.in30Cents).toBe(-35000)
    expect(projection.largestHistoricalExpenses[0]).toMatchObject({
      id: 'one-off',
      cents: 60000,
    })
    expect(projection.scheduled.map((event) => event.name)).toEqual([
      'Compromisso mensal',
      'Recebimento',
      'Fatura Cartão',
      'Parcelas conhecidas Cartão',
      'Fatura Cartão',
    ])
  })

  it('removes a fixed bill paid in advance from the forecast without confirming the link', () => {
    const scenario = projectionFacts(today)
    scenario.knowledgeReferences = [
      { recurrenceId: 'monthly-recurrence', description: 'OPERADORA EXEMPLO' },
    ]
    scenario.transactions = [
      spend('paid-early', today, -10000, {
        description: 'Pix enviado: "Cp :12345678-OPERADORA EXEMPLO"',
        categoryId: 'health',
      }),
    ]
    const before = JSON.stringify(scenario)
    const projection = projectCash(scenario, {
      today,
      daysBack: 0,
      daysAhead: 30,
    })
    expect(projection.scheduled).toEqual([])
    expect(projection.assumptions.estimatedRecurrenceCents).toBe(0)
    expect(projection.observedAdvancePayments).toMatchObject([
      {
        transactionId: 'paid-early',
        occurrenceId: 'occurrence-1',
        cents: 10000,
      },
    ])
    expect(JSON.stringify(scenario)).toBe(before)

    scenario.recurrences.push({ ...scenario.recurrences[0], id: 'ambiguous' })
    scenario.knowledgeReferences.push({
      recurrenceId: 'ambiguous',
      description: 'OPERADORA EXEMPLO',
    })
    scenario.occurrences.push(
      ...scenario.occurrences.map((occurrence) => ({
        ...occurrence,
        id: 'second-' + occurrence.id,
        recurrenceId: 'ambiguous',
      })),
    )
    expect(
      projectCash(scenario, { today, daysBack: 0, daysAhead: 30 })
        .observedAdvancePayments,
    ).toEqual([])

    scenario.recurrences.pop()
    scenario.knowledgeReferences.pop()
    scenario.occurrences.length = 3
    scenario.transactions[0].amountCents = -5000
    expect(
      projectCash(scenario, { today, daysBack: 0, daysAhead: 30 })
        .observedAdvancePayments,
    ).toEqual([])
  })

  it('trims a projection to a shorter horizon without touching the scenario', () => {
    const scenario = projectionFacts(today)
    scenario.transactions = [spend('expense', today, -60000)]
    const full = projectCash(scenario, { today, daysBack: 3, daysAhead: 90 })
    const trimmed = trimCashProjection(full, 30)
    const direct = projectCash(scenario, { today, daysBack: 3, daysAhead: 30 })
    expect(trimmed).toEqual(direct)
    expect(trimmed.points).toEqual(full.points.slice(0, full.todayIndex + 31))
    expect(trimmed.scheduled).toEqual(full.scheduled.slice(0, 1))
    expect(trimCashProjection(full, 120).assumptions.days).toBe(90)
  })
})
