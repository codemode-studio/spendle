type RecurrenceFrequency = 'monthly' | 'yearly'

const acceptedRecurrenceMatchStatuses = ['confirmed', 'auto_confirmed'] as const

type AcceptedRecurrenceMatchStatus =
  (typeof acceptedRecurrenceMatchStatuses)[number]

export const recurrenceLinkCandidateLimits = {
  single: 40,
  aggregate: 80,
} as const

export function isAcceptedRecurrenceMatchStatus(
  status: string,
): status is AcceptedRecurrenceMatchStatus {
  return acceptedRecurrenceMatchStatuses.includes(
    status as AcceptedRecurrenceMatchStatus,
  )
}

type RecurrenceMatch = {
  occurrenceId: string
  status: string
  score: number
}

type RecurrenceShape = {
  active: boolean
  matchMode: 'single' | 'aggregate'
  frequency: RecurrenceFrequency
  scheduleAnchor: string
  occurrences: ReadonlyArray<{
    id: string
    expectedDate: string
    status: string
    matches: ReadonlyArray<RecurrenceMatch>
  }>
}

export type RecurrencePresentationStatus =
  | 'in_progress'
  | 'suggested'
  | 'overdue'
  | 'pending'
  | 'done'
  | 'paused'

export function describeRecurrence<const TRecurrence extends RecurrenceShape>(
  recurrence: TRecurrence,
  options: { today: string },
) {
  type Occurrence = TRecurrence['occurrences'][number]
  type Match = Occurrence['matches'][number]

  const occurrences: Occurrence[] = [...recurrence.occurrences].sort(
    (left, right) => right.expectedDate.localeCompare(left.expectedDate),
  )
  const openOccurrences = occurrences.filter(
    (occurrence) => occurrence.status === 'expected',
  )
  const currentOccurrence =
    openOccurrences.find(
      (occurrence) => occurrence.expectedDate <= options.today,
    ) ??
    [...openOccurrences]
      .reverse()
      .find((occurrence) => occurrence.expectedDate > options.today) ??
    occurrences.at(0) ??
    null
  const acceptedMatches: Match[] = occurrences.flatMap((occurrence) =>
    occurrence.matches.filter((match) =>
      isAcceptedRecurrenceMatchStatus(match.status),
    ),
  )
  const currentMatches = (currentOccurrence?.matches ?? []) as Match[]
  const bestSuggestion: Match | null = recurrence.active
    ? ([...currentMatches]
        .filter((match) => match.status === 'suggested')
        .sort((left, right) => right.score - left.score)[0] ?? null)
    : null
  const currentAggregateWindow =
    recurrence.matchMode === 'aggregate' && currentOccurrence
      ? aggregateWindow(currentOccurrence, recurrence)
      : null
  const overdueOccurrences = recurrence.active
    ? openOccurrences.filter((occurrence) =>
        recurrence.matchMode === 'aggregate'
          ? aggregateWindow(occurrence, recurrence).end <= options.today
          : occurrence.expectedDate < options.today,
      )
    : []
  const overdue = overdueOccurrences.length > 0
  const aggregateInProgress = Boolean(
    recurrence.active &&
    currentOccurrence?.status === 'expected' &&
    currentAggregateWindow &&
    currentAggregateWindow.start <= options.today &&
    currentAggregateWindow.end > options.today,
  )

  let status: RecurrencePresentationStatus
  if (!recurrence.active) status = 'paused'
  else if (aggregateInProgress) status = 'in_progress'
  else if (bestSuggestion) status = 'suggested'
  else if (overdue) status = 'overdue'
  else if (currentOccurrence?.status === 'expected') status = 'pending'
  else if (acceptedMatches.length) status = 'done'
  else status = 'pending'

  return {
    status,
    currentOccurrence,
    bestSuggestion,
    acceptedMatches,
    overdueOccurrences,
    overdue,
  }
}

/** The day after the period of `date`, keeping the schedule's anchor day. */
function addRecurrencePeriod(
  date: string,
  frequency: RecurrenceFrequency,
  scheduleAnchor: string,
) {
  const [year, month] = date.split('-').map(Number)
  const [, anchorMonth, anchorDay] = scheduleAnchor.split('-').map(Number)
  const targetYear =
    frequency === 'monthly' ? year + Math.floor(month / 12) : year + 1
  const normalizedMonth = frequency === 'monthly' ? month % 12 : anchorMonth - 1
  const lastDay = new Date(
    Date.UTC(targetYear, normalizedMonth + 1, 0),
  ).getUTCDate()
  return new Date(
    Date.UTC(targetYear, normalizedMonth, Math.min(anchorDay, lastDay)),
  )
    .toISOString()
    .slice(0, 10)
}

/** The window an aggregate occurrence collects payments in; `end` is exclusive. */
function aggregateWindow(
  occurrence: { expectedDate: string },
  recurrence: { frequency: RecurrenceFrequency; scheduleAnchor: string },
) {
  return {
    start: occurrence.expectedDate,
    end: addRecurrencePeriod(
      occurrence.expectedDate,
      recurrence.frequency,
      recurrence.scheduleAnchor,
    ),
  }
}
