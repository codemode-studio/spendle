import { assert, describe, it } from '@effect/vitest'

import { estimateVariableSpending } from './HistoryEstimate.ts'

describe('estimateVariableSpending', () => {
  it('prorates the median month to the days left, capped by what the category still usually spends', () => {
    const estimates = estimateVariableSpending({
      remainingDays: 15,
      monthDays: 30,
      categories: [
        // Median R$ 900,00, nothing spent yet: half of it remains.
        {
          categoryId: 'groceries',
          monthlyCents: [80_000, 90_000, 300_000],
          spentCents: 0,
        },
        // Median R$ 400,00 with R$ 300,00 spent: only R$ 100,00 more.
        {
          categoryId: 'delivery',
          monthlyCents: [40_000, 35_000, 45_000],
          spentCents: 30_000,
        },
        // Already past its usual month: nothing more.
        {
          categoryId: 'fuel',
          monthlyCents: [20_000, 20_000, 20_000],
          spentCents: 25_000,
        },
        // Spent in only one of three months: the median is zero.
        { categoryId: 'gifts', monthlyCents: [0, 0, 50_000], spentCents: 0 },
        // A month of net refunds counts as zero, not as negative spending.
        {
          categoryId: 'pharmacy',
          monthlyCents: [-5_000, 6_000, 6_000],
          spentCents: 0,
        },
      ],
    })
    assert.deepStrictEqual(
      estimates.map((item) => [
        item.categoryId,
        item.medianCents,
        item.estimateCents,
      ]),
      [
        ['groceries', 90_000, 45_000],
        ['delivery', 40_000, 10_000],
        ['pharmacy', 6_000, 3_000],
      ],
    )
  })

  it('estimates nothing once the month has no days left', () => {
    assert.deepStrictEqual(
      estimateVariableSpending({
        remainingDays: 0,
        monthDays: 31,
        categories: [
          {
            categoryId: 'groceries',
            monthlyCents: [90_000, 90_000, 90_000],
            spentCents: 0,
          },
        ],
      }),
      [],
    )
  })
})
