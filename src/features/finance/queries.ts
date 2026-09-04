import { queryOptions, skipToken } from '@tanstack/react-query'
import type { QueryClient, QueryKey } from '@tanstack/react-query'

import { assistantQueryKeys } from '#/features/home/query-keys'

import {
  detectRecurrencesFn,
  getFinanceSnapshotFn,
  getImportReviewSnapshotFn,
  getStrategyHistoryFn,
  listLinkCandidatesFn,
} from './finance.functions'
import type { FinanceSnapshot, TransactionSnapshot } from './snapshot.types'

export const financeQueryKeys = {
  all: ['finance'] as const,
  snapshot: (month?: string) =>
    [...financeQueryKeys.all, 'snapshot', month ?? 'current'] as const,
  snapshots: () => [...financeQueryKeys.all, 'snapshot'] as const,
  importReview: () => [...financeQueryKeys.all, 'imports', 'review'] as const,
  recurrenceDetection: () =>
    [...financeQueryKeys.all, 'recurrences', 'detection'] as const,
  recurrenceLinkCandidatesAll: () =>
    [...financeQueryKeys.all, 'recurrences', 'link-candidates'] as const,
  recurrenceLinkCandidates: (occurrenceId: string) =>
    [...financeQueryKeys.recurrenceLinkCandidatesAll(), occurrenceId] as const,
  strategyHistories: () =>
    [...financeQueryKeys.all, 'strategy', 'history'] as const,
  strategyHistory: (months: number) =>
    [...financeQueryKeys.strategyHistories(), months] as const,
}

const financeInvalidationKeyFactories = {
  snapshot: financeQueryKeys.snapshots,
  importReview: financeQueryKeys.importReview,
  recurrenceDetection: financeQueryKeys.recurrenceDetection,
  recurrenceLinkCandidates: financeQueryKeys.recurrenceLinkCandidatesAll,
  strategyHistory: financeQueryKeys.strategyHistories,
  assistant: assistantQueryKeys.status,
}

type FinanceInvalidationFamily = keyof typeof financeInvalidationKeyFactories

/**
 * Mutation invalidation contract:
 *
 * | Mutation paths | Group | Query families |
 * | --- | --- | --- |
 * | Account/card create or update; manual transaction; checkpoint; transaction category/AI categorization; reconciliation; recurrence, detection, match, or settlement; import stage, commit, reject, retry, correction, exclusion, link, or coverage; clear transaction data | `ledger` | snapshot, import review, recurrence detection, strategy history, recurrence link candidates |
 * | Ownership scope create | `ownershipScope` | snapshot |
 * | Staged-transaction category | `stagedTransactionCategory` | import review |
 * | AI consent toggle (updateSettings may refresh reconciliation + recurrences) | `aiConsent` | assistant status + every ledger family |
 * | Strategy activation/settings, goal, or contribution (updateSettings may refresh reconciliation + recurrences) | `strategy` | every ledger family |
 * | Budget close | `budgetClose` | snapshot, strategy history |
 */
export const financeInvalidationGroups = {
  ledger: [
    'snapshot',
    'importReview',
    'recurrenceDetection',
    'strategyHistory',
    'recurrenceLinkCandidates',
  ],
  ownershipScope: ['snapshot'],
  stagedTransactionCategory: ['importReview'],
  // `updateSettings` may run the reconciliation refresh (which also refreshes
  // recurrences), so both settings paths invalidate the ledger families too.
  aiConsent: [
    'assistant',
    'snapshot',
    'importReview',
    'recurrenceDetection',
    'strategyHistory',
    'recurrenceLinkCandidates',
  ],
  strategy: [
    'snapshot',
    'importReview',
    'recurrenceDetection',
    'strategyHistory',
    'recurrenceLinkCandidates',
  ],
  budgetClose: ['snapshot', 'strategyHistory'],
} as const satisfies Record<string, ReadonlyArray<FinanceInvalidationFamily>>

export type FinanceInvalidationScope = keyof typeof financeInvalidationGroups

export function financeInvalidationKeys(
  scope: FinanceInvalidationScope,
): QueryKey[] {
  return financeInvalidationGroups[scope].map((family) =>
    financeInvalidationKeyFactories[family](),
  )
}

export async function invalidateFinance(
  queryClient: QueryClient,
  scope: FinanceInvalidationScope,
) {
  await Promise.all(
    financeInvalidationKeys(scope).map((queryKey) =>
      queryClient.invalidateQueries({ queryKey }),
    ),
  )
}

export async function patchTransactionCategory(
  queryClient: QueryClient,
  input: {
    transactionId: TransactionSnapshot['id']
    categoryId: NonNullable<TransactionSnapshot['categoryId']>
  },
) {
  const filters = { queryKey: financeQueryKeys.snapshots() }
  await queryClient.cancelQueries(filters)
  const previous = queryClient.getQueriesData<FinanceSnapshot>(filters)

  queryClient.setQueriesData<FinanceSnapshot>(filters, (snapshot) => {
    if (!snapshot) return snapshot
    const category =
      snapshot.categories.find((item) => item.id === input.categoryId) ?? null
    return {
      ...snapshot,
      transactions: snapshot.transactions.map((transaction) =>
        transaction.id === input.transactionId
          ? {
              ...transaction,
              categoryId: input.categoryId,
              category: category ?? transaction.category,
            }
          : transaction,
      ),
    }
  })

  return () => {
    for (const [queryKey, snapshot] of previous) {
      queryClient.setQueryData(queryKey, snapshot)
    }
  }
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
