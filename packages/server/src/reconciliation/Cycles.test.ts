import { assert, describe, it } from '@effect/vitest'

import { cardCycles, cycleContaining } from './Cycles.ts'

describe('cycleContaining', () => {
  it('places a movement in the statement that closes next', () => {
    const terms = { closingDay: 3, dueDay: 10 }
    assert.deepStrictEqual(cycleContaining('2026-07-01', terms), {
      startsOn: '2026-06-04',
      closingOn: '2026-07-03',
      dueOn: '2026-07-10',
    })
    assert.deepStrictEqual(
      cycleContaining('2026-07-04', terms).closingOn,
      '2026-08-03',
    )
  })

  it('moves the due date to the next month when it comes before the closing day', () => {
    assert.deepStrictEqual(
      cycleContaining('2026-06-10', { closingDay: 25, dueDay: 5 }),
      {
        startsOn: '2026-05-26',
        closingOn: '2026-06-25',
        dueOn: '2026-07-05',
      },
    )
  })

  it('clamps a closing day past the end of the month', () => {
    assert.deepStrictEqual(
      cycleContaining('2026-02-15', { closingDay: 31, dueDay: 10 }),
      {
        startsOn: '2026-02-01',
        closingOn: '2026-02-28',
        dueOn: '2026-03-10',
      },
    )
  })
})

describe('cardCycles', () => {
  const terms = { closingDay: 3, dueDay: 10 }
  const entries = [
    { id: 'market', bookedOn: '2026-06-10', amountCents: -10000 },
    { id: 'fuel', bookedOn: '2026-06-20', amountCents: -5000 },
    { id: 'refund', bookedOn: '2026-07-01', amountCents: 2000 },
    { id: 'trip', bookedOn: '2026-07-15', amountCents: -20000 },
    { id: 'coffee', bookedOn: '2026-08-12', amountCents: -1000 },
  ]
  const june = {
    entryId: 'pay-june',
    paidOn: '2026-07-08',
    amountCents: 13000,
    via: 'card' as const,
  }

  const statuses = (
    payments: Parameters<typeof cardCycles>[0]['payments'],
    today = '2026-08-15',
  ) =>
    cardCycles({ terms, entries, payments, statements: [], today }).map(
      (cycle) => [
        cycle.closingOn,
        cycle.totalCents,
        cycle.paidCents,
        cycle.status,
      ],
    )

  it('totals each cycle and tells paid, overdue and open apart', () => {
    assert.deepStrictEqual(statuses([june]), [
      ['2026-07-03', -13000, 13000, 'paid'],
      ['2026-08-03', -20000, 0, 'overdue'],
      ['2026-09-03', -1000, 0, 'open'],
    ])
  })

  it('shows a partial payment and a bill still within its due date', () => {
    const partial = {
      entryId: 'pay-july',
      paidOn: '2026-08-05',
      amountCents: 5000,
      via: 'bank' as const,
    }
    assert.deepStrictEqual(statuses([june, partial])[1], [
      '2026-08-03',
      -20000,
      5000,
      'partially_paid',
    ])
    assert.deepStrictEqual(statuses([june], '2026-08-08')[1], [
      '2026-08-03',
      -20000,
      0,
      'due',
    ])
  })

  it('proves a cycle against its issued statement', () => {
    const cycles = cardCycles({
      terms,
      entries,
      payments: [june],
      statements: [
        { asOf: '2026-07-03', cents: -13000 },
        { asOf: '2026-08-03', cents: -21000 },
      ],
      today: '2026-08-15',
    })
    assert.deepStrictEqual(
      cycles.map((cycle) => cycle.statement?.differenceCents ?? null),
      [0, -1000, null],
    )
  })
})
