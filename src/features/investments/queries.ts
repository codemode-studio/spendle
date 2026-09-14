import { queryOptions } from '@tanstack/react-query'

import { getInvestmentsSnapshotFn } from './investments.functions'

export const investmentQueryKeys = {
  all: ['investments'] as const,
  snapshot: () => [...investmentQueryKeys.all, 'snapshot'] as const,
}

export const investmentsOptions = () =>
  queryOptions({
    queryKey: investmentQueryKeys.snapshot(),
    queryFn: () => getInvestmentsSnapshotFn(),
    staleTime: 5 * 60_000,
  })
