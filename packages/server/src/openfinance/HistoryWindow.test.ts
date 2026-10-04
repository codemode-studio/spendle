import { assert, describe, it } from '@effect/vitest'

import { continuationStart, historyStart } from './HistoryWindow.ts'

describe('historyStart', () => {
  it('starts an account on the first day of the month N months back', () => {
    assert.strictEqual(
      historyStart({ today: '2026-10-04', months: 3 }),
      '2026-07-01',
    )
    assert.strictEqual(
      historyStart({ today: '2026-10-31', months: 6 }),
      '2026-04-01',
    )
  })

  it('starts a card on the statement cycle that contains that day', () => {
    // Closing on the 3rd: the cycle containing 1 July runs 4 June to 3 July.
    assert.strictEqual(
      historyStart({ today: '2026-10-04', months: 3, closingDay: 3 }),
      '2026-06-04',
    )
    // Closing on the 31st clamps to the month's last day.
    assert.strictEqual(
      historyStart({ today: '2026-05-10', months: 3, closingDay: 31 }),
      '2026-02-01',
    )
  })
})

describe('continuationStart', () => {
  it('re-reads a week before the latest stored fact', () => {
    assert.strictEqual(continuationStart('2026-10-03'), '2026-09-26')
  })
})
