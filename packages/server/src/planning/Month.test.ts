import { assert, describe, it } from '@effect/vitest'

import { emptyRates, rateTable } from '../rates/Conversion.ts'
import { buildMonth, projectCash } from './Month.ts'
import type { MonthEntry, MonthFacts } from './Month.ts'
import { buildBook } from './RecurrencePolicy.ts'
import type { RecurrenceRule } from './RecurrencePolicy.ts'

const entry = (
  id: string,
  accountId: string,
  bookedOn: string,
  amountCents: number,
  categoryId: string | null,
  bucket: string | null,
  overrides: Partial<MonthEntry> = {},
): MonthEntry => ({
  id,
  accountId,
  bookedOn,
  amountCents,
  description: id,
  status: 'posted',
  categoryId,
  bucket,
  categoryStatus: categoryId === null ? 'none' : 'applied',
  excludedFromSpending: false,
  ...overrides,
})

const internet: RecurrenceRule = {
  id: 'internet',
  name: 'Internet Fibra',
  accountId: 'checking',
  categoryId: 'utilities',
  amountCents: 12_000,
  currency: 'BRL',
  direction: 'expense',
  amountMode: 'fixed',
  matchMode: 'single',
  destinationMode: 'automatic',
  frequency: 'monthly',
  startsOn: '2026-09-25',
  scheduleAnchor: '2026-09-25',
  dateToleranceDays: 5,
  amountToleranceBps: 500,
  autoMatch: true,
  minimumConfirmations: 3,
  active: true,
  importedAliases: [],
}

const salary: RecurrenceRule = {
  ...internet,
  id: 'salary',
  name: 'Salário',
  categoryId: 'salary',
  amountCents: 800_000,
  direction: 'income',
  startsOn: '2026-10-05',
  scheduleAnchor: '2026-10-05',
}

// Mid-September 2026: a checking account, a card due on the 12th, a reserve account.
const facts = (overrides: Partial<MonthFacts> = {}): MonthFacts => {
  const entries = [
    entry('salary', 'checking', '2026-09-05', 800_000, 'salary', 'income'),
    entry('rent', 'checking', '2026-09-10', -250_000, 'housing', 'essential'),
    entry(
      'bill',
      'checking',
      '2026-09-12',
      -40_000,
      'card_payment',
      'excluded',
      {
        excludedFromSpending: true,
      },
    ),
    entry(
      'to-reserve',
      'checking',
      '2026-09-13',
      -100_000,
      'transfer',
      'excluded',
      {
        excludedFromSpending: true,
      },
    ),
    entry(
      'in-reserve',
      'reserve',
      '2026-09-13',
      100_000,
      'transfer',
      'excluded',
      {
        excludedFromSpending: true,
      },
    ),
    entry('cinema', 'card', '2026-08-20', -15_000, 'leisure', 'lifestyle'),
    entry('market', 'card', '2026-08-28', -25_000, 'groceries', 'essential'),
    entry('mystery', 'checking', '2026-09-14', -3_000, null, null),
  ]
  return {
    today: '2026-09-15',
    accounts: [
      {
        id: 'checking',
        name: 'Conta',
        kind: 'checking',
        purpose: 'operating',
        currency: 'BRL',
        archived: false,
        company: false,
        card: null,
      },
      {
        id: 'reserve',
        name: 'Reserva',
        kind: 'savings',
        purpose: 'reserve',
        currency: 'BRL',
        archived: false,
        company: false,
        card: null,
      },
      {
        id: 'card',
        name: 'Cartão',
        kind: 'credit_card',
        purpose: 'operating',
        currency: 'BRL',
        archived: false,
        company: false,
        card: { closingDay: 5, dueDay: 12 },
      },
    ],
    entries,
    relations: [
      {
        kind: 'internal_transfer',
        status: 'confirmed',
        outflowEntryId: 'to-reserve',
        inflowEntryId: 'in-reserve',
      },
    ],
    cycles: [
      {
        accountId: 'card',
        closingOn: '2026-09-05',
        dueOn: '2026-09-14',
        billedCents: 40_000,
        paidCents: 40_000,
        entryIds: ['cinema', 'market'],
      },
    ],
    installments: [],
    checkpoints: [
      { accountId: 'checking', asOf: '2026-08-31', balanceCents: 100_000 },
    ],
    book: buildBook({
      today: '2026-09-15',
      rules: [internet, salary],
      entries: [],
      links: [],
      occurrenceDecisions: [],
    }),
    settings: {
      monthlyIncomeTargetCents: 1_000_000,
      reserveMonths: 6,
      keepReserveContributions: false,
    },
    strategies: [
      {
        id: 'strategy-balanced',
        name: 'Equilibrada',
        isDefault: true,
        allocation: {
          essential: 4_000,
          lifestyle: 2_000,
          investment: 3_000,
          reserve: 1_000,
        },
      },
    ],
    budgets: [],
    goals: [],
    reserveInvestedCents: null,
    categoryBuckets: new Map([
      ['utilities', 'essential'],
      ['salary', 'income'],
    ]),
    rates: emptyRates,
    ...overrides,
  }
}

