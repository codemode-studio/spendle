import { assert, describe, it } from '@effect/vitest'

import { convert, rateOn, rateTable, toBrlCents } from './Conversion.ts'

const table = rateTable([
  {
    currency: 'USD',
    date: '2026-10-02',
    rateMicros: 5_250_000,
    source: 'PTAX',
  },
  {
    currency: 'USD',
    date: '2026-09-30',
    rateMicros: 5_230_000,
    source: 'PTAX',
  },
  {
    currency: 'USD',
    date: '2026-10-05',
    rateMicros: 5_260_000,
    source: 'PTAX',
  },
])

describe('toBrlCents', () => {
  it('converts minor units exactly, rounding half away from zero', () => {
    assert.deepStrictEqual(
      [
        toBrlCents(12_345, 'BRL', 1),
        // US$ 100.00 at R$ 5.4321
        toBrlCents(10_000, 'USD', 5_432_100),
        // 0.00123456 BTC at R$ 350 000.00: R$ 432.096
        toBrlCents(123_456, 'BTC', 350_000_000_000),
        // US$ 0.01 at R$ 5.50: half a centavo up, and down for a withdrawal
        toBrlCents(1, 'USD', 5_500_000),
        toBrlCents(-1, 'USD', 5_500_000),
      ],
      [12_345, 54_321, 43_210, 6, -6],
    )
  })
})

describe('rateOn', () => {
  it('applies the latest rate published by the date, the earliest before any, the latest after all', () => {
    assert.deepStrictEqual(
      [
        // Saturday and Sunday carry Friday's close.
        rateOn(table, 'USD', '2026-10-04')?.date,
        rateOn(table, 'USD', '2026-10-02')?.date,
        rateOn(table, 'USD', '2026-09-01')?.date,
        rateOn(table, 'USD', '2026-12-25')?.date,
        rateOn(table, 'EUR', '2026-10-02'),
      ],
      ['2026-10-02', '2026-10-02', '2026-09-30', '2026-10-05', null],
    )
  })
})

describe('convert', () => {
  it('converts at the rate of the date and says how; reais pass through; no rate, no value', () => {
    assert.deepStrictEqual(
      [
        convert(table, -2_000, 'USD', '2026-10-03'),
        convert(table, -2_000, 'BRL', '2026-10-03'),
        convert(table, -2_000, 'EUR', '2026-10-03'),
      ],
      [
        {
          cents: -10_500,
          converted: {
            cents: -10_500,
            currency: 'USD',
            originalCents: -2_000,
            rateMicros: 5_250_000,
            rateDate: '2026-10-02',
            source: 'PTAX',
          },
        },
        { cents: -2_000, converted: null },
        null,
      ],
    )
  })
})
