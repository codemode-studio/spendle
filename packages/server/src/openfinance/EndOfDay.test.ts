import { assert, describe, it } from '@effect/vitest'

import { endOfDayBalances } from './EndOfDay.ts'

describe('endOfDayBalances', () => {
  it('finds each day closing balance whatever order its lines arrive in', () => {
    // Opening 1000: +500 → 1500, -200 → 1300. Lines arrive reversed.
    assert.deepStrictEqual(
      endOfDayBalances([
        { bookedOn: '2026-09-10', amountCents: -200, balanceAfterCents: 1300 },
        { bookedOn: '2026-09-10', amountCents: 500, balanceAfterCents: 1500 },
        { bookedOn: '2026-09-11', amountCents: -300, balanceAfterCents: 1000 },
      ]),
      [
        { asOf: '2026-09-10', balanceCents: 1300 },
        { asOf: '2026-09-11', balanceCents: 1000 },
      ],
    )
  })

  it('skips a day whose running balances do not fit together', () => {
    assert.deepStrictEqual(
      endOfDayBalances([
        { bookedOn: '2026-09-10', amountCents: -200, balanceAfterCents: 1300 },
        { bookedOn: '2026-09-10', amountCents: 500, balanceAfterCents: 9999 },
      ]),
      [],
    )
  })

  it('skips a day whose lines only add up once a missing one is assumed', () => {
    // Opening 1300: -100 → 1200, (-200 → 1000, left out), +200 → 1200,
    // -100 → 1100. The three lines returned cannot follow one another.
    assert.deepStrictEqual(
      endOfDayBalances([
        { bookedOn: '2026-10-02', amountCents: -100, balanceAfterCents: 1200 },
        { bookedOn: '2026-10-02', amountCents: 200, balanceAfterCents: 1200 },
        { bookedOn: '2026-10-02', amountCents: -100, balanceAfterCents: 1100 },
      ]),
      [],
    )
  })

  it('skips a day whose lines return to where they began', () => {
    // +100 then -100, or -100 then +100: it closed on 1000 or on 1100.
    assert.deepStrictEqual(
      endOfDayBalances([
        { bookedOn: '2026-10-02', amountCents: 100, balanceAfterCents: 1100 },
        { bookedOn: '2026-10-02', amountCents: -100, balanceAfterCents: 1000 },
      ]),
      [],
    )
  })

  it('finds the close of a day that passes the same balance twice', () => {
    // Opening 1000: +100 → 1100, -100 → 1000, +300 → 1300, in any order given.
    assert.deepStrictEqual(
      endOfDayBalances([
        { bookedOn: '2026-10-02', amountCents: 300, balanceAfterCents: 1300 },
        { bookedOn: '2026-10-02', amountCents: -100, balanceAfterCents: 1000 },
        { bookedOn: '2026-10-02', amountCents: 100, balanceAfterCents: 1100 },
      ]),
      [{ asOf: '2026-10-02', balanceCents: 1300 }],
    )
  })

  it('skips a day with a line missing its running balance or amount', () => {
    // The R$50 debit after the R$900 balance carries none: closing is unknown.
    assert.deepStrictEqual(
      endOfDayBalances([
        {
          bookedOn: '2026-09-10',
          amountCents: -10000,
          balanceAfterCents: 90000,
        },
        { bookedOn: '2026-09-10', amountCents: -5000, balanceAfterCents: null },
        {
          bookedOn: '2026-09-11',
          amountCents: -2000,
          balanceAfterCents: 83000,
        },
        { bookedOn: '2026-09-11', amountCents: null, balanceAfterCents: null },
        {
          bookedOn: '2026-09-12',
          amountCents: -3000,
          balanceAfterCents: 80000,
        },
      ]),
      [{ asOf: '2026-09-12', balanceCents: 80000 }],
    )
  })
})
