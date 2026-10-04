import { assert, describe, it } from '@effect/vitest'

import { installmentPlans } from './Installments.ts'
import type { InstallmentLine } from './Installments.ts'

const line = (
  entryId: string,
  bookedOn: string,
  description: string,
  amountCents = -10000,
  installment: InstallmentLine['installment'] = null,
): InstallmentLine => ({
  entryId,
  bookedOn,
  amountCents,
  description,
  installment,
})

describe('installmentPlans', () => {
  it('groups successive instalments and projects what is left', () => {
    const [plan] = installmentPlans([
      line('a', '2026-07-15', 'Magazine Luiza PARC 01/10'),
      line('b', '2026-08-15', 'Magazine Luiza PARC 02/10'),
      line('c', '2026-09-15', 'Magazine Luiza Parcela 3 de 10', -10002),
    ])
    assert.deepStrictEqual(
      [plan?.seen, plan?.remaining, plan?.remainingCents, plan?.entryIds],
      [[1, 2, 3], 7, -70014, ['a', 'b', 'c']],
    )
  })

  it('trusts provider metadata for a single instalment', () => {
    const plans = installmentPlans([
      line('a', '2026-09-15', 'Apple Store', -50000, {
        number: 4,
        total: 12,
        purchaseDate: null,
        totalAmountsCents: [],
      }),
    ])
    assert.deepStrictEqual(
      plans.map((plan) => [plan.total, plan.remaining]),
      [[12, 8]],
    )
  })

  it('keeps a first instalment dated on the purchase in the plan of its later bills', () => {
    const metadata = (number: number) => ({
      number,
      total: 3,
      purchaseDate: null,
      totalAmountsCents: [],
    })
    const plans = installmentPlans([
      line('a', '2026-07-04', 'Apple Store', -10000, metadata(1)),
      line('b', '2026-09-10', 'Apple Store', -10000, metadata(2)),
    ])
    assert.deepStrictEqual(
      plans.map((plan) => [plan.seen, plan.remainingCents]),
      [[[1, 2], -10000]],
    )
  })

  it('does not take a lone trailing date for an instalment', () => {
    assert.deepStrictEqual(
      installmentPlans([line('a', '2026-09-15', 'Padaria 03/10')]),
      [],
    )
  })

  it('keeps different purchases of the same store apart', () => {
    const plans = installmentPlans([
      line('a', '2026-08-15', 'Loja PARC 01/03', -3000),
      line('b', '2026-09-15', 'Loja PARC 02/03', -3000),
      line('c', '2026-08-15', 'Loja PARC 01/06', -9000),
      line('d', '2026-09-15', 'Loja PARC 02/06', -9000),
    ])
    assert.deepStrictEqual(
      plans.map((plan) => [plan.total, plan.remaining]),
      [
        [3, 1],
        [6, 4],
      ],
    )
  })

  it('keeps a new purchase apart from a finished one at the same store', () => {
    const plans = installmentPlans([
      line('old-1', '2026-03-15', 'Loja PARC 01/03'),
      line('old-2', '2026-04-15', 'Loja PARC 02/03'),
      line('old-3', '2026-05-15', 'Loja PARC 03/03'),
      line('new-1', '2026-08-15', 'Loja PARC 01/03'),
      line('new-2', '2026-09-15', 'Loja PARC 02/03'),
    ])
    assert.deepStrictEqual(
      plans.map((plan) => [plan.entryIds, plan.remaining]),
      [
        [['old-1', 'old-2', 'old-3'], 0],
        [['new-1', 'new-2'], 1],
      ],
    )
  })

  it('does not take date-like suffixes on nearby days for instalments', () => {
    assert.deepStrictEqual(
      installmentPlans([
        line('a', '2026-10-03', 'Padaria 03/10'),
        line('b', '2026-10-04', 'Padaria 04/10'),
      ]),
      [],
    )
  })

  it('keeps instalments that differ by rounding centavos in one plan', () => {
    const [plan] = installmentPlans([
      line('a', '2026-07-15', 'Loja PARC 01/03', -10004),
      line('b', '2026-08-15', 'Loja PARC 02/03', -10004),
      line('c', '2026-09-15', 'Loja PARC 03/03', -10006),
    ])
    assert.deepStrictEqual(
      [plan?.seen, plan?.remaining, plan?.remainingCents],
      [[1, 2, 3], 0, 0],
    )
  })

  it('takes what remains from the purchase total the provider reports', () => {
    const metadata = (number: number) => ({
      number,
      total: 3,
      purchaseDate: '2026-07-01',
      totalAmountsCents: [10000],
    })
    const [plan] = installmentPlans([
      line('a', '2026-07-15', 'Loja', -3333, metadata(1)),
      line('b', '2026-08-15', 'Loja', -3333, metadata(2)),
    ])
    assert.strictEqual(plan?.remainingCents, -3334)
  })

  it('joins undated instalments to the purchase the provider dated', () => {
    const plans = installmentPlans([
      line('a', '2026-07-15', 'Loja PARC 01/03', -10000, {
        number: 1,
        total: 3,
        purchaseDate: '2026-07-10',
        totalAmountsCents: [],
      }),
      line('b', '2026-08-15', 'Loja PARC 02/03'),
      line('c', '2026-09-15', 'Loja PARC 03/03'),
    ])
    assert.deepStrictEqual(
      plans.map((plan) => [plan.entryIds, plan.remainingCents]),
      [[['a', 'b', 'c'], 0]],
    )
  })

  it('keeps provider instalments without a purchase date apart across years', () => {
    const metadata = (number: number) => ({
      number,
      total: 6,
      purchaseDate: null,
      totalAmountsCents: [],
    })
    const plans = installmentPlans([
      line('a', '2025-01-15', 'Loja', -10000, metadata(1)),
      line('b', '2025-02-15', 'Loja', -10000, metadata(2)),
      line('c', '2026-08-15', 'Loja', -10000, metadata(3)),
      line('d', '2026-09-15', 'Loja', -10000, metadata(4)),
    ])
    assert.deepStrictEqual(
      plans.map((plan) => plan.entryIds),
      [
        ['a', 'b'],
        ['c', 'd'],
      ],
    )
  })
})
