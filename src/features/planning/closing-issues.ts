import { formatShortDate } from '#/domain/period'
import {
  describeRecurrence,
  isAcceptedRecurrenceMatchStatus,
} from '#/domain/recurrence-book'
import type { IntegrityIssue } from '#/domain/financial-summary'
import type { PlanningSnapshot } from '#/features/finance/snapshot.types'

export type ClosingIssueDestination =
  | 'accounts'
  | 'imports'
  | 'recurrences'
  | 'reconciliations'
  | 'transactions'
  | 'uncategorized'

export type ClosingIssuePresentation = {
  code: IntegrityIssue['code']
  count: number
  label: string
  detail: string | null
  actionLabel: string
  destination: ClosingIssueDestination
}

const issueCopy: Record<
  IntegrityIssue['code'],
  Pick<ClosingIssuePresentation, 'label' | 'actionLabel' | 'destination'>
> = {
  uncategorized_confirmed: {
    label: 'Lançamentos sem categoria',
    actionLabel: 'Categorizar',
    destination: 'uncategorized',
  },
  pending_transaction: {
    label: 'Lançamentos pendentes',
    actionLabel: 'Revisar lançamentos',
    destination: 'transactions',
  },
  missing_base_conversion: {
    label: 'Valores sem conversão para BRL',
    actionLabel: 'Revisar lançamentos',
    destination: 'transactions',
  },
  missing_balance_conversion: {
    label: 'Saldos sem conversão para BRL',
    actionLabel: 'Revisar contas',
    destination: 'accounts',
  },
  review_import: {
    label: 'Importações aguardando revisão',
    actionLabel: 'Revisar importações',
    destination: 'imports',
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
  unverified_balance: {
    label: 'Saldos sem verificação recente',
    actionLabel: 'Revisar contas',
    destination: 'accounts',
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

function overdueRecurrenceDetail(data: PlanningSnapshot, today: string) {
  const occurrencesByName = new Map<string, string[]>()
  for (const recurrence of data.recurrences) {
    const overdue = describeRecurrence(recurrence, { today }).overdueOccurrences
    if (!overdue.length) continue
    occurrencesByName.set(
      recurrence.participantLabel || recurrence.name,
      [...overdue]
        .sort((left, right) =>
          left.expectedDate.localeCompare(right.expectedDate),
        )
        .map((occurrence) => formatShortDate(occurrence.expectedDate)),
    )
  }
  const details = [...occurrencesByName].map(
    ([name, dates]) => `${name}: ${formatList(dates)}`,
  )
  return details.length ? formatList(details) : null
}

function recurrenceConflictDetail(data: PlanningSnapshot) {
  const currentMonth = data.dashboard.currentMonth
  const conflicts = data.recurrences.flatMap((recurrence) =>
    recurrence.occurrences.flatMap((occurrence) =>
      occurrence.matches
        .filter(
          (match) =>
            match.categoryConflict &&
            isAcceptedRecurrenceMatchStatus(match.status) &&
            match.transaction?.postedAt.startsWith(currentMonth),
        )
        .map((match) =>
          match.transaction
            ? `${recurrence.participantLabel || recurrence.name}: ${match.transaction.description}`
            : recurrence.participantLabel || recurrence.name,
        ),
    ),
  )
  return conflicts.length ? formatList(conflicts) : null
}

export function buildClosingIssuePresentations(
  data: PlanningSnapshot,
  options: { today: string },
): ClosingIssuePresentation[] {
  return data.dashboard.integrity.issues
    .filter((issue) => issue.blocksClosing)
    .map((issue) => {
      const copy = issueCopy[issue.code]
      const detail =
        issue.code === 'overdue_recurrence'
          ? overdueRecurrenceDetail(data, options.today)
          : issue.code === 'recurrence_category_conflict'
            ? recurrenceConflictDetail(data)
            : null
      return { code: issue.code, count: issue.count, ...copy, detail }
    })
}
