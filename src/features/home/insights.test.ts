import { describe, expect, it } from 'vitest'

import { addRecurrencePeriod } from '#/domain/recurrence-schedule'

import {
  projectCash,
  shiftDays,
  todayIso,
  upcomingCommitments,
} from './insights'
import type { FinanceSnapshot } from './insights'

function snapshotWithMonthlyRecurrence() {
  const firstDate = shiftDays(todayIso(), 1)
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

  return { snapshot, expectedDates }
}

describe('insights de recorrências futuras', () => {
  it('inclui todas as ocorrências mensais esperadas dentro de 90 dias', () => {
    const { snapshot, expectedDates } = snapshotWithMonthlyRecurrence()

    const commitments = upcomingCommitments(snapshot, 90)
    expect(commitments.map((event) => event.date)).toEqual(expectedDates)

    const projection = projectCash(snapshot, 0, 90)
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
