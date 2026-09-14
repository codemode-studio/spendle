import type { TransactionFilters } from './transactions.filters'
import { queryOptions, skipToken } from '@tanstack/react-query'
import type { QueryClient, QueryKey } from '@tanstack/react-query'

import { getOnboardingStatusFn } from '#/features/home/onboarding.functions'

import { assistantQueryKeys } from '#/features/home/query-keys'

import {
  detectRecurrencesFn,
  getFinanceSnapshotFn,
  getCategoryTransactionsFn,
  getTransactionsPageFn,
  getConfigurationSnapshotFn,
  getPlanningSnapshotFn,
  getImportReviewSnapshotFn,
  getKnowledgeBaseFn,
  getStrategyHistoryFn,
  listCardStatementPaymentCandidatesFn,
  listLinkCandidatesFn,
} from './finance.functions'
import type { FinanceSnapshot, TransactionSnapshot } from './snapshot.types'

export const financeQueryKeys = {
  all: ['finance'] as const,
  snapshot: (month?: string) =>
    [...financeQueryKeys.all, 'read', 'snapshot', month ?? 'current'] as const,
  onboarding: () => [...financeQueryKeys.all, 'read', 'onboarding'] as const,
  snapshots: () => [...financeQueryKeys.all, 'read', 'snapshot'] as const,
  importReview: () => [...financeQueryKeys.all, 'imports', 'review'] as const,
  knowledgeBase: () =>
    [...financeQueryKeys.all, 'read', 'knowledge-base'] as const,
  recurrenceDetection: () =>
    [...financeQueryKeys.all, 'recurrences', 'detection'] as const,
  recurrenceLinkCandidatesAll: () =>
    [...financeQueryKeys.all, 'recurrences', 'link-candidates'] as const,
  recurrenceLinkCandidates: (occurrenceId: string) =>
    [...financeQueryKeys.recurrenceLinkCandidatesAll(), occurrenceId] as const,
  cardStatementCandidatesAll: () =>
    [...financeQueryKeys.all, 'cards', 'statement-candidates'] as const,
  cardStatementCandidates: (creditCardId: string, dueDate: string) =>
    [
      ...financeQueryKeys.cardStatementCandidatesAll(),
      creditCardId,
      dueDate,
    ] as const,
  strategyHistories: () =>
    [...financeQueryKeys.all, 'strategy', 'history'] as const,
  strategyHistory: (months: number) =>
    [...financeQueryKeys.strategyHistories(), months] as const,
}

const financeInvalidationKeyFactories = {
  snapshot: () => [...financeQueryKeys.all, 'read'],
  importReview: financeQueryKeys.importReview,
  knowledgeBase: financeQueryKeys.knowledgeBase,
  recurrenceDetection: financeQueryKeys.recurrenceDetection,
  recurrenceLinkCandidates: financeQueryKeys.recurrenceLinkCandidatesAll,
  cardStatementCandidates: financeQueryKeys.cardStatementCandidatesAll,
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
 * | Staged-transaction category (also learns into the knowledge base) | `stagedTransactionCategory` | import review, knowledge base |
 * | Knowledge base review, pattern edit or forget (review and pattern edit resync transactions); knowledge sync from Transações uses `ledger` | `knowledgeBase` | knowledge base + every ledger family |
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
    'cardStatementCandidates',
  ],
  ownershipScope: ['snapshot'],
  stagedTransactionCategory: ['importReview', 'knowledgeBase'],
  knowledgeBase: [
    'knowledgeBase',
    'snapshot',
    'importReview',
    'recurrenceDetection',
    'strategyHistory',
    'recurrenceLinkCandidates',
  ],
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
  type EditableRows = Pick<FinanceSnapshot, 'transactions' | 'categories'>
  const filters: { queryKey: QueryKey }[] = [
    { queryKey: financeQueryKeys.snapshots() },
    { queryKey: [...financeQueryKeys.all, 'read', 'transactions'] },
  ]
  await Promise.all(filters.map((filter) => queryClient.cancelQueries(filter)))
  const previous = filters.flatMap((filter) =>
    queryClient.getQueriesData<EditableRows>(filter),
  )

  for (const filter of filters)
    queryClient.setQueriesData<EditableRows>(filter, (snapshot) => {
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

export async function patchTransactionNote(
  queryClient: QueryClient,
  input: {
    transactionId: TransactionSnapshot['id']
    note: string | null
  },
) {
  type EditableRows = Pick<FinanceSnapshot, 'transactions'>
  const filters: { queryKey: QueryKey }[] = [
    { queryKey: financeQueryKeys.snapshots() },
    { queryKey: [...financeQueryKeys.all, 'read', 'transactions'] },
  ]
  await Promise.all(filters.map((filter) => queryClient.cancelQueries(filter)))
  const previous = filters.flatMap((filter) =>
    queryClient.getQueriesData<EditableRows>(filter),
  )

  for (const filter of filters)
    queryClient.setQueriesData<EditableRows>(filter, (snapshot) =>
      snapshot
        ? {
            ...snapshot,
            transactions: snapshot.transactions.map((transaction) =>
              transaction.id === input.transactionId
                ? { ...transaction, notes: input.note }
                : transaction,
            ),
          }
        : snapshot,
    )

  return () => {
    for (const [queryKey, snapshot] of previous)
      queryClient.setQueryData(queryKey, snapshot)
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

export const cardStatementCandidatesOptions = (input?: {
  creditCardId: string
  dueDate: string
  amountCents?: number
}) =>
  queryOptions({
    queryKey: financeQueryKeys.cardStatementCandidates(
      input?.creditCardId ?? '',
      input?.dueDate ?? '',
    ),
    queryFn: input
      ? () => listCardStatementPaymentCandidatesFn({ data: input })
      : skipToken,
    staleTime: 0,
  })

export const strategyHistoryOptions = (months = 3) =>
  queryOptions({
    queryKey: financeQueryKeys.strategyHistory(months),
    queryFn: () => getStrategyHistoryFn({ data: { months } }),
    staleTime: 60_000,
  })

export const configurationOptions = () =>
  queryOptions({
    queryKey: [...financeQueryKeys.all, 'read', 'configuration'],
    queryFn: () => getConfigurationSnapshotFn(),
    staleTime: 15_000,
  })
export const knowledgeBaseOptions = () =>
  queryOptions({
    queryKey: financeQueryKeys.knowledgeBase(),
    queryFn: () => getKnowledgeBaseFn(),
    staleTime: 15_000,
  })
export const planningOptions = () =>
  queryOptions({
    queryKey: [...financeQueryKeys.all, 'read', 'planning'],
    queryFn: () => getPlanningSnapshotFn(),
    staleTime: 15_000,
  })

export const transactionsPageOptions = (filters: TransactionFilters) =>
  queryOptions({
    queryKey: [...financeQueryKeys.all, 'read', 'transactions', filters],
    queryFn: () => getTransactionsPageFn({ data: filters }),
    staleTime: 15_000,
  })

export const categoryTransactionsOptions = () =>
  queryOptions({
    queryKey: [...financeQueryKeys.all, 'read', 'categories'],
    queryFn: () => getCategoryTransactionsFn(),
    staleTime: 15_000,
  })

export const onboardingOptions = () =>
  queryOptions({
    queryKey: financeQueryKeys.onboarding(),
    queryFn: () => getOnboardingStatusFn(),
    staleTime: 60_000,
  })
