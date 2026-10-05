import { expect, it } from 'vitest'

import { summarizeCard } from './cards'

const cycle = (
  fields: Partial<Parameters<typeof summarizeCard>[0]['cycles'][number]>,
) => ({
  startsOn: '2026-08-06',
  closingOn: '2026-09-05',
  dueOn: '2026-09-12',
  closing: 'statement' as const,
  due: 'statement' as const,
  payableUntil: '2026-09-12',
  status: 'paid' as const,
  totalCents: 0,
  billedCents: 0,
  carriedCents: 0,
  paidCents: 0,
  entryIds: [],
  payments: [],
  statement: null,
  ...fields,
})

it('owes closed bills, counts the open bill and scheduled instalments against the limit, in centavos', () => {
  const summary = summarizeCard({
    limitCents: 500_000,
    unappliedCents: 1_001,
    cycles: [
      cycle({ status: 'paid', billedCents: 21_030, paidCents: 21_030 }),
      cycle({
        status: 'partially_paid',
        dueOn: '2026-10-12',
        billedCents: 30_051,
        paidCents: 10_000,
        statement: {
          observedCents: 30_052,
          deductedCents: 0,
          differenceCents: 1,
        },
      }),
      cycle({ status: 'open', closingOn: '2026-11-05', billedCents: 13_950 }),
    ],
    installments: [
      {
        key: 'roupas',
        description: 'LOJA DE ROUPAS',
        amountCents: -12_040,
        total: 6,
        seen: [1, 2],
        pending: [],
        scheduled: [],
        entryIds: [],
        remaining: 4,
        remainingCents: -48_160,
        lastBookedOn: '2026-09-28',
      },
    ],
  })
  expect(summary).toMatchObject({
    dueCents: 20_051,
    nextDue: '2026-10-12',
    overdue: false,
    scheduledCents: 48_160,
    // 500.000 − (20.051 + 13.950 + 48.160 − 1.001)
    availableLimitCents: 418_840,
  })
  expect(summary.open?.closingOn).toBe('2026-11-05')
  expect(summary.statementGaps.map((gap) => gap.dueOn)).toEqual(['2026-10-12'])
})