describe('month', () => {
  it('counts cards in their due month, savings by transfer, estimates and cash in centavos', () => {
    const month = buildMonth(facts(), '2026-09')
    assert.deepStrictEqual(
      {
        incomeCents: month.incomeCents,
        actual: month.actual,
        targets: month.targets,
        expenses: month.family.expenses.map((group) => [
          group.bucket,
          group.knownCents,
          group.estimatedCents,
        ]),
        estimated: month.family.lines
          .filter((line) => line.certainty === 'estimated')
          .map((line) => [line.description, line.cents]),
      },
      {
        incomeCents: 800_000,
        actual: {
          essential: 287_000,
          lifestyle: 15_000,
          investment: 0,
          reserve: 100_000,
        },
        targets: {
          essential: 400_000,
          lifestyle: 200_000,
          investment: 300_000,
          reserve: 100_000,
        },
        expenses: [
          ['essential', 275_000, 12_000],
          ['lifestyle', 15_000, 0],
          ['other', 3_000, 0],
        ],
        estimated: [['Internet Fibra', 12_000]],
      },
    )
    assert.deepStrictEqual(month.cashFlow, {
      forecasting: true,
      openingCashCents: 100_000,
      // 1 000 + 8 000 − 2 500 − 400 − 1 000 − 30
      cashCents: 507_000,
      receivedCents: 800_000,
      paidCents: 393_000,
      expectedIncomeCents: 0,
      remainingExpenseCents: 12_000,
      closingCashCents: 495_000,
      // Investments still owe their whole target.
      afterGoalsCents: 195_000,
    })
    assert.deepStrictEqual(month.integrity.issues, [
      { code: 'uncategorized', count: 1, blocksClosing: true },
    ])
  })

  it('keeps a closed month on the plan it was closed with', () => {
    const month = buildMonth(
      facts({
        budgets: [
          {
            month: '2026-09',
            strategyId: 'strategy-balanced',
            strategyName: 'Equilibrada',
            baseIncomeCents: 500_000,
            eligibleIncomeCents: 800_000,
            allocation: {
              essential: 5_000,
              lifestyle: 2_000,
              investment: 2_000,
              reserve: 1_000,
            },
            effectiveAllocation: {
              essential: 5_000,
              lifestyle: 2_000,
              investment: 2_000,
              reserve: 1_000,
            },
            reserveRedirected: false,
          },
        ],
      }),
      '2026-09',
    )
    assert.deepStrictEqual(
      [
        month.closed,
        month.forecasting,
        month.baseIncomeCents,
        month.targets.essential,
        month.family.estimatedExpenseCents,
      ],
      [true, false, 500_000, 250_000, 0],
    )
  })

  it('plans on the average of the latest three closed months, never above the target', () => {
    const closed = (month: string, eligibleIncomeCents: number) => ({
      month,
      strategyId: 'strategy-balanced',
      strategyName: 'Equilibrada',
      baseIncomeCents: 1_000_000,
      eligibleIncomeCents,
      allocation: {
        essential: 4_000,
        lifestyle: 2_000,
        investment: 3_000,
        reserve: 1_000,
      },
      effectiveAllocation: {
        essential: 4_000,
        lifestyle: 2_000,
        investment: 3_000,
        reserve: 1_000,
      },
      reserveRedirected: false,
    })
    const month = buildMonth(
      facts({
        budgets: [
          closed('2026-08', 900_000),
          closed('2026-07', 600_000),
          closed('2026-06', 600_000),
          closed('2026-05', 3_000_000),
        ],
      }),
      '2026-09',
    )
    assert.strictEqual(month.baseIncomeCents, 700_000)
  })

  it('measures the reserve by the investment positions marked as reserve', () => {
    const goal = {
      id: 'emergency',
      type: 'emergency_reserve' as const,
      targetCents: 600_000,
      currentCents: 100_000,
    }
    const reserveOf = (reserveInvestedCents: number | null) => {
      const { reserve, effectiveAllocation } = buildMonth(
        facts({
          goals: [goal],
          reserveInvestedCents,
          settings: {
            monthlyIncomeTargetCents: 1_000_000,
            reserveMonths: 6,
            keepReserveContributions: false,
          },
        }),
        '2026-09',
      )
      return [
        reserve.currentCents,
        reserve.complete,
        reserve.redirected,
        effectiveAllocation.reserve,
      ]
    }
    assert.deepStrictEqual(
      {
        // No position marked yet: the goal's own amount stands in.
        noPositions: reserveOf(null),
        // The positions reach the target: the reserve share goes to investing.
        invested: reserveOf(600_000),
      },
      {
        noPositions: [100_000, false, false, 1_000],
        invested: [600_000, true, true, 0],
      },
    )
  })
})

