import { assert, describe, it } from '@effect/vitest'

import { cardCycles, cycleContaining, dueAfter } from './Cycles.ts'
import type { CycleEntry, CyclePayment, IssuedStatement } from './Cycles.ts'

describe('cycleContaining', () => {
  it('places a movement in the statement that closes next', () => {
    const terms = { closingDay: 3, dueDay: 10 }
    assert.deepStrictEqual(cycleContaining('2026-07-01', terms), {
      startsOn: '2026-06-04',
      closingOn: '2026-07-03',
      dueOn: '2026-07-10',
      closing: 'forecast',
    })
    assert.deepStrictEqual(
      cycleContaining('2026-07-04', terms).closingOn,
      '2026-08-03',
    )
  })

  it('moves the due date to the next month when it comes before the closing day', () => {
    // 5 July 2026 is a Sunday: the bill is due on Monday.
    assert.deepStrictEqual(
      cycleContaining('2026-06-10', { closingDay: 25, dueDay: 5 }),
      {
        startsOn: '2026-05-26',
        closingOn: '2026-06-25',
        dueOn: '2026-07-06',
        closing: 'forecast',
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
        closing: 'forecast',
      },
    )
  })
})

describe('dueAfter', () => {
  it('moves a due day that clamps onto the closing to the next month', () => {
    // Closing 29 and due 31 both clamp to 28 February.
    assert.strictEqual(dueAfter('2026-02-28', 31), '2026-03-31')
  })

  it('moves a weekend due date to Monday', () => {
    // 11 July 2026 is a Saturday.
    assert.strictEqual(dueAfter('2026-07-03', 11), '2026-07-13')
  })
})

const entry = (
  id: string,
  bookedOn: string,
  amountCents: number,
  billId: string | null = null,
): CycleEntry => ({ id, bookedOn, amountCents, billId })

const payment = (
  entryId: string,
  paidOn: string,
  amountCents: number,
): CyclePayment => ({ entryId, paidOn, amountCents, via: 'card' })

