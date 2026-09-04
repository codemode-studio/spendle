import { queryOptions, skipToken } from '@tanstack/react-query'

import {
  detectRecurrencesFn,
  getFinanceSnapshotFn,
  getImportReviewSnapshotFn,
  getStrategyHistoryFn,
  listLinkCandidatesFn,
} from './finance.functions'

export const financeQueryKeys = {
  all: ['finance'] as const,
  snapshot: (month?: string) =>
    [...financeQueryKeys.all, 'snapshot', month ?? 'current'] as const,
  snapshots: () => [...financeQueryKeys.all, 'snapshot'] as const,
  importReview: () => [...financeQueryKeys.all, 'imports', 'review'] as const,
  recurrenceDetection: () =>
    [...financeQueryKeys.all, 'recurrences', 'detection'] as const,
  recurrenceLinkCandidates: (occurrenceId: string) =>
    [
      ...financeQueryKeys.all,
      'recurrences',
      'link-candidates',
      occurrenceId,
    ] as const,
  strategyHistory: (months: number) =>
    [...financeQueryKeys.all, 'strategy', 'history', months] as const,
}

export const financeSnapshotOptions = (month?: string) =>
  queryOptions({
    queryKey: financeQueryKeys.snapshot(month),
    queryFn: () => getFinanceSnapshotFn({ data: { month } }),
    staleTime: 15_000,
  })

export const importReviewOptions = () =>
  queryOptions({
    queryKey: financeQueryKeys.importReview(),
    queryFn: () => getImportReviewSnapshotFn(),
    staleTime: 15_000,
  })

export const recurrenceDetectionOptions = () =>
  queryOptions({
    queryKey: financeQueryKeys.recurrenceDetection(),
    queryFn: () => detectRecurrencesFn(),
    staleTime: 15_000,
  })

export const recurrenceLinkCandidatesOptions = (occurrenceId?: string) =>
  queryOptions({
    queryKey: financeQueryKeys.recurrenceLinkCandidates(occurrenceId ?? ''),
    queryFn: occurrenceId
      ? () => listLinkCandidatesFn({ data: { occurrenceId } })
      : skipToken,
    staleTime: 0,
  })

export const strategyHistoryOptions = (months = 3) =>
  queryOptions({
    queryKey: financeQueryKeys.strategyHistory(months),
    queryFn: () => getStrategyHistoryFn({ data: { months } }),
    staleTime: 60_000,
  })
