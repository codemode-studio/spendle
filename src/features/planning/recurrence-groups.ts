import { describeRecurrence } from '#/domain/recurrence-book'
import type {
  FinanceSnapshot,
  RecurrenceSnapshot,
} from '#/features/finance/snapshot.types'

type RecurrenceGroup = FinanceSnapshot['recurrenceGroups'][number]

export type RecurrenceDisplayRow =
  | {
      type: 'group'
      group: RecurrenceGroup
      items: FinanceSnapshot['recurrences']
      monthlyTotal: number
      missingConversions: number
    }
  | {
      type: 'recurrence'
      item: RecurrenceSnapshot
      sortedOccurrences: RecurrenceSnapshot['occurrences']
      recurrenceBook: ReturnType<typeof describeRecurrence<RecurrenceSnapshot>>
      openOccurrences: RecurrenceSnapshot['occurrences']
      occurrence: RecurrenceSnapshot['occurrences'][number] | null
      acceptedMatch:
        RecurrenceSnapshot['occurrences'][number]['matches'][number] | undefined
      latestAcceptedOccurrence:
        RecurrenceSnapshot['occurrences'][number] | undefined
      suggestedMatch:
        RecurrenceSnapshot['occurrences'][number]['matches'][number] | null
    }

export function buildRecurrenceGroups(
  {
    recurrences,
    recurrenceGroups,
  }: Pick<FinanceSnapshot, 'recurrences' | 'recurrenceGroups'>,
  { today }: { today: string },
) {
  const active = recurrences.filter((item) => item.active)
  const missingConversionCount = active.filter(
    (item) => item.amountCents !== 0 && item.baseAmountCents === null,
  ).length
  const monthlyIncome = active.reduce(
    (sum, item) =>
      sum +
      (item.direction === 'income' && item.baseAmountCents !== null
        ? item.baseAmountCents / (item.frequency === 'yearly' ? 12 : 1)
        : 0),
    0,
  )
  const monthlyExpense = active.reduce(
    (sum, item) =>
      sum +
      (item.direction === 'expense' && item.baseAmountCents !== null
        ? item.baseAmountCents / (item.frequency === 'yearly' ? 12 : 1)
        : 0),
    0,
  )
  // Receitas e despesas ficam em listas separadas; um grupo aparece na lista
  // de cada direção em que tiver recorrências.
  const rowsFor = (direction: 'income' | 'expense'): RecurrenceDisplayRow[] => {
    const directionRecurrences = recurrences.filter(
      (item) => item.direction === direction,
    )
    const groupedRecurrences = recurrenceGroups
      .map((group) => ({
        group,
        items: directionRecurrences.filter((item) => item.groupId === group.id),
      }))
      .filter(({ items }) => items.length > 0)
    const groupedIds = new Set(
      groupedRecurrences.flatMap(({ items }) => items.map((item) => item.id)),
    )
    const recurrenceRow = (item: RecurrenceSnapshot) => {
      const sortedOccurrences = [...item.occurrences].sort((left, right) =>
        right.expectedDate.localeCompare(left.expectedDate),
      )
      const recurrenceBook = describeRecurrence(
        {
          active: item.active,
          matchMode: item.matchMode,
          frequency: item.frequency,
          scheduleAnchor: item.scheduleAnchor,
          occurrences: item.occurrences,
        },
        { today },
      )
      const openOccurrences = sortedOccurrences.filter(
        (candidate) => candidate.status === 'expected',
      )
      const occurrence = recurrenceBook.currentOccurrence
      const acceptedMatch = recurrenceBook.acceptedMatches.at(0)
      const latestAcceptedOccurrence = sortedOccurrences.find(
        (candidate) => candidate.id === acceptedMatch?.occurrenceId,
      )
      const suggestedMatch = recurrenceBook.bestSuggestion
      return {
        type: 'recurrence' as const,
        item,
        sortedOccurrences,
        recurrenceBook,
        openOccurrences,
        occurrence,
        acceptedMatch,
        latestAcceptedOccurrence,
        suggestedMatch,
      }
    }
    return [
      ...groupedRecurrences.flatMap(({ group, items }) => {
        const activeItems = items.filter((item) => item.active)
        const monthlyTotal = activeItems.reduce(
          (sum, item) =>
            sum +
            (item.baseAmountCents === null
              ? 0
              : item.baseAmountCents / (item.frequency === 'yearly' ? 12 : 1)),
          0,
        )
        const missingConversions = activeItems.filter(
          (item) => item.amountCents !== 0 && item.baseAmountCents === null,
        ).length
        return [
          {
            type: 'group' as const,
            group,
            items,
            monthlyTotal,
            missingConversions,
          },
          ...items.map(recurrenceRow),
        ]
      }),
      ...directionRecurrences
        .filter((item) => !groupedIds.has(item.id))
        .map(recurrenceRow),
    ]
  }
  const sections = [
    {
      direction: 'income' as const,
      label: 'Receitas',
      empty: 'Nenhuma receita recorrente cadastrada.',
      monthlyTotal: monthlyIncome,
      rows: rowsFor('income'),
    },
    {
      direction: 'expense' as const,
      label: 'Despesas',
      empty: 'Nenhuma despesa recorrente cadastrada.',
      monthlyTotal: monthlyExpense,
      rows: rowsFor('expense'),
    },
  ]

  return {
    active,
    missingConversionCount,
    monthlyIncome,
    monthlyExpense,
    sections,
  }
}