describe('cardCycles', () => {
  const terms = { closingDay: 3, dueDay: 10 }
  const entries = [
    entry('market', '2026-06-10', -10000),
    entry('fuel', '2026-06-20', -5000),
    entry('refund', '2026-07-01', 2000),
    entry('trip', '2026-07-15', -20000),
    entry('coffee', '2026-08-12', -1000),
  ]
  const june = payment('pay-june', '2026-07-08', 13000)

  const build = (
    payments: ReadonlyArray<CyclePayment>,
    today = '2026-08-15',
    statements: ReadonlyArray<IssuedStatement> = [],
    items: ReadonlyArray<CycleEntry> = entries,
  ) => cardCycles({ terms, entries: items, payments, statements, today })

  const statuses = (
    payments: ReadonlyArray<CyclePayment>,
    today = '2026-08-15',
  ) =>
    build(payments, today).cycles.map((cycle) => [
      cycle.closingOn,
      cycle.totalCents,
      cycle.paidCents,
      cycle.status,
    ])

  it('totals each cycle and tells paid, overdue and open apart', () => {
    assert.deepStrictEqual(statuses([june]), [
      ['2026-07-03', -13000, 13000, 'paid'],
      ['2026-08-03', -20000, 0, 'overdue'],
      ['2026-09-03', -1000, 0, 'open'],
    ])
  })

  it('shows a partial payment within the due date, and overdue after it', () => {
    const partial = payment('pay-july', '2026-08-05', 5000)
    assert.deepStrictEqual(statuses([june, partial], '2026-08-08')[1], [
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
    assert.strictEqual(statuses([june, partial])[1]![3], 'overdue')
  })

  it('is not overdue before the business day a weekend due date moves to', () => {
    // Due on Saturday 11 July; Sunday 12 July is still within the deadline.
    const result = cardCycles({
      terms: { closingDay: 3, dueDay: 11 },
      entries: [entry('market', '2026-06-10', -10000)],
      payments: [],
      statements: [],
      today: '2026-07-12',
    })
    assert.deepStrictEqual(
      [result.cycles[0]?.dueOn, result.cycles[0]?.status],
      ['2026-07-13', 'due'],
    )
  })

  it('counts a payment made before the closing for the bill it closes', () => {
    const early = payment('early', '2026-07-02', 13000)
    assert.deepStrictEqual(statuses([early], '2026-07-05')[0], [
      '2026-07-03',
      -13000,
      13000,
      'paid',
    ])
  })

  it('applies one payment to every bill it covers, oldest first, and keeps the rest as credit', () => {
    const result = build([payment('both', '2026-08-05', 35000)])
    assert.deepStrictEqual(
      [
        result.cycles.map((cycle) => [cycle.paidCents, cycle.status]),
        result.cycles[1]!.payments.map((part) => part.amountCents),
        result.unappliedCents,
      ],
      [
        [
          [13000, 'paid'],
          [20000, 'paid'],
          [1000, 'open'],
        ],
        [20000],
        1000,
      ],
    )
  })

  it('bills what the statement says, so missing entries never look paid', () => {
    const result = build([payment('pay', '2026-07-08', 13000)], '2026-07-08', [
      { startsOn: '2026-06-04', closingOn: '2026-07-03', cents: -50000 },
    ])
    assert.deepStrictEqual(
      [
        result.cycles[0]?.billedCents,
        result.cycles[0]?.status,
        result.cycles[0]?.statement?.differenceCents,
      ],
      [50000, 'partially_paid', -37000],
    )
  })

  it('creates the cycle from a statement with no entries', () => {
    const result = build(
      [],
      '2026-07-08',
      [{ startsOn: '2026-06-04', closingOn: '2026-07-03', cents: -50000 }],
      [],
    )
    assert.deepStrictEqual(
      result.cycles.map((cycle) => [cycle.closingOn, cycle.billedCents]),
      [
        ['2026-07-03', 50000],
        ['2026-08-03', 0],
      ],
    )
  })

  it('follows the period the statement was issued for over the configured days', () => {
    // The bill covers 2 July to 2 August although the card closes on the 3rd.
    const result = build(
      [],
      '2026-08-10',
      [{ startsOn: '2026-07-02', closingOn: '2026-08-02', cents: -35000 }],
      [
        entry('june', '2026-06-20', -5000),
        entry('installment', '2026-07-02', -10000),
        entry('phone', '2026-07-11', -25000),
        entry('august', '2026-08-03', -1000),
      ],
    )
    assert.deepStrictEqual(
      result.cycles.map((cycle) => [
        cycle.startsOn,
        cycle.closingOn,
        cycle.closing,
        cycle.entryIds,
        cycle.statement?.differenceCents ?? null,
      ]),
      [
        ['2026-06-04', '2026-07-01', 'statement', ['june'], null],
        ['2026-07-02', '2026-08-02', 'statement', ['installment', 'phone'], 0],
        ['2026-08-03', '2026-09-03', 'forecast', ['august'], null],
      ],
    )
  })

  it('keeps the entries of one provider bill together', () => {
    const result = build(
      [],
      '2026-08-15',
      [],
      [
        entry('purchase', '2026-07-02', -10000, 'bill-aug'),
        entry('fee', '2026-07-09', -500, 'bill-aug'),
      ],
    )
    assert.deepStrictEqual(
      result.cycles.map((cycle) => [cycle.closingOn, cycle.entryIds]),
      [
        ['2026-07-03', []],
        ['2026-08-03', ['purchase', 'fee']],
        ['2026-09-03', []],
      ],
    )
  })

  it('proves a cycle against its issued statement', () => {
    const result = build([june], '2026-08-15', [
      { startsOn: '2026-06-04', closingOn: '2026-07-03', cents: -13000 },
      { startsOn: '2026-07-04', closingOn: '2026-08-03', cents: -21000 },
    ])
    assert.deepStrictEqual(
      result.cycles.map((cycle) => cycle.statement?.differenceCents ?? null),
      [0, -1000, null],
    )
  })
})
