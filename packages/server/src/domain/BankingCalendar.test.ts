import { assert, describe, it } from '@effect/vitest'

import {
  bankHolidays,
  easterSunday,
  isBusinessDay,
  nextBusinessDay,
} from './BankingCalendar.ts'

describe('BankingCalendar', () => {
  it('computes Easter Sunday', () => {
    assert.deepStrictEqual([2024, 2025, 2026, 2027, 2038].map(easterSunday), [
      '2024-03-31',
      '2025-04-20',
      '2026-04-05',
      '2027-03-28',
      '2038-04-25',
    ])
  })

  it('closes banks on Carnival, Good Friday and Corpus Christi', () => {
    assert.deepStrictEqual(
      [2025, 2026, 2027].map((year) =>
        bankHolidays(year).filter((date) =>
          ['02', '03', '04', '05', '06'].includes(date.slice(5, 7)),
        ),
      ),
      [
        [
          '2025-03-03',
          '2025-03-04',
          '2025-04-18',
          '2025-04-21',
          '2025-05-01',
          '2025-06-19',
        ],
        [
          '2026-02-16',
          '2026-02-17',
          '2026-04-03',
          '2026-04-21',
          '2026-05-01',
          '2026-06-04',
        ],
        [
          '2027-02-08',
          '2027-02-09',
          '2027-03-26',
          '2027-04-21',
          '2027-05-01',
          '2027-05-27',
        ],
      ],
    )
  })

  it('moves a due date on a national holiday to the next business day', () => {
    // Monday 12 October 2026 is Nossa Senhora Aparecida.
    assert.deepStrictEqual(
      ['2026-10-12', '2026-12-25', '2027-01-01', '2026-09-07'].map(
        nextBusinessDay,
      ),
      ['2026-10-13', '2026-12-28', '2027-01-04', '2026-09-08'],
    )
  })

  it('chains a holiday into the weekend and the next holiday', () => {
    assert.deepStrictEqual(
      [
        // Good Friday, then the weekend.
        '2026-04-03',
        // Friday 20 November 2026, then the weekend.
        '2026-11-20',
        // The weekend before Carnival Monday and Tuesday.
        '2026-02-14',
      ].map(nextBusinessDay),
      ['2026-04-06', '2026-11-23', '2026-02-18'],
    )
  })

  it('treats 20 November as a holiday only from 2024', () => {
    assert.deepStrictEqual(['2023-11-20', '2024-11-20'].map(isBusinessDay), [
      true,
      false,
    ])
  })

  it('keeps Ash Wednesday and regional holidays as business days', () => {
    // Ash Wednesday 2026 and São Paulo's 25 January and 9 July.
    assert.deepStrictEqual(
      ['2026-02-18', '2027-01-25', '2026-07-09'].map(isBusinessDay),
      [true, true, true],
    )
  })

  it('closes banks to the public on the last weekday of the year', () => {
    // Thursday 31 December 2026, then 1 January and the weekend.
    // 31 December 2022 is a Saturday, so Friday the 30th closes; 31 December
    // 2023 is a Sunday, so Friday the 29th closes.
    assert.deepStrictEqual(
      ['2026-12-31', '2022-12-30', '2023-12-29'].map(nextBusinessDay),
      ['2027-01-04', '2023-01-02', '2024-01-02'],
    )
    assert.deepStrictEqual(
      ['2026-12-30', '2022-12-29', '2023-12-28'].map(isBusinessDay),
      [true, true, true],
    )
  })
})
