import { assert, describe, it } from '@effect/vitest'

import {
  billPayments,
  cardCycles,
  cycleContaining,
  dueAfter,
} from './Cycles.ts'
import type { CycleEntry, CyclePayment, IssuedStatement } from './Cycles.ts'

describe('cycleContaining', () => {
  it('places a movement in the statement that closes next', () => {
    const terms = { closingDay: 3, dueDay: 10 }
    assert.deepStrictEqual(cycleContaining('2026-07-01', terms), {
      startsOn: '2026-06-04',
      closingOn: '2026-07-03',
      dueOn: '2026-07-10',
      closing: 'forecast',
      due: 'forecast',
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
        due: 'forecast',
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
        due: 'forecast',
      },
    )
  })
})

describe('dueAfter', () => {
  it('moves a due day that clamps onto the closing to the next month', () => {
    // Closing 29 and due 31 both clamp to 28 February.
    assert.strictEqual(dueAfter('2026-02-28', 31), '2026-03-31')
  })

  it('moves a due date on a national holiday to the next business day', () => {
    // 12 October 2026 is a Monday and a national holiday.
    assert.strictEqual(dueAfter('2026-10-05', 12), '2026-10-13')
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

const issued = (
  startsOn: string,
  closingOn: string,
  cents: number,
  fields: Partial<IssuedStatement> = {},
): IssuedStatement => ({
  startsOn,
  closingOn,
  cents,
  dueOn: null,
  netOfPayments: true,
  floorsAtZero: false,
  advanceCents: null,
  ...fields,
})

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

  describe('with charges still pending at the provider', () => {
    const pending = (id: string, bookedOn: string, amountCents: number) => ({
      ...entry(id, bookedOn, amountCents),
      pending: true,
    })
    const items = [
      entry('market', '2026-06-10', -10000),
      pending('hotel', '2026-07-15', -20000),
      // Dated before the 3 July cut, but still pending after that bill came due.
      pending('captured-late', '2026-07-02', -3000),
      pending('refund', '2026-07-20', 500),
      // A later bill's instalment.
      pending('instalment', '2026-09-20', -4000),
    ]
    const view = (today: string, payments: ReadonlyArray<CyclePayment> = []) =>
      build(
        [payment('pay-june', '2026-07-08', 10000), ...payments],
        today,
        [],
        items,
      ).cycles.map((cycle) => [
        cycle.closingOn,
        cycle.billedCents,
        cycle.pendingCents,
        cycle.projectedCents,
        cycle.status,
        cycle.entryIds,
      ])

    it('projects the bill from them, apart from what is billed', () => {
      assert.deepStrictEqual(view('2026-08-05'), [
        ['2026-07-03', 10000, 0, 10000, 'paid', ['market']],
        [
          '2026-08-03',
          0,
          22500,
          22500,
          'due',
          ['hotel', 'captured-late', 'refund'],
        ],
        ['2026-09-03', 0, 0, 0, 'open', []],
      ])
    })

    it('moves those a bill already due still has to the next bill', () => {
      assert.deepStrictEqual(view('2026-08-15').slice(1), [
        ['2026-08-03', 0, 0, 0, 'paid', []],
        [
          '2026-09-03',
          0,
          22500,
          22500,
          'open',
          ['hotel', 'captured-late', 'refund'],
        ],
      ])
    })

    it('lets a payment settle them before they post', () => {
      const paid = build(
        [
          payment('pay-june', '2026-07-08', 10000),
          payment('pay-july', '2026-08-07', 22500),
        ],
        '2026-08-08',
        [],
        items,
      )
      assert.deepStrictEqual(
        [
          paid.cycles.map((cycle) => [cycle.paidCents, cycle.status]),
          paid.unappliedCents,
        ],
        [
          [
            [10000, 'paid'],
            [22500, 'paid'],
            [0, 'open'],
          ],
          0,
        ],
      )
    })
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
      issued('2026-06-04', '2026-07-03', -50000),
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
      [issued('2026-06-04', '2026-07-03', -50000)],
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
      [issued('2026-07-02', '2026-08-02', -35000)],
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
      // The purchase date opens no cycle of its own.
      [
        ['2026-08-03', ['purchase', 'fee']],
        ['2026-09-03', []],
      ],
    )
  })

  it('places a movement in the issued statement that prints it, whatever its purchase date', () => {
    // Inter: bought on 2 July, captured after the 3 July cut and printed on
    // the statement of 4 July to 3 August, due on the 10th.
    const result = cardCycles({
      terms,
      entries: [
        {
          ...entry('late', '2026-07-02', -10000, 'bill-aug'),
          statementClosing: '2026-08-03',
        },
      ],
      payments: [],
      statements: [
        issued('2026-07-04', '2026-08-03', -10000, {
          dueOn: '2026-08-10',
          floorsAtZero: true,
        }),
      ],
      today: '2026-08-05',
    })
    assert.deepStrictEqual(
      result.cycles.map((cycle) => [
        cycle.closingOn,
        cycle.totalCents,
        cycle.entryIds,
        cycle.status,
        cycle.statement?.differenceCents ?? null,
      ]),
      [
        ['2026-08-03', -10000, ['late'], 'due', 0],
        ['2026-09-03', 0, [], 'open', null],
      ],
    )
  })

  it('places a provider bill in the issued statement that prints any of its movements', () => {
    // Only the fee is on the imported statement; the purchase, on the same
    // provider bill, was seen only by Open Finance.
    const result = build(
      [],
      '2026-08-15',
      [issued('2026-07-04', '2026-08-03', -10500)],
      [
        entry('purchase', '2026-07-01', -10000, 'bill-aug'),
        {
          ...entry('fee', '2026-07-03', -500, 'bill-aug'),
          statementClosing: '2026-08-03',
        },
      ],
    )
    assert.deepStrictEqual(
      result.cycles.map((cycle) => [
        cycle.closingOn,
        cycle.entryIds,
        cycle.statement?.differenceCents ?? null,
      ]),
      [
        ['2026-08-03', ['purchase', 'fee'], 0],
        ['2026-09-03', [], null],
      ],
    )
  })

  it('is not overdue before the first business day after the year-end bank closure', () => {
    // Thursday 31 December 2026 has no public banking; 1 January and the
    // weekend follow.
    const result = cardCycles({
      terms: { closingDay: 24, dueDay: 31 },
      entries: [entry('market', '2026-12-10', -10000)],
      payments: [],
      statements: [
        issued('2026-11-25', '2026-12-24', -10000, { dueOn: '2026-12-31' }),
      ],
      today: '2027-01-04',
    })
    assert.deepStrictEqual(
      [result.cycles[0]?.payableUntil, result.cycles[0]?.status],
      ['2027-01-04', 'due'],
    )
  })

  it('proves a cycle against its issued statement', () => {
    const result = build([june], '2026-08-15', [
      issued('2026-06-04', '2026-07-03', -13000),
      issued('2026-07-04', '2026-08-03', -21000),
    ])
    assert.deepStrictEqual(
      result.cycles.map((cycle) => cycle.statement?.differenceCents ?? null),
      [0, -1000, null],
    )
  })
  it('does not apply again a payment the statement already deducts', () => {
    // Inter: R$ 150,00 of purchases, R$ 100,00 paid before the cut, R$ 50,00 due.
    const result = build(
      [payment('early', '2026-07-20', 10000)],
      '2026-08-05',
      [issued('2026-07-04', '2026-08-03', -5000)],
      [entry('market', '2026-07-10', -15000)],
    )
    assert.deepStrictEqual(
      [
        result.cycles[0]?.closingOn,
        result.cycles[0]?.billedCents,
        result.cycles[0]?.paidCents,
        result.cycles[0]?.status,
        result.cycles[0]?.statement,
        result.unappliedCents,
      ],
      [
        '2026-08-03',
        5000,
        0,
        'due',
        { observedCents: -5000, deductedCents: 10000, differenceCents: 0 },
        0,
      ],
    )
  })

  it('lets a payment printed on a charges-only statement pay the previous bill', () => {
    // Nubank: the payment of June's bill is printed on July's, whose total
    // counts only July's purchases.
    for (const netOfPayments of [false, true]) {
      const result = build(
        [payment('june', '2026-07-08', 15000)],
        '2026-08-05',
        [issued('2026-07-04', '2026-08-03', -20000, { netOfPayments })],
        [
          entry('market', '2026-06-10', -15000),
          entry('hotel', '2026-07-15', -20000),
        ],
      )
      assert.deepStrictEqual(
        result.cycles.map((cycle) => [
          cycle.closingOn,
          cycle.paidCents,
          cycle.status,
          cycle.statement?.differenceCents ?? null,
        ]),
        [
          ['2026-07-03', 15000, 'paid', null],
          ['2026-08-03', 0, 'due', 0],
          ['2026-09-03', 0, 'open', null],
        ],
      )
    }
  })

  it('pays the bill a payment was identified for, not the oldest one', () => {
    const result = build(
      [
        {
          ...payment('august', '2026-08-05', 20000),
          via: 'bank',
          settles: '2026-08-03',
        },
      ],
      '2026-08-20',
      [],
      [
        entry('market', '2026-06-10', -10000),
        entry('hotel', '2026-07-15', -20000),
      ],
    )
    assert.deepStrictEqual(
      result.cycles.map((cycle) => [
        cycle.closingOn,
        cycle.paidCents,
        cycle.status,
      ]),
      [
        ['2026-07-03', 0, 'overdue'],
        ['2026-08-03', 20000, 'paid'],
        ['2026-09-03', 0, 'open'],
      ],
    )
  })

  it('never splits an issued period with a forecast closing', () => {
    const result = build(
      [],
      '2026-07-25',
      [issued('2026-06-21', '2026-07-20', -10000)],
      [entry('june', '2026-06-25', -5000), entry('july', '2026-07-12', -5000)],
    )
    assert.deepStrictEqual(
      result.cycles.map((cycle) => [
        cycle.startsOn,
        cycle.closingOn,
        cycle.billedCents,
        cycle.entryIds,
      ]),
      [
        ['2026-06-21', '2026-07-20', 10000, ['june', 'july']],
        ['2026-07-21', '2026-09-03', 0, []],
      ],
    )
  })

  it('keeps the due date the statement prints over the configured day', () => {
    const result = build(
      [],
      '2026-08-12',
      [issued('2026-07-04', '2026-08-03', -5000, { dueOn: '2026-08-15' })],
      [entry('market', '2026-07-10', -5000)],
    )
    assert.deepStrictEqual(
      [
        result.cycles[0]?.dueOn,
        result.cycles[0]?.due,
        result.cycles[0]?.status,
      ],
      ['2026-08-15', 'statement', 'due'],
    )
  })

  it('is not overdue before the business day a printed weekend due date moves to', () => {
    // The statement prints Saturday 15 August; Monday 17 August is the deadline.
    const result = build(
      [],
      '2026-08-16',
      [issued('2026-07-04', '2026-08-03', -5000, { dueOn: '2026-08-15' })],
      [entry('market', '2026-07-10', -5000)],
    )
    assert.deepStrictEqual(
      [
        result.cycles[0]?.dueOn,
        result.cycles[0]?.payableUntil,
        result.cycles[0]?.status,
      ],
      ['2026-08-15', '2026-08-17', 'due'],
    )
  })

  it('is not overdue on the business day after a printed due date on a national holiday', () => {
    // Monday 12 October 2026 is a national holiday; Tuesday is the deadline.
    const result = cardCycles({
      terms: { closingDay: 5, dueDay: 12 },
      entries: [entry('market', '2026-09-20', -10000)],
      payments: [],
      statements: [
        issued('2026-09-06', '2026-10-05', -10000, { dueOn: '2026-10-12' }),
      ],
      today: '2026-10-13',
    })
    assert.deepStrictEqual(
      [
        result.cycles[0]?.dueOn,
        result.cycles[0]?.payableUntil,
        result.cycles[0]?.status,
      ],
      ['2026-10-12', '2026-10-13', 'due'],
    )
  })

  it('pays a balance statement with a payment that reached the card after the cut', () => {
    // Inter: R$ 100,00 due at the 3 August cut; the bank debits it that day
    // and the card receives it on the 4th, after the statement was issued.
    const cutDay = {
      ...payment('cut-day', '2026-08-03', 10000),
      creditedOn: '2026-08-04',
    }
    const august = (items: ReadonlyArray<CycleEntry>) => {
      const result = build(
        [cutDay],
        '2026-08-05',
        [issued('2026-07-04', '2026-08-03', -10000)],
        items,
      )
      return [
        result.cycles[0]?.paidCents,
        result.cycles[0]?.status,
        result.cycles[0]?.statement,
      ]
    }
    assert.deepStrictEqual(august([entry('market', '2026-07-10', -10000)]), [
      10000,
      'paid',
      { observedCents: -10000, deductedCents: 0, differenceCents: 0 },
    ])
    // Entries R$ 50,00 above the statement are a proof difference, not a
    // payment the statement deducted.
    assert.deepStrictEqual(
      august([
        entry('market', '2026-07-10', -10000),
        entry('bakery', '2026-07-20', -5000),
      ]),
      [
        10000,
        'paid',
        { observedCents: -10000, deductedCents: 0, differenceCents: 5000 },
      ],
    )
  })

  it('keeps as credit what a zero balance statement cannot have deducted', () => {
    // R$ 100,00 of purchases, R$ 200,00 paid before the cut, nothing due.
    const result = build(
      [payment('early', '2026-07-20', 20000)],
      '2026-08-05',
      [issued('2026-07-04', '2026-08-03', 0)],
      [entry('market', '2026-07-10', -10000)],
    )
    assert.deepStrictEqual(
      [result.cycles[0]?.statement, result.unappliedCents],
      [{ observedCents: 0, deductedCents: 10000, differenceCents: 0 }, 10000],
    )
  })

  it('spends credit left by a payment on the bills that follow', () => {
    // R$ 200,00 paid on 2 July against June's R$ 100,00 bill.
    const items = [
      entry('market', '2026-06-10', -10000),
      entry('hotel', '2026-07-15', -10000),
    ]
    const august = (statements: ReadonlyArray<IssuedStatement>) => {
      const result = build(
        [payment('twice', '2026-07-02', 20000)],
        '2026-08-12',
        statements,
        items,
      )
      return [
        result.cycles[1]?.paidCents,
        result.cycles[1]?.status,
        result.cycles[1]?.statement?.differenceCents ?? null,
        result.unappliedCents,
      ]
    }
    // Forecast and charges-only bills are paid by the credit.
    assert.deepStrictEqual(august([]), [10000, 'paid', null, 0])
    assert.deepStrictEqual(
      august([
        issued('2026-07-04', '2026-08-03', -10000, { netOfPayments: false }),
      ]),
      [10000, 'paid', 0, 0],
    )
    // June's balance shows the credit in the holder's favour; it still pays July.
    assert.deepStrictEqual(
      august([issued('2026-06-04', '2026-07-03', 10000)]),
      [10000, 'paid', null, 0],
    )
    // A balance statement already shows the credit: nothing left to pay.
    assert.deepStrictEqual(august([issued('2026-07-04', '2026-08-03', 0)]), [
      0,
      'paid',
      0,
      0,
    ])
  })

  it('spends the credit a refund leaves on the bills that follow', () => {
    // June's R$ 200,00 refund exceeds its R$ 100,00 purchase.
    const items = [
      entry('market', '2026-06-10', -10000),
      entry('refund', '2026-06-20', 20000),
      entry('hotel', '2026-07-15', -10000),
    ]
    const august = (statements: ReadonlyArray<IssuedStatement>) => {
      const result = build([], '2026-08-20', statements, items)
      return [
        result.cycles[1]?.paidCents,
        result.cycles[1]?.status,
        result.cycles[1]?.payments.map((paid) => [paid.via, paid.entryId]),
        result.cycles[1]?.statement?.differenceCents ?? null,
        result.unappliedCents,
      ]
    }
    assert.deepStrictEqual(august([]), [
      10000,
      'paid',
      [['credit', 'refund']],
      null,
      0,
    ])
    // June's balance shows the credit; a charges-only July bill is paid by it.
    assert.deepStrictEqual(
      august([
        issued('2026-06-04', '2026-07-03', 10000),
        issued('2026-07-04', '2026-08-03', -10000, { netOfPayments: false }),
      ]),
      [10000, 'paid', [['credit', 'refund']], 0, 0],
    )
    // July's balance already deducts it: nothing is paid twice.
    assert.deepStrictEqual(
      august([
        issued('2026-06-04', '2026-07-03', 10000),
        issued('2026-07-04', '2026-08-03', 0),
      ]),
      [0, 'paid', [], 0, 0],
    )
  })

  it('pays a balance statement that carries an unpaid bill once', () => {
    // July's R$ 100,00 is unpaid; August's balance of R$ 150,00 carries it
    // with R$ 50,00 of new purchases.
    const items = [
      entry('market', '2026-06-10', -10000),
      entry('bakery', '2026-07-15', -5000),
    ]
    const cycles = (
      payments: ReadonlyArray<CyclePayment>,
      statement: IssuedStatement,
    ) => {
      const result = build(payments, '2026-08-20', [statement], items)
      return [
        result.cycles
          .slice(0, 2)
          .map((cycle) => [
            cycle.closingOn,
            cycle.billedCents,
            cycle.carriedCents,
            cycle.paidCents,
            cycle.status,
            cycle.statement?.differenceCents ?? null,
          ]),
        result.unappliedCents,
      ]
    }
    const balance = issued('2026-07-04', '2026-08-03', -15000)
    assert.deepStrictEqual(cycles([], balance), [
      [
        ['2026-07-03', 10000, 0, 0, 'overdue', null],
        ['2026-08-03', 15000, 10000, 0, 'overdue', 0],
      ],
      0,
    ])
    assert.deepStrictEqual(
      cycles([payment('statement', '2026-08-05', 15000)], balance),
      [
        [
          ['2026-07-03', 10000, 0, 10000, 'paid', null],
          ['2026-08-03', 15000, 10000, 5000, 'paid', 0],
        ],
        0,
      ],
    )
    // A charges-only statement does not carry July: the same payment pays both.
    assert.deepStrictEqual(
      cycles(
        [payment('statement', '2026-08-05', 15000)],
        issued('2026-07-04', '2026-08-03', -5000, { netOfPayments: false }),
      ),
      [
        [
          ['2026-07-03', 10000, 0, 10000, 'paid', null],
          ['2026-08-03', 5000, 0, 5000, 'paid', 0],
        ],
        0,
      ],
    )
    // A balance that shows only the new purchases does not carry July, so
    // August still owes them.
    assert.deepStrictEqual(
      cycles([], issued('2026-07-04', '2026-08-03', -5000)),
      [
        [
          ['2026-07-03', 10000, 0, 0, 'overdue', null],
          ['2026-08-03', 5000, 0, 0, 'overdue', 0],
        ],
        0,
      ],
    )
  })

  it('keeps the refund credit a zero amount due cannot print', () => {
    // Inter: R$ 100,00 of purchases and a R$ 200,00 refund leave R$ 100,00
    // in the holder's favour, but the amount due is printed as zero.
    const items = [
      entry('market', '2026-07-10', -10000),
      entry('refund', '2026-07-15', 20000),
      entry('hotel', '2026-08-10', -10000),
    ]
    const september = (floorsAtZero: boolean) => {
      const result = build(
        [],
        '2026-09-20',
        [issued('2026-07-04', '2026-08-03', 0, { floorsAtZero })],
        items,
      )
      return [
        result.cycles
          .slice(0, 2)
          .map((cycle) => [
            cycle.closingOn,
            cycle.paidCents,
            cycle.status,
            cycle.payments.map((paid) => [paid.via, paid.entryId]),
            cycle.statement?.differenceCents ?? null,
          ]),
        result.unappliedCents,
      ]
    }
    assert.deepStrictEqual(september(true), [
      [
        ['2026-08-03', 0, 'paid', [], 0],
        ['2026-09-03', 10000, 'paid', [['credit', 'refund']], null],
      ],
      0,
    ])
    // A balance of exactly zero leaves no credit: the entries differ from it.
    assert.deepStrictEqual(september(false), [
      [
        ['2026-08-03', 0, 'paid', [], -10000],
        ['2026-09-03', 0, 'overdue', [], null],
      ],
      0,
    ])
  })

  it('spends refund credit beyond a zero amount due on the debt it carried, once', () => {
    // July's R$ 100,00 is unpaid; August's R$ 300,00 refund covers it and
    // leaves R$ 200,00. September's zero amount due already deducts R$ 150,00
    // of it, so only R$ 50,00 is left for October.
    const result = build(
      [],
      '2026-10-20',
      [
        issued('2026-07-04', '2026-08-03', 0, { floorsAtZero: true }),
        issued('2026-08-04', '2026-09-03', 0, { floorsAtZero: true }),
      ],
      [
        entry('market', '2026-06-10', -10000),
        entry('refund', '2026-07-15', 30000),
        entry('hotel', '2026-08-10', -15000),
        entry('coffee', '2026-09-10', -10000),
      ],
    )
    assert.deepStrictEqual(
      [
        result.cycles.map((cycle) => [
          cycle.closingOn,
          cycle.paidCents,
          cycle.status,
          cycle.statement?.differenceCents ?? null,
        ]),
        result.unappliedCents,
      ],
      [
        [
          ['2026-07-03', 10000, 'paid', null],
          ['2026-08-03', 0, 'paid', 0],
          ['2026-09-03', 0, 'paid', 0],
          ['2026-10-03', 5000, 'overdue', null],
          ['2026-11-03', 0, 'open', null],
        ],
        0,
      ],
    )
  })

  it('leaves a printed payment of a bill before the history out of the first statement', () => {
    // Nubank prints the 8 July payment of the previous bill on August's
    // statement, whose total counts only August's purchases.
    const august = issued('2026-07-04', '2026-08-03', -20000, {
      netOfPayments: false,
    })
    const july = issued('2026-06-04', '2026-07-03', -20000, {
      netOfPayments: false,
    })
    const hotel = {
      ...entry('hotel', '2026-07-15', -20000),
      statementClosing: '2026-08-03',
    }
    const market = {
      ...entry('market', '2026-06-10', -20000),
      statementClosing: '2026-07-03',
    }
    const printed = (amountCents: number): CyclePayment => ({
      ...payment('pay', '2026-07-08', amountCents),
      statementClosing: '2026-08-03',
    })
    const outcome = (
      amountCents: number,
      statements: ReadonlyArray<IssuedStatement>,
      items: ReadonlyArray<CycleEntry>,
    ) => {
      const result = build(
        [printed(amountCents)],
        '2026-08-05',
        statements,
        items,
      )
      return [
        result.cycles.map((cycle) => [
          cycle.closingOn,
          cycle.paidCents,
          cycle.status,
          cycle.statement?.differenceCents ?? null,
        ]),
        result.unappliedCents,
        result.beforeHistoryCents,
      ]
    }
    // Only August's statement: the payment paid a bill no import shows.
    assert.deepStrictEqual(outcome(20000, [august], [hotel]), [
      [
        ['2026-08-03', 0, 'due', 0],
        ['2026-09-03', 0, 'open', null],
      ],
      0,
      20000,
    ])
    // With July's statement, it pays July.
    assert.deepStrictEqual(outcome(20000, [july, august], [market, hotel]), [
      [
        ['2026-07-03', 20000, 'paid', 0],
        ['2026-08-03', 0, 'due', 0],
        ['2026-09-03', 0, 'open', null],
      ],
      0,
      0,
    ])
    // What exceeds an imported July is credit for August.
    assert.deepStrictEqual(outcome(25000, [july, august], [market, hotel]), [
      [
        ['2026-07-03', 20000, 'paid', 0],
        ['2026-08-03', 5000, 'partially_paid', 0],
        ['2026-09-03', 0, 'open', null],
      ],
      0,
      0,
    ])
  })

  it('lets a payment printed on a balance statement pay the bill before it, not the statement', () => {
    // Inter prints the 8 July payment of the previous bill on August's
    // statement, and still asks R$ 200,00 for August's purchases.
    const hotel = {
      ...entry('hotel', '2026-07-15', -20000),
      statementClosing: '2026-08-03',
    }
    const market = {
      ...entry('market', '2026-06-10', -20000),
      statementClosing: '2026-07-03',
    }
    const outcome = (
      amountCents: number,
      august: IssuedStatement,
      july?: IssuedStatement,
    ) => {
      const result = build(
        [
          {
            ...payment('pay', '2026-07-08', amountCents),
            statementClosing: '2026-08-03',
          },
        ],
        '2026-08-20',
        july === undefined ? [august] : [july, august],
        july === undefined ? [hotel] : [market, hotel],
      )
      return [
        result.cycles.map((cycle) => [
          cycle.closingOn,
          cycle.paidCents,
          cycle.status,
          cycle.statement?.differenceCents ?? null,
        ]),
        result.unappliedCents,
        result.beforeHistoryCents,
      ]
    }
    const inter = (startsOn: string, closingOn: string, cents: number) =>
      issued(startsOn, closingOn, cents, { floorsAtZero: true })
    // Only August's statement: the payment paid a bill no import shows.
    assert.deepStrictEqual(
      outcome(20000, inter('2026-07-04', '2026-08-03', -20000)),
      [
        [
          ['2026-08-03', 0, 'overdue', 0],
          ['2026-09-03', 0, 'open', null],
        ],
        0,
        20000,
      ],
    )
    // With July's statement, it pays July and August stays owed.
    assert.deepStrictEqual(
      outcome(
        20000,
        inter('2026-07-04', '2026-08-03', -20000),
        inter('2026-06-04', '2026-07-03', -20000),
      ),
      [
        [
          ['2026-07-03', 20000, 'paid', 0],
          ['2026-08-03', 0, 'overdue', 0],
          ['2026-09-03', 0, 'open', null],
        ],
        0,
        0,
      ],
    )
    // R$ 250,00 paid against a R$ 200,00 previous bill: the balance of
    // R$ 150,00 deducts only the R$ 50,00 beyond it, with or without July.
    const balance = issued('2026-07-04', '2026-08-03', -15000)
    assert.deepStrictEqual(outcome(25000, balance), [
      [
        ['2026-08-03', 0, 'overdue', 0],
        ['2026-09-03', 0, 'open', null],
      ],
      0,
      20000,
    ])
    assert.deepStrictEqual(
      outcome(25000, balance, issued('2026-06-04', '2026-07-03', -20000)),
      [
        [
          ['2026-07-03', 20000, 'paid', 0],
          ['2026-08-03', 0, 'overdue', 0],
          ['2026-09-03', 0, 'open', null],
        ],
        0,
        0,
      ],
    )
    // Nothing due because R$ 450,00 was paid: the R$ 250,00 Inter prints as
    // anticipated is the advance, and the rest paid the previous bill.
    const floored = issued('2026-07-04', '2026-08-03', 0, {
      floorsAtZero: true,
      advanceCents: 25000,
    })
    assert.deepStrictEqual(outcome(45000, floored), [
      [
        ['2026-08-03', 0, 'paid', 0],
        ['2026-09-03', 0, 'open', null],
      ],
      5000,
      20000,
    ])
    assert.deepStrictEqual(
      outcome(45000, floored, issued('2026-06-04', '2026-07-03', -20000)),
      [
        [
          ['2026-07-03', 20000, 'paid', 0],
          ['2026-08-03', 0, 'paid', 0],
          ['2026-09-03', 0, 'open', null],
        ],
        5000,
        0,
      ],
    )
  })
})

describe('billPayments', () => {
  const terms = { closingDay: 3, dueDay: 10 }
  const entries = [
    entry('market', '2026-06-10', -10000),
    entry('hotel', '2026-07-15', -20000),
  ]
  const debit = (entryId: string, paidOn: string, amountCents: number) => ({
    entryId,
    paidOn,
    amountCents,
  })
  const infer = (
    payments: ReadonlyArray<CyclePayment>,
    debits: ReadonlyArray<ReturnType<typeof debit>>,
  ) =>
    billPayments({
      terms,
      entries,
      payments,
      statements: [],
      today: '2026-08-20',
      debits,
    }).map((inferred) => [inferred.entryId, inferred.settles])

  it('judges a debit by what was owed on its date, before later payments', () => {
    assert.deepStrictEqual(
      infer(
        [payment('august', '2026-08-08', 20000)],
        [debit('july', '2026-07-08', 10000)],
      ),
      [['july', '2026-07-03']],
    )
  })

  it('judges a debit without the refund credit that reached the card after it', () => {
    // July's R$ 100,00 is paid on 8 July; a R$ 150,00 refund on 20 July
    // then pays September's R$ 100,00 and leaves R$ 50,00.
    const input = {
      terms,
      entries: [
        entry('market', '2026-06-10', -10000),
        entry('refund', '2026-07-20', 15000),
        entry('hotel', '2026-08-10', -10000),
      ],
      statements: [],
      today: '2026-09-20',
    }
    const inferred = billPayments({
      ...input,
      payments: [],
      debits: [debit('july', '2026-07-08', 10000)],
    })
    const result = cardCycles({ ...input, payments: inferred })
    assert.deepStrictEqual(
      [
        inferred.map((found) => found.settles),
        result.cycles.map((cycle) => [
          cycle.closingOn,
          cycle.paidCents,
          cycle.status,
        ]),
        result.unappliedCents,
      ],
      [
        ['2026-07-03'],
        [
          ['2026-07-03', 10000, 'paid'],
          ['2026-08-03', 0, 'paid'],
          ['2026-09-03', 10000, 'paid'],
          ['2026-10-03', 0, 'open'],
        ],
        5000,
      ],
    )
  })

  it('names the one bill whose balance the debit equals', () => {
    assert.deepStrictEqual(infer([], [debit('august', '2026-08-05', 20000)]), [
      ['august', '2026-08-03'],
    ])
    assert.deepStrictEqual(infer([], [debit('other', '2026-08-05', 15000)]), [])
  })

  it('names a balance statement whose total, carried bill included, the debit equals', () => {
    const items = [
      entry('market', '2026-06-10', -10000),
      entry('bakery', '2026-07-15', -5000),
    ]
    const statements = [issued('2026-07-04', '2026-08-03', -15000)]
    const input = { terms, entries: items, statements, today: '2026-08-20' }
    const inferred = billPayments({
      ...input,
      payments: [],
      debits: [debit('statement', '2026-08-05', 15000)],
    })
    const result = cardCycles({ ...input, payments: inferred })
    assert.deepStrictEqual(
      [
        inferred.map((found) => found.settles),
        result.cycles
          .slice(0, 2)
          .map((cycle) => [cycle.paidCents, cycle.status]),
      ],
      [
        ['2026-08-03'],
        [
          [10000, 'paid'],
          [5000, 'paid'],
        ],
      ],
    )
  })
})
