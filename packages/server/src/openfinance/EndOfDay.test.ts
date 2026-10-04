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
})
