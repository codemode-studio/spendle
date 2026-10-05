import type { IntegrityIssue, RecurrenceBook } from '@spendle/server/api'

import { formatShortDate } from '#/lib/period'

export type ClosingIssueDestination =
  | 'accounts'
  | 'recurrences'
  | 'reconciliations'
  | 'transactions'
  | 'uncategorized'
  | 'review'

export type ClosingIssuePresentation = {
  code: IntegrityIssue['code']
  count: number
  label: string
  detail: string | null
  actionLabel: string
  destination: ClosingIssueDestination
  blocksClosing: boolean
}

const issueCopy: Record<
  IntegrityIssue['code'],
  Pick<ClosingIssuePresentation, 'label' | 'actionLabel' | 'destination'>
> = {
  uncategorized: {
    label: 'Lançamentos sem categoria',
    actionLabel: 'Categorizar',
    destination: 'uncategorized',
  },
  category_review: {
    label: 'Categorias sugeridas para confirmar',
    actionLabel: 'Revisar categorias',
    destination: 'review',
  },
  pending_entry: {
    label: 'Lançamentos pendentes',
    actionLabel: 'Revisar lançamentos',
    destination: 'transactions',
  },
  suggested_reconciliation: {
    label: 'Conciliações sugeridas',
    actionLabel: 'Revisar conciliações',
    destination: 'reconciliations',
  },
  overdue_recurrence: {
    label: 'Ocorrências recorrentes vencidas',
    actionLabel: 'Revisar recorrências',
    destination: 'recurrences',
  },
  recurrence_category_conflict: {
    label: 'Categorias divergentes em recorrências',
    actionLabel: 'Revisar recorrências',
    destination: 'recurrences',
  },
  missing_balance: {
    label: 'Contas sem saldo registrado',
    actionLabel: 'Conferir contas',
    destination: 'accounts',
  },
  other_currency: {
    label: 'Lançamentos em moeda sem cotação fora dos totais',
    actionLabel: 'Revisar lançamentos',
    destination: 'transactions',
  },
}

function formatList(items: string[], limit = 4) {
  const visible = items.slice(0, limit)
  const hiddenCount = items.length - visible.length
  const formatted = new Intl.ListFormat('pt-BR', {
    style: 'short',
    type: 'conjunction',
  }).format(visible)
  return hiddenCount > 0 ? `${formatted} e mais ${hiddenCount}` : formatted
}

const displayName = (recurrence: RecurrenceBook['recurrences'][number]) =>
  recurrence.participantLabel || recurrence.name

function overdueDetail(book: RecurrenceBook, month: string) {
  const details = book.recurrences.flatMap((recurrence) => {
    const dates = recurrence.occurrences
      .filter(
        (occurrence) =>
          occurrence.overdue && occurrence.expectedDate.slice(0, 7) <= month,
      )
      .map((occurrence) => formatShortDate(occurrence.expectedDate))
    return dates.length
      ? [`${displayName(recurrence)}: ${formatList(dates)}`]
      : []
  })
  return details.length ? formatList(details) : null
}

function conflictDetail(book: RecurrenceBook, month: string) {
  const conflicts = book.recurrences.flatMap((recurrence) =>
    recurrence.occurrences.flatMap((occurrence) =>
      occurrence.matches
        .filter(
          (match) =>
            match.categoryConflict &&
            match.status !== 'suggested' &&
            match.entry.bookedOn.startsWith(month),
        )
        .map(
          (match) => `${displayName(recurrence)}: ${match.entry.description}`,
        ),
    ),
  )
  return conflicts.length ? formatList(conflicts) : null
}

/** Every issue of the month with copy, action and, when the book is known, which recurrences. */
export function presentIssues(
  issues: ReadonlyArray<IntegrityIssue>,
  options: { month: string; book?: RecurrenceBook },
): ClosingIssuePresentation[] {
  return issues
    .filter((issue) => issue.count > 0)
    .map((issue) => {
      const detail = !options.book
        ? null
        : issue.code === 'overdue_recurrence'
          ? overdueDetail(options.book, options.month)
          : issue.code === 'recurrence_category_conflict'
            ? conflictDetail(options.book, options.month)
            : null
      return {
        code: issue.code,
        count: issue.count,
        blocksClosing: issue.blocksClosing,
        ...issueCopy[issue.code],
        detail,
      }
    })
}

/** What must be resolved before the month closes. */
export function buildClosingIssuePresentations(
  issues: ReadonlyArray<IntegrityIssue>,
  options: { month: string; book?: RecurrenceBook },
) {
  return presentIssues(issues, options).filter((issue) => issue.blocksClosing)
}
