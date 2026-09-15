import { describe, expect, it } from 'vitest'

import { buildHomeView } from './insights'
import type { HomeViewSnapshot } from './insights'

type Row = HomeViewSnapshot['transactions'][number]

function row(
  id: string,
  postedAt: string,
  amountCents: number,
  overrides: Partial<Row> & {
    bucket?: string
    categoryId?: string | null
  } = {},
): Row {
  const { bucket = 'essential', categoryId = id, ...rest } = overrides
  return {
    id: `${id}-${postedAt}-${amountCents}`,
    postedAt,
    description: id,
    normalizedDescription: id,
    amountCents,
    baseAmountCents: null,
    currency: 'BRL',
    status: 'confirmed',
    counterpartyAccountId: null,
    creditCardId: null,
    account: { ownershipScopeId: 'family' },
    creditCard: null,
    category:
      categoryId === null
        ? null
        : { id: categoryId, name: categoryId, color: '#123456', bucket },
    ...rest,
  }
}

function snapshot(
  transactions: Array<Row>,
  options: { partial?: boolean; coverageStart?: string } = {},
): HomeViewSnapshot {
  return {
    scopes: [{ id: 'family', type: 'household' }],
    transactions,
    reconciliations: [],
    accounts: [
      {
        active: true,
        currency: 'BRL',
        scope: { type: 'household' },
        coverage: {
          intervals: [
            { start: options.coverageStart ?? '2026-01-01', end: '2026-08-31' },
          ],
        },
      },
    ],
    cards: [],
    dashboard: {
      integrity: {
        partial: options.partial ?? false,
        issues: [],
        totalCount: 0,
        closingBlockerCount: 0,
      },
    },
  }
}

describe('read model da Home', () => {
  it('calcula entradas, gastos, aportes e pendências de categoria nos últimos 30 dias', () => {
    const view = buildHomeView(
      snapshot([
        row('salary', '2026-08-02', 100_000, { bucket: 'income' }),
        row('food', '2026-08-03', -10_000),
        row('tax', '2026-08-04', -2_000, { bucket: 'tax' }),
        row('reserve', '2026-08-05', -3_000, { bucket: 'reserve' }),
        row('unknown', '2026-08-06', -500, { categoryId: null }),
        row('outside', '2026-08-01', -99_000),
        row('pending', '2026-08-07', -70_000, { status: 'pending' }),
        row('transfer', '2026-08-08', -80_000, { counterpartyAccountId: 'x' }),
      ]),
      '2026-08-31',
    )

    expect(view.last30).toMatchObject({
      period: { start: '2026-08-02', end: '2026-08-31' },
      incomeCents: 100_000,
      spendingCents: 12_000,
      spendingCount: 2,
      allocationCents: 3_000,
      uncategorizedCents: 500,
      uncategorizedCount: 1,
    })
    expect(view.latestPostedAt).toBe('2026-08-06')
  })

  it('compara o gasto por categoria com a média da janela de referência', () => {
    const view = buildHomeView(
      snapshot([
        row('food', '2026-08-05', -9_000),
        row('housing', '2026-08-10', -3_000),
        row('food', '2026-07-15', -18_000),
        row('housing', '2026-06-15', -9_000),
      ]),
      '2026-08-30',
    )

    const breakdown = view.categories30
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
    const view = buildHomeView(
      snapshot(
        Array.from({ length: 9 }, (_, index) =>
          row(`category-${index}`, '2026-08-20', -(1_000 * (9 - index))),
        ),
      ),
      '2026-08-31',
    )
    const items = view.categories30.items
    expect(items).toHaveLength(7)
    expect(items.at(-1)).toMatchObject({
      id: 'other',
      name: 'Outras (3)',
      cents: 6_000,
      count: 3,
      folded: true,
    })
  })

  it('só libera comparações quando a cobertura fecha a janela e não há dados parciais', () => {
    const ready = buildHomeView(snapshot([]), '2026-08-31')
    expect(ready.comparisonReady).toEqual({
      fortnight: true,
      month: true,
      categories: true,
    })

    const shortCoverage = buildHomeView(
      snapshot([], { coverageStart: '2026-07-15' }),
      '2026-08-31',
    )
    expect(shortCoverage.comparisonReady).toEqual({
      fortnight: true,
      month: false,
      categories: false,
    })

    const partial = buildHomeView(snapshot([], { partial: true }), '2026-08-31')
    expect(partial.comparisonReady).toEqual({
      fortnight: false,
      month: false,
      categories: false,
    })
    expect(partial.latestPostedAt).toBeNull()
  })
})
