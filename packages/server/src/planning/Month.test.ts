import { assert, describe, it } from '@effect/vitest'

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
