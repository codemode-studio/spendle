import { describe, expect, it } from 'vitest'

import type { FamilyTransaction } from '#/domain/ledger'
import { shiftDays } from '#/domain/period'
import { addRecurrencePeriod } from '#/domain/recurrence-schedule'

import {
  categoryBreakdown,
  periodTotals,
  projectCash,
  topMerchants,
  upcomingCommitments,
} from './insights'
import type { FinanceSnapshot } from '#/features/finance/snapshot.types'

function snapshotWithMonthlyRecurrence() {
  const today = '2026-09-04'
  const firstDate = shiftDays(today, 1)
  const secondDate = addRecurrencePeriod(firstDate, 'monthly', firstDate)
  const thirdDate = addRecurrencePeriod(secondDate, 'monthly', firstDate)
  const expectedDates = [firstDate, secondDate, thirdDate]
  const snapshot = {
    accounts: [
      {
        id: 'operating-account',
        active: true,
        purpose: 'operating',
        currency: 'BRL',
        scope: null,
        balanceCents: 0,
      },
    ],
    cards: [],
    reconciliations: [],
    transactions: [],
    recurrences: [
      {
        id: 'monthly-recurrence',
        name: 'Compromisso mensal',
        active: true,
        creditCardId: null,
        baseAmountCents: null,
        frequency: 'monthly',
        scheduleAnchor: firstDate,
        matchMode: 'single',
        occurrences: expectedDates.map((expectedDate, index) => ({
          id: `occurrence-${index + 1}`,
          expectedDate,
          expectedAmountCents: 10_000,
          currency: 'BRL',
          direction: 'expense',
          status: 'expected',
          matches: [],
        })),
      },
    ],
  } as unknown as FinanceSnapshot

  return { snapshot, expectedDates, today }
}

function entry(
  id: string,
  postedAt: string,
  amountCents: number,
  overrides: Partial<FamilyTransaction> = {},
): FamilyTransaction {
  return {
    id: `${id}-${postedAt}-${amountCents}`,
    postedAt,
    description: id,
    normalized: id,
    amountCents,
    categoryId: id,
    categoryName: id,
    color: '#123456',
    bucket: 'essential',
    source: 'account',
    uncategorized: false,
    ...overrides,
  }
}

describe('insights de recorrências futuras', () => {
  it('inclui todas as ocorrências mensais esperadas dentro de 90 dias', () => {
    const { snapshot, expectedDates, today } = snapshotWithMonthlyRecurrence()

    const commitments = upcomingCommitments(snapshot, 90, today)
    expect(commitments.map((event) => event.date)).toEqual(expectedDates)

    const projection = projectCash(snapshot, 0, 90, today)
    const todayPoint = projection.points[projection.todayIndex]
    const balanceChanges = projection.points
      .slice(projection.todayIndex + 1)
      .filter(
        (point, index, futurePoints) =>
          point.balanceCents !==
          (index === 0
            ? todayPoint.balanceCents
            : futurePoints[index - 1].balanceCents),
      )

    expect(balanceChanges.map((point) => point.date)).toEqual(expectedDates)
    expect(balanceChanges.map((point) => point.balanceCents)).toEqual([
      -10_000, -20_000, -30_000,
    ])
  })
})

describe('derivações sobre lançamentos planos', () => {
  const august = { start: '2026-08-01', end: '2026-08-31' }

  it('calcula entradas, gastos, aportes e pendências de categoria no período', () => {
    const totals = periodTotals(
      [
        entry('salary', '2026-08-02', 100_000, { bucket: 'income' }),
        entry('food', '2026-08-03', -10_000),
        entry('tax', '2026-08-04', -2_000, { bucket: 'tax' }),
        entry('reserve', '2026-08-05', -3_000, { bucket: 'reserve' }),
        entry('unknown', '2026-08-06', -500, {
          categoryId: null,
          bucket: null,
          uncategorized: true,
        }),
        entry('outside', '2026-07-31', -99_000),
      ],
      august,
    )

    expect(totals).toMatchObject({
      incomeCents: 100_000,
      spendingCents: 12_000,
      spendingCount: 2,
      allocationCents: 3_000,
      uncategorizedCents: 500,
      uncategorizedCount: 1,
    })
  })

  it('compara o gasto por categoria com a média da janela de referência', () => {
    const breakdown = categoryBreakdown(
      [
        entry('food', '2026-08-05', -9_000),
        entry('housing', '2026-08-10', -3_000),
        entry('food', '2026-07-15', -18_000),
        entry('housing', '2026-06-15', -9_000),
      ],
      { start: '2026-08-01', end: '2026-08-30' },
      90,
    )

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

  it('agrupa estabelecimentos pela descrição normalizada e respeita o limite', () => {
    const merchants = topMerchants(
      [
        entry('first', '2026-08-01', -4_000, {
          description: 'Mercado Um',
          normalized: 'mercado um',
        }),
        entry('second', '2026-08-02', -6_000, {
          description: 'MERCADO UM',
          normalized: 'mercado um',
        }),
        entry('bakery', '2026-08-03', -2_000, {
          description: 'Padaria',
          normalized: '',
        }),
        entry('outside', '2026-07-31', -50_000),
      ],
      august,
      1,
    )

    expect(merchants).toEqual([
      {
        key: 'mercado um',
        name: 'Mercado Um',
        cents: 10_000,
        count: 2,
        categoryName: 'first',
        color: '#123456',
      },
    ])
  })
})