describe('cash forecast', () => {
  it('projects recurrences and the daily variable spending from today’s balance', () => {
    const projection = projectCash(facts(), { daysBack: 3, daysAhead: 30 })
    assert.deepStrictEqual(
      {
        starting: projection.startingCents,
        points: projection.points.map((point) => [
          point.date,
          point.balanceCents,
        ]),
        scheduled: projection.scheduled.map((event) => [
          event.date,
          event.name,
          event.amountCents,
        ]),
        // Rent, cinema, market and the uncategorised debit over 60 days.
        daily: projection.dailyVariableCents,
      },
      {
        starting: 507_000,
        points: [
          ['2026-09-12', 610_000],
          ['2026-09-13', 510_000],
          ['2026-09-14', 507_000],
          ['2026-09-15', 507_000],
        ],
        scheduled: [
          ['2026-09-25', 'Internet Fibra', -12_000],
          ['2026-10-05', 'Salário', 800_000],
        ],
        daily: Math.round((250_000 + 15_000 + 25_000 + 3_000) / 60),
      },
    )
  })
})

// A US$ checking account beside the reais ones; PTAX closes on 09-11 and 09-14.
const usdRates = rateTable([
  {
    currency: 'USD',
    date: '2026-09-11',
    rateMicros: 5_000_000,
    source: 'PTAX',
  },
  {
    currency: 'USD',
    date: '2026-09-14',
    rateMicros: 5_500_000,
    source: 'PTAX',
  },
])
const withDollars = (overrides: Partial<MonthFacts> = {}) => {
  const base = facts()
  const streaming: RecurrenceRule = {
    ...internet,
    id: 'streaming',
    name: 'Streaming',
    accountId: 'dollars',
    categoryId: 'utilities',
    amountCents: 1_000,
    currency: 'USD',
    startsOn: '2026-09-28',
    scheduleAnchor: '2026-09-28',
  }
  return facts({
    accounts: [
      ...base.accounts,
      {
        id: 'dollars',
        name: 'Conta em dólar',
        kind: 'checking',
        purpose: 'operating',
        currency: 'USD',
        archived: false,
        company: false,
        card: null,
      },
      {
        id: 'euros',
        name: 'Conta em euro',
        kind: 'checking',
        purpose: 'operating',
        currency: 'EUR',
        archived: false,
        company: false,
        card: null,
      },
    ],
    entries: [
      ...base.entries,
      // US$ 20.00 on Saturday the 12th: Friday's close, R$ 5.00.
      entry(
        'lunch',
        'dollars',
        '2026-09-12',
        -2_000,
        'restaurants',
        'lifestyle',
      ),
      entry('freelance', 'dollars', '2026-09-14', 10_000, 'salary', 'income'),
      entry(
        'croissant',
        'euros',
        '2026-09-14',
        -500,
        'restaurants',
        'lifestyle',
      ),
    ],
    checkpoints: [
      ...base.checkpoints,
      { accountId: 'dollars', asOf: '2026-08-31', balanceCents: 100_000 },
    ],
    book: buildBook({
      today: '2026-09-15',
      rules: [internet, salary, streaming],
      entries: [],
      links: [],
      occurrenceDecisions: [],
    }),
    rates: usdRates,
    ...overrides,
  })
}

