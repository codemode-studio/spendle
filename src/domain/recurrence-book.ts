import { normalizeDescription } from './finance'
import { aggregateWindow } from './recurrence-schedule'
import type { RecurrenceFrequency } from './recurrence-schedule'

const DAY_MS = 86_400_000

export const acceptedRecurrenceMatchStatuses = [
  'confirmed',
  'auto_confirmed',
] as const

export type AcceptedRecurrenceMatchStatus =
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
  occurrences: Array<{
    id: string
    expectedDate: string
    status: string
    matches: RecurrenceMatch[]
  }>
}

export type RecurrencePresentationStatus =
  'in_progress' | 'suggested' | 'overdue' | 'pending' | 'done' | 'paused'

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

export type RecurrenceReconciliationType =
  'transfer' | 'fx_transfer' | 'card_payment' | 'refund' | 'profit_distribution'

export function transactionEligibleForRecurrence(transaction: {
  counterpartyAccountId?: string | null
  reconciliationTypes?: ReadonlySet<RecurrenceReconciliationType> | null
}) {
  const types = transaction.reconciliationTypes
  if (
    types?.has('transfer') ||
    types?.has('fx_transfer') ||
    types?.has('card_payment') ||
    types?.has('profit_distribution')
  ) {
    return false
  }
  return !transaction.counterpartyAccountId
}

export function merchantSignature(value: string) {
  return normalizeDescription(value)
    .replace(
      /\b(?:pix|ted|doc|pg|pagamento|pgto|compra|debito|credito|cartao|visa|mastercard)\b/g,
      ' ',
    )
    .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/g, ' ')
    .replace(/\b\d{4,}\b/g, ' ')
    .replace(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export type RecurrenceProjectionRule = {
  expectedDate: string
  expectedAmountCents: number
  currency: string
  direction: 'income' | 'expense'
  amountMode: 'fixed' | 'variable'
  destinationMode: 'automatic' | 'fixed'
  accountId: string | null
  creditCardId: string | null
  dateToleranceDays: number
  amountToleranceBps: number
}

export function pendingTransactionCoversRecurrence(input: {
  recurrenceName: string
  categoryId: string
  rule: RecurrenceProjectionRule
  transaction: {
    id?: string
    postedAt: string
    amountCents: number
    currency: string
    description: string
    status: 'pending' | 'confirmed' | 'excluded'
    accountId: string | null
    creditCardId: string | null
    categoryId?: string | null
  }
}) {
  const { rule, transaction } = input
  if (
    transaction.status !== 'pending' ||
    transaction.currency !== rule.currency ||
    Math.sign(transaction.amountCents) !==
      (rule.direction === 'expense' ? -1 : 1)
  ) {
    return false
  }
  if (
    rule.destinationMode === 'fixed' &&
    ((rule.accountId && transaction.accountId !== rule.accountId) ||
      (rule.creditCardId && transaction.creditCardId !== rule.creditCardId))
  ) {
    return false
  }
  const expectedTime = Date.parse(`${rule.expectedDate}T12:00:00Z`)
  const postedTime = Date.parse(
    `${transaction.postedAt.slice(0, 10)}T12:00:00Z`,
  )
  if (Math.abs(expectedTime - postedTime) / DAY_MS > rule.dateToleranceDays) {
    return false
  }
  const amountDifference = Math.abs(
    Math.abs(transaction.amountCents) - rule.expectedAmountCents,
  )
  const allowedDifference =
    rule.amountMode === 'fixed'
      ? 1
      : Math.max(
          100,
          Math.round(
            (rule.expectedAmountCents * rule.amountToleranceBps) / 10_000,
          ),
        )
  if (amountDifference > allowedDifference) return false

  const transactionSignature = merchantSignature(transaction.description)
  const recurrenceSignature = merchantSignature(input.recurrenceName)
  const descriptionMatches =
    transactionSignature.length > 1 &&
    recurrenceSignature.length > 1 &&
    (transactionSignature.includes(recurrenceSignature) ||
      recurrenceSignature.includes(transactionSignature))
  return transaction.categoryId === input.categoryId || descriptionMatches
}
