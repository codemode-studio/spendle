import { describe, expect, it } from 'vite-plus/test'

import type { RecurrenceBook } from '@spendle/server/api'

import { buildRecurrenceGroups } from './recurrence-groups'

type RecurrenceSnapshot = RecurrenceBook['recurrences'][number]

function recurrence(
  input: Pick<
    RecurrenceSnapshot,
    'id' | 'name' | 'groupId' | 'direction' | 'amountCents' | 'frequency'
  > &
    Partial<Pick<RecurrenceSnapshot, 'occurrences'>>,
): RecurrenceSnapshot {
  return {
    ...input,
    participantLabel: null,
    accountId: null,
    categoryId: 'housing',
    currency: 'BRL',
    amountMode: 'fixed',
    destinationMode: 'automatic',
    startsOn: '2026-08-10',
    nextDate: '2026-09-10',
    learnedDescriptions: [],
    active: true,
    matchMode: 'single',
    scheduleAnchor: '2026-09-10',
    converted: null,
    occurrences: input.occurrences ?? [],
  }
}

function occurrence(
  id: string,
  expectedDate: string,
): RecurrenceSnapshot['occurrences'][number] {
  return {
    id,
    expectedDate,
    expectedAmountCents: 12_000,
    currency: 'BRL',
    status: 'expected',
    overdue: false,
    matches: [],
  }
}

describe('buildRecurrenceGroups', () => {
  it('preserva totais, grupos, fallback e ordem das ocorrências', () => {
    const groups = [{ id: 'group-gym', name: 'Academia' }]
    const recurrences = [
      recurrence({
        id: 'gym-donald',
        name: 'Academia Donald',
        groupId: 'group-gym',
        direction: 'expense',
        amountCents: 12_000,
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
        frequency: 'monthly',
      }),
      recurrence({
        id: 'yearly-insurance',
        name: 'Seguro anual',
        groupId: null,
        direction: 'expense',
        amountCents: 120_000,
        frequency: 'yearly',
      }),
    ]

    const result = buildRecurrenceGroups(
      { groups, recurrences },
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

it('separa previsão variável de valores fixos sem contar itens pausados', () => {
  const fixed = {
    ...recurrence({
      id: 'rent',
      name: 'Aluguel',
      groupId: null,
      direction: 'expense',
      amountCents: 200_000,
      frequency: 'monthly',
    }),
    amountMode: 'fixed' as const,
  }
  const variable = {
    ...fixed,
    id: 'market',
    name: 'Mercado',
    amountMode: 'variable' as const,
    amountCents: 445_512,
  }
  const paused = { ...variable, id: 'paused', active: false }
  const result = buildRecurrenceGroups(
    { recurrences: [fixed, variable, paused], groups: [] },
    { today: '2026-09-05' },
  )
  expect(result.monthlyExpense).toBe(645_512)
  expect(result).toMatchObject({
    monthlyFixedExpense: 200_000,
    monthlyVariableExpense: 445_512,
  })
})

it('soma recorrências em outra moeda pela cotação e deixa de fora as sem cotação', () => {
  const streaming = {
    ...recurrence({
      id: 'streaming',
      name: 'Streaming',
      groupId: null,
      direction: 'expense',
      amountCents: 1_000,
      frequency: 'monthly',
    }),
    currency: 'USD',
    converted: {
      cents: 5_500,
      currency: 'USD',
      originalCents: 1_000,
      rateMicros: 5_500_000,
      rateDate: '2026-09-18',
      source: 'PTAX',
    },
  }
  const unquoted = {
    ...recurrence({
      id: 'club',
      name: 'Clube',
      groupId: null,
      direction: 'expense',
      amountCents: 2_000,
      frequency: 'monthly',
    }),
    currency: 'EUR',
  }
  const result = buildRecurrenceGroups(
    { groups: [], recurrences: [streaming, unquoted] },
    { today: '2026-09-20' },
  )
  expect([result.monthlyExpense, result.missingConversionCount]).toEqual([
    5_500, 1,
  ])
})
