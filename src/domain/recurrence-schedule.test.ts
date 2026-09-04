import { describe, expect, it } from 'vitest'

import {
  LOOKBACK_DAYS,
  addRecurrencePeriod,
  aggregateWindow,
  median,
  occurrenceDates,
  previousRecurrencePeriod,
  shiftDays,
} from './recurrence-schedule'

describe('calendário de recorrências', () => {
  it.each([
    ['2026-01-31', 'monthly', '2026-02-28'],
    ['2024-02-29', 'yearly', '2025-02-28'],
    ['2026-03-30', 'monthly', '2026-04-30'],
  ] as const)(
    'avança %s sem perder o calendário',
    (date, frequency, expected) => {
      expect(addRecurrencePeriod(date, frequency)).toBe(expected)
    },
  )

  it('preserva o dia âncora depois de um mês curto', () => {
    const february = addRecurrencePeriod('2026-01-31', 'monthly', '2026-01-31')
    expect(february).toBe('2026-02-28')
    expect(addRecurrencePeriod(february, 'monthly', '2026-01-31')).toBe(
      '2026-03-31',
    )
    expect(
      previousRecurrencePeriod('2026-03-31', 'monthly', '2026-01-31'),
    ).toBe('2026-02-28')
  })

  it('gera o calendário até hoje e mantém a próxima data futura', () => {
    expect(
      occurrenceDates(
        {
          startsOn: '2026-06-30',
          scheduleAnchor: '2026-06-30',
          nextDate: '2026-09-30',
          frequency: 'monthly',
        },
        { today: '2026-08-15' },
      ),
    ).toEqual(['2026-06-30', '2026-07-30', '2026-08-30', '2026-09-30'])
  })

  it('olha somente um período recente para trás em recorrências legadas', () => {
    expect(LOOKBACK_DAYS).toBe(45)
    expect(
      occurrenceDates(
        {
          startsOn: '1970-01-01',
          scheduleAnchor: '2026-09-10',
          nextDate: '2026-09-10',
          frequency: 'monthly',
        },
        { today: '2026-09-03' },
      ),
    ).toEqual(['2026-08-10', '2026-09-10'])
    expect(shiftDays('2026-09-03', -LOOKBACK_DAYS)).toBe('2026-07-20')
  })

  it('calcula mediana e a janela exclusiva do envelope', () => {
    expect(median([])).toBeUndefined()
    expect(median([9, 1, 5])).toBe(5)
    expect(median([1, 3, 7, 9])).toBe(5)
    expect(
      aggregateWindow(
        { expectedDate: '2026-01-31' },
        { frequency: 'monthly', scheduleAnchor: '2026-01-31' },
      ),
    ).toEqual({ start: '2026-01-31', end: '2026-02-28' })
  })
})