describe('other currencies', () => {
  it('counts dollars in reais at the rate of their date and marks them as converted', () => {
    const month = buildMonth(withDollars(), '2026-09')
    const lunch = month.family.lines.find((line) => line.id === 'lunch')!
    const streaming = month.family.lines.find((line) =>
      line.id.startsWith('streaming'),
    )!
    assert.deepStrictEqual(
      {
        lunch: [lunch.cents, lunch.converted],
        streaming: [streaming.cents, streaming.converted?.rateDate],
        income: month.incomeCents,
        // US$ 1 000 − 20 + 100 at the 15th's rate (R$ 5.50) beside R$ 5 070.
        cash: month.cashFlow.cashCents,
        // Only the euro, without a rate, stays out.
        issues: month.integrity.issues.filter(
          (issue) => issue.code === 'other_currency',
        ),
        exchange: month.exchange,
      },
      {
        lunch: [
          10_000,
          {
            currency: 'USD',
            originalCents: 2_000,
            rateMicros: 5_000_000,
            rateDate: '2026-09-11',
            source: 'PTAX',
          },
        ],
        // US$ 10.00 due on the 28th, at the latest rate.
        streaming: [5_500, '2026-09-14'],
        // R$ 8 000 + US$ 100 at R$ 5.50
        income: 855_000,
        cash: 507_000 + 594_000,
        issues: [{ code: 'other_currency', count: 1, blocksClosing: false }],
        exchange: {
          rates: [
            {
              currency: 'USD',
              rateMicros: 5_500_000,
              date: '2026-09-14',
              source: 'PTAX',
            },
          ],
          missing: ['EUR'],
        },
      },
    )
  })

  it('projects dollar recurrences in reais in the cash forecast', () => {
    const projection = projectCash(withDollars(), {
      daysBack: 0,
      daysAhead: 30,
    })
    const streaming = projection.scheduled.find((event) =>
      event.id.startsWith('streaming'),
    )!
    assert.deepStrictEqual(
      [
        projection.startingCents,
        streaming.amountCents,
        streaming.converted?.originalCents,
      ],
      [507_000 + 594_000, -5_500, -1_000],
    )
  })
})

