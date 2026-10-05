import { describe, expect, it } from 'vitest'

import type { FamilyTransaction } from '#/lib/ledger'

import { buildHomeView } from './insights'

function row(
  id: string,
  postedAt: string,
  amountCents: number,
  overrides: { bucket?: string; categoryId?: string | null } = {},
): FamilyTransaction {
  const { bucket = 'essential', categoryId = id } = overrides
  return {
    id: `${id}-${postedAt}-${amountCents}`,
    postedAt,
    description: id,
    normalized: id,
    amountCents,
    categoryId,
    categoryName: categoryId ?? 'Sem categoria',
    color: '#123456',
    bucket: categoryId === null ? null : bucket,
    source: 'account',
    uncategorized: categoryId === null,
  }
}

const view = (
  transactions: Array<FamilyTransaction>,
  today: string,
  partial = false,
) =>
  buildHomeView(
    [...transactions, row('opening', '2026-01-01', 0)],
    { partial },
    today,
  )

describe('read model da Home', () => {
  it('calcula entradas, gastos, aportes e pendências de categoria nos últimos 30 dias', () => {
    const home = view(
      [
        row('salary', '2026-08-02', 100_000, { bucket: 'income' }),
        row('food', '2026-08-03', -10_000),
        row('tax', '2026-08-04', -2_000, { bucket: 'tax' }),
        row('reserve', '2026-08-05', -3_000, { bucket: 'reserve' }),
        row('unknown', '2026-08-06', -500, { categoryId: null }),
        row('outside', '2026-08-01', -99_000),
        row('transfer', '2026-08-08', -80_000, { bucket: 'excluded' }),
      ],
      '2026-08-31',
    )

    expect(home.last30).toMatchObject({
      period: { start: '2026-08-02', end: '2026-08-31' },
      incomeCents: 100_000,
      spendingCents: 12_000,
      spendingCount: 2,
      allocationCents: 3_000,
      uncategorizedCents: 500,
      uncategorizedCount: 1,
    })
    expect(home.latestPostedAt).toBe('2026-08-08')
  })

  it('compara o gasto por categoria com a média da janela de referência', () => {
    const breakdown = view(
      [
        row('food', '2026-08-05', -9_000),
        row('housing', '2026-08-10', -3_000),
        row('food', '2026-07-15', -18_000),
        row('housing', '2026-06-15', -9_000),
      ],
      '2026-08-30',
    ).categories30
    expect(breakdown.totalCents).toBe(12_000)
    expect(breakdown.referenceTotalCents).toBe(9_000)
    expect(breakdown.items.map((item) => item.id)).toEqual(['food', 'housing'])
    expect(breakdown.items[0]).toMatchObject({
      cents: 9_000,
      share: 0.75,
      referenceCents: 6_000,
      deltaCents: 3_000,
      deltaRatio: 0.5,
    })
    expect(breakdown.items[1]).toMatchObject({
      referenceCents: 3_000,
      deltaRatio: 0,
    })
  })

  it('agrupa as categorias além do limite em "Outras"', () => {
    const items = view(
      Array.from({ length: 9 }, (_, index) =>
        row(`category-${index}`, '2026-08-20', -(1_000 * (9 - index))),
      ),
      '2026-08-31',
    ).categories30.items
    expect(items).toHaveLength(7)
    expect(items.at(-1)).toMatchObject({
      id: 'other',
      name: 'Outras (3)',
      cents: 6_000,
      count: 3,
      folded: true,
    })
  })

  it('só libera comparações quando o histórico cobre a janela e não há dados parciais', () => {
    expect(view([], '2026-08-31').comparisonReady).toEqual({
      fortnight: true,
      month: true,
      categories: true,
    })
    const short = buildHomeView(
      [row('food', '2026-07-15', -100)],
      { partial: false },
      '2026-08-31',
    )
    expect(short.comparisonReady).toEqual({
      fortnight: true,
      month: false,
      categories: false,
    })
    expect(view([], '2026-08-31', true).comparisonReady).toEqual({
      fortnight: false,
      month: false,
      categories: false,
    })
    expect(
      buildHomeView([], { partial: false }, '2026-08-31').latestPostedAt,
    ).toBeNull()
  })
})
