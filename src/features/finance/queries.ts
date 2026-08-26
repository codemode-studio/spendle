import { queryOptions } from '@tanstack/react-query'

import {
  getFinanceSnapshotFn,
  getImportReviewSnapshotFn,
} from './finance.functions'

export const financeQueryKeys = {
  all: ['finance'] as const,
  snapshot: (month?: string) =>
    [...financeQueryKeys.all, 'snapshot', month ?? 'current'] as const,
  snapshots: () => [...financeQueryKeys.all, 'snapshot'] as const,
  importReview: () => [...financeQueryKeys.all, 'imports', 'review'] as const,
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