describe('history estimate', () => {
  // Groceries R$ 600, R$ 900 and R$ 3 000 in June–August; delivery in August only.
  const history = (overrides: Partial<MonthFacts> = {}) => {
    const base = facts()
    return facts({
      entries: [
        ...base.entries,
        entry(
          'g6',
          'checking',
          '2026-06-10',
          -60_000,
          'groceries',
          'essential',
        ),
        entry(
          'g7',
          'checking',
          '2026-07-10',
          -90_000,
          'groceries',
          'essential',
        ),
        entry(
          'g8',
          'checking',
          '2026-08-10',
          -320_000,
          'groceries',
          'essential',
        ),
        // A refund nets against its month.
        entry(
          'g8-refund',
          'checking',
          '2026-08-12',
          20_000,
          'groceries',
          'essential',
        ),
        entry('d8', 'checking', '2026-08-15', -40_000, 'delivery', 'lifestyle'),
        // A transfer to the reserve is not spending.
        entry('t7', 'checking', '2026-07-20', -50_000, 'transfer', 'excluded', {
          excludedFromSpending: true,
        }),
        entry(
          'g9',
          'checking',
          '2026-09-03',
          -20_000,
          'groceries',
          'essential',
        ),
      ],
      categoryBuckets: new Map([
        ['utilities', 'essential'],
        ['salary', 'income'],
        ['groceries', 'essential'],
        ['delivery', 'lifestyle'],
      ]),
      ...overrides,
    })
  }

  it('estimates variable categories from the median of the last three months, prorated to the days left', () => {
    const month = buildMonth(history(), '2026-09')
    const estimates = month.family.lines.filter(
      (line) => line.origin === 'history',
    )
    assert.deepStrictEqual(
      {
        estimates: estimates.map((line) => [
          line.categoryId,
          line.certainty,
          line.cents,
        ]),
        historyEstimate: month.family.historyEstimateCents,
        // Internet still scheduled plus the history estimate.
        remaining: month.cashFlow.remainingExpenseCents,
      },
      {
        // Median R$ 900, 15 of 30 days left: R$ 450, as the R$ 450 already
        // spent (R$ 200 here, R$ 250 on the card bill due on the 14th) allows.
        estimates: [['groceries', 'estimated', 45_000]],
        historyEstimate: 45_000,
        remaining: 12_000 + 45_000,
      },
    )
  })

  it('estimates a whole month ahead and nothing for a month already lived', () => {
    const next = buildMonth(history(), '2026-10')
    const lived = buildMonth(history(), '2026-08')
    assert.deepStrictEqual(
      [
        next.family.lines
          .filter((line) => line.origin === 'history')
          .map((line) => [line.categoryId, line.cents]),
        lived.family.historyEstimateCents,
      ],
      [[['groceries', 90_000]], 0],
    )
  })

  it('leaves out what a recurrence already pays', () => {
    const groceriesBox: RecurrenceRule = {
      ...internet,
      id: 'groceries-box',
      name: 'Cesta',
      categoryId: 'groceries',
      amountCents: 90_000,
      startsOn: '2026-06-10',
      scheduleAnchor: '2026-06-10',
      dateToleranceDays: 3,
      amountToleranceBps: 0,
    }
    const base = history()
    const book = buildBook({
      today: '2026-09-15',
      rules: [{ ...groceriesBox, autoMatch: false, active: false }],
      entries: [
        {
          id: 'g7',
          accountId: 'checking',
          bookedOn: '2026-07-10',
          amountCents: -90_000,
          currency: 'BRL',
          description: 'g7',
          status: 'posted',
          categoryId: 'groceries',
          internal: false,
          company: false,
        },
      ],
      links: [
        {
          key: 'g7',
          recurrenceId: 'groceries-box',
          expectedDate: '2026-07-10',
          entryId: 'g7',
          decision: 'confirmed',
          revision: 1,
        },
      ],
      occurrenceDecisions: [],
    })
    const month = buildMonth({ ...base, book }, '2026-09')
    assert.deepStrictEqual(
      month.family.lines
        .filter((line) => line.origin === 'history')
        .map((line) => [line.categoryId, line.cents]),
      // June R$ 600, July paid by the recurrence (0), August R$ 3 000: a
      // median of R$ 600, of which R$ 450 is already spent.
      [['groceries', 15_000]],
    )
  })
})
