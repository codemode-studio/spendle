import { describe, expect, it } from 'vitest'

import type {
  FinanceSnapshot,
  RecurrenceSnapshot,
} from '#/features/finance/snapshot.types'
import { buildRecurrenceGroups } from './recurrence-groups'

function recurrence(
  input: Pick<
    RecurrenceSnapshot,
    | 'id'
    | 'name'
    | 'groupId'
    | 'direction'
    | 'amountCents'
    | 'baseAmountCents'
    | 'frequency'
  > &
    Partial<Pick<RecurrenceSnapshot, 'occurrences'>>,
): RecurrenceSnapshot {
  return {
    ...input,
    active: true,
    matchMode: 'single',
    scheduleAnchor: '2026-09-10',
    occurrences: input.occurrences ?? [],
  } as RecurrenceSnapshot
}

function occurrence(
  id: string,
  expectedDate: string,
): RecurrenceSnapshot['occurrences'][number] {
  return {
    id,
    recurrenceId: 'gym-donald',
    expectedDate,
    expectedAmountCents: 12_000,
    currency: 'BRL',
    direction: 'expense',
    categoryId: 'personal-care',
    status: 'expected',
    resolvedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    matches: [],
  }
}

describe('buildRecurrenceGroups', () => {
  it('preserva totais, grupos, fallback e ordem das ocorrências', () => {
    const recurrenceGroups = [
      { id: 'group-gym', name: 'Academia' },
    ] as FinanceSnapshot['recurrenceGroups']
    const recurrences = [
      recurrence({
        id: 'gym-donald',
        name: 'Academia Donald',
        groupId: 'group-gym',
        direction: 'expense',
        amountCents: 12_000,
        baseAmountCents: 12_000,
        frequency: 'monthly',
        occurrences: [
          occurrence('august', '2026-08-10'),
          occurrence('october', '2026-10-10'),
          occurrence('september', '2026-09-10'),
        ],
      }),
      recurrence({
        id: 'gym-spouse',
        name: 'Academia esposa',
        groupId: 'group-gym',
        direction: 'expense',
        amountCents: 24_000,
        baseAmountCents: 24_000,
        frequency: 'monthly',
      }),
      recurrence({
        id: 'yearly-insurance',
        name: 'Seguro anual',
        groupId: null,
        direction: 'expense',
        amountCents: 120_000,
        baseAmountCents: 120_000,
        frequency: 'yearly',
      }),
    ]

    const result = buildRecurrenceGroups(
      { recurrenceGroups, recurrences },
      { today: '2026-09-15' },
    )
    const expense = result.sections.find(
      (section) => section.direction === 'expense',
    )
    const group = expense?.rows.find((row) => row.type === 'group')
    const firstRecurrence = expense?.rows.find(
      (row) => row.type === 'recurrence',
    )

    expect({
      activeIds: result.active.map((item) => item.id),
      missingConversionCount: result.missingConversionCount,
      monthlyIncome: result.monthlyIncome,
      monthlyExpense: result.monthlyExpense,
      incomeRows: result.sections.find(
        (section) => section.direction === 'income',
      )?.rows,
      expenseRows: expense?.rows.map((row) =>
        row.type === 'group' ? `group:${row.group.id}` : row.item.id,
      ),
      groupMonthlyTotal: group?.monthlyTotal,
      groupMissingConversions: group?.missingConversions,
      sortedOccurrenceIds:
        firstRecurrence?.type === 'recurrence'
          ? firstRecurrence.sortedOccurrences.map((item) => item.id)
          : [],
      currentOccurrenceId:
        firstRecurrence?.type === 'recurrence'
          ? firstRecurrence.occurrence?.id
          : undefined,
    }).toEqual({
      activeIds: ['gym-donald', 'gym-spouse', 'yearly-insurance'],
      missingConversionCount: 0,
      monthlyIncome: 0,
      monthlyExpense: 46_000,
      incomeRows: [],
      expenseRows: [
        'group:group-gym',
        'gym-donald',
        'gym-spouse',
        'yearly-insurance',
      ],
      groupMonthlyTotal: 36_000,
      groupMissingConversions: 0,
      sortedOccurrenceIds: ['october', 'september', 'august'],
      currentOccurrenceId: 'september',
    })
  })
})
