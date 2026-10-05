import { assert, describe, it } from '@effect/vitest'

import { valuePosition } from './Valuation.ts'

const movement = (
  entryId: string,
  bookedOn: string,
  amountCents: number,
  status: 'pending' | 'posted' = 'posted',
) => ({ entryId, bookedOn, amountCents, status })

describe('valuePosition', () => {
  it('values a position by its posted contributions until the person enters a value', () => {
    assert.deepStrictEqual(
      valuePosition({
        openingCents: 10_000,
        movements: [
          movement('in', '2026-09-01', 50_000),
          movement('out', '2026-09-20', -5_000),
          movement('scheduled', '2026-10-15', 20_000),
          movement('settling', '2026-10-03', 7_000, 'pending'),
        ],
        valuations: [],
        referenceDate: '2026-10-04',
      }),
      {
        contributedCents: 55_000,
        currentCents: 55_000,
        valueKind: 'contributions',
        valuedOn: null,
        counted: ['in', 'out'],
        upcoming: ['scheduled', 'settling'],
      },
    )
  })

  it('carries the latest valuation forward with the movements booked after it', () => {
    const value = valuePosition({
      openingCents: 0,
      movements: [
        movement('before', '2026-08-01', 100_000),
        movement('after', '2026-09-10', 20_000),
        movement('future', '2026-11-01', 30_000),
      ],
      valuations: [
        { asOf: '2026-09-01', amountCents: 103_000, sequence: 1 },
        // The same day again: a correction, which wins.
        { asOf: '2026-09-01', amountCents: 104_000, sequence: 2 },
        // Entered for a day after the reference: not known yet.
        { asOf: '2026-10-31', amountCents: 999_999, sequence: 3 },
      ],
      referenceDate: '2026-10-04',
    })
    assert.deepStrictEqual(
      [
        value.currentCents,
        value.contributedCents,
        value.valueKind,
        value.valuedOn,
      ],
      [124_000, 120_000, 'valuation', '2026-09-01'],
    )
  })
})
