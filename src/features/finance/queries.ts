import { queryOptions } from '@tanstack/react-query'
import type { QueryClient, QueryKey } from '@tanstack/react-query'

import { getOnboardingStatusFn } from '#/features/home/onboarding.functions'

import { assistantQueryKeys } from '#/features/home/query-keys'

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
  assistantAnalysis: assistantQueryKeys.analyses,
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
 * | Plan (income, strategy, reserve) or goal | `strategy` | every ledger family |
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
    'assistantAnalysis',
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
    'assistantAnalysis',
  ],
  strategy: [
    'assistantAnalysis',
    'snapshot',
    'importReview',
    'recurrenceDetection',
    'strategyHistory',
    'recurrenceLinkCandidates',
  ],
  budgetClose: ['snapshot', 'strategyHistory', 'assistantAnalysis'],
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

export const onboardingOptions = () =>
  queryOptions({
    queryKey: financeQueryKeys.onboarding(),
    queryFn: () => getOnboardingStatusFn(),
    staleTime: 60_000,
    gcTime: 30 * 60_000,
  })
