import { describe, expect, it } from 'vitest'

import { pluggyContinuationStart, pluggyHistoryStart } from './history-window'

describe('Pluggy history window', () => {
  it('starts accounts on the first day of the month, three or six months back', () => {
    expect(pluggyHistoryStart({ today: '2026-09-28', months: 3 })).toBe(
      '2026-06-01',
    )
    expect(pluggyHistoryStart({ today: '2026-09-28', months: 6 })).toBe(
      '2026-03-01',
    )
    expect(pluggyHistoryStart({ today: '2026-02-01', months: 3 })).toBe(
      '2025-11-01',
    )
  })

  it('starts cards at the statement cycle containing the month start', () => {
    expect(
      pluggyHistoryStart({ today: '2026-09-28', months: 3, closingDay: 10 }),
    ).toBe('2026-05-11')
    expect(
      pluggyHistoryStart({ today: '2026-09-28', months: 3, closingDay: 31 }),
    ).toBe('2026-06-01')
    expect(
      pluggyHistoryStart({ today: '2026-06-15', months: 3, closingDay: 30 }),
    ).toBe('2026-03-01')
  })

  it('re-reads a week before the latest local fact', () => {
    expect(pluggyContinuationStart('2026-09-03')).toBe('2026-08-27')
  })
})
