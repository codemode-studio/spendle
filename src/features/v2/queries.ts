import { queryOptions, skipToken } from '@tanstack/react-query'
import type { QueryClient, QueryKey } from '@tanstack/react-query'

import type { Entry } from '@spendle/server/api'

import { financeQueryKeys, invalidateFinance } from '#/features/finance/queries'
import type { FinanceInvalidationScope } from '#/features/finance/queries'

import {
  balanceProofFn,
  listAccountsFn,
  listOwnersFn,
} from './accounts.functions'
import { listCategoriesFn } from './categories.functions'
import {
  categoryReviewFn,
  entriesPageFn,
  entryCountsFn,
} from './entries.functions'
import type { EntryPageQuery } from './entries.functions'
import {
  connectSettingsFn,
  listConnectionsFn,
  providerAccountsFn,
} from './open-finance.functions'

/**
 * V2 reads live under `['finance', 'read', …]`, so every invalidation group
 * that refreshes the ledger (`invalidateFinance(queryClient, 'ledger')`) also
 * refreshes them.
 */
export const v2QueryKeys = {
  owners: () => [...financeQueryKeys.all, 'read', 'owners'] as const,
  accounts: (includeArchived = false) =>
    [
      ...financeQueryKeys.all,
      'read',
      'accounts',
      includeArchived ? 'all' : 'active',
    ] as const,
  balanceProof: (accountId: string) =>
    [...financeQueryKeys.all, 'read', 'balance-proof', accountId] as const,
  connections: () =>
    [...financeQueryKeys.all, 'read', 'open-finance', 'connections'] as const,
  providerAccounts: (connectionId: string) =>
    [
      ...financeQueryKeys.all,
      'read',
      'open-finance',
      'provider-accounts',
      connectionId,
    ] as const,
  /** Same prefix as the V1 transaction pages, which category edits patch. */
  entriesPages: () =>
    [...financeQueryKeys.all, 'read', 'transactions'] as const,
  entriesPage: (query: EntryPageQuery) =>
    [...v2QueryKeys.entriesPages(), query] as const,
  entryCounts: () => [...financeQueryKeys.all, 'read', 'entry-counts'] as const,
  categories: (includeArchived = false) =>
    [
      ...financeQueryKeys.all,
      'read',
      'category-list',
      includeArchived ? 'all' : 'active',
    ] as const,
  categoryReview: () =>
    [...financeQueryKeys.all, 'read', 'category-review'] as const,
  connectSettings: () =>
    [...financeQueryKeys.all, 'open-finance', 'connect-settings'] as const,
}

export const ownersOptions = () =>
  queryOptions({
    queryKey: v2QueryKeys.owners(),
    queryFn: () => listOwnersFn(),
    staleTime: 60_000,
  })

export const accountsOptions = (includeArchived = false) =>
  queryOptions({
    queryKey: v2QueryKeys.accounts(includeArchived),
    queryFn: () => listAccountsFn({ data: { includeArchived } }),
    staleTime: 15_000,
  })

export const balanceProofOptions = (accountId?: string) =>
  queryOptions({
    queryKey: v2QueryKeys.balanceProof(accountId ?? ''),
    queryFn: accountId
      ? () => balanceProofFn({ data: { accountId } })
      : skipToken,
    staleTime: 15_000,
  })

export const connectionsOptions = () =>
  queryOptions({
    queryKey: v2QueryKeys.connections(),
    queryFn: () => listConnectionsFn(),
    staleTime: 15_000,
  })

export const providerAccountsOptions = (connectionId: string) =>
  queryOptions({
    queryKey: v2QueryKeys.providerAccounts(connectionId),
    queryFn: () => providerAccountsFn({ data: { connectionId } }),
    staleTime: 15_000,
  })

export const connectSettingsOptions = () =>
  queryOptions({
    queryKey: v2QueryKeys.connectSettings(),
    queryFn: () => connectSettingsFn(),
    staleTime: Infinity,
  })

export const entriesPageOptions = (query: EntryPageQuery) =>
  queryOptions({
    queryKey: v2QueryKeys.entriesPage(query),
    queryFn: () => entriesPageFn({ data: query }),
    staleTime: 15_000,
  })

export const entryCountsOptions = () =>
  queryOptions({
    queryKey: v2QueryKeys.entryCounts(),
    queryFn: () => entryCountsFn(),
    staleTime: 15_000,
  })

export const categoriesOptions = (includeArchived = false) =>
  queryOptions({
    queryKey: v2QueryKeys.categories(includeArchived),
    queryFn: () => listCategoriesFn({ data: { includeArchived } }),
    staleTime: 60_000,
  })

export const categoryReviewOptions = () =>
  queryOptions({
    queryKey: v2QueryKeys.categoryReview(),
    queryFn: () => categoryReviewFn(),
    staleTime: 15_000,
  })

/**
 * Applies the person's category to every cached transaction page and drops
 * the entry from the review queue at once; returns the rollback for a
 * failed decision.
 */
export async function patchEntryCategory(
  queryClient: QueryClient,
  input: { entryId: string; categoryId: string },
) {
  const filters: Array<{ queryKey: QueryKey }> = [
    { queryKey: v2QueryKeys.entriesPages() },
    { queryKey: v2QueryKeys.categoryReview() },
  ]
  await Promise.all(filters.map((filter) => queryClient.cancelQueries(filter)))
  const previous = filters.flatMap((filter) =>
    queryClient.getQueriesData(filter),
  )
  const decided = (entry: Entry): Entry =>
    entry.id === input.entryId
      ? {
          ...entry,
          category: {
            categoryId:
              input.categoryId === 'uncategorized' ? null : input.categoryId,
            status: input.categoryId === 'uncategorized' ? 'none' : 'applied',
            origin: 'decision',
            confidence: 1,
            excludedFromSpending: false,
          },
        }
      : entry
  queryClient.setQueriesData<{ entries: ReadonlyArray<Entry> }>(
    { queryKey: v2QueryKeys.entriesPages() },
    (page) =>
      page && 'entries' in page
        ? { ...page, entries: page.entries.map(decided) }
        : page,
  )
  queryClient.setQueriesData<ReadonlyArray<{ inference: { entryId: string } }>>(
    { queryKey: v2QueryKeys.categoryReview() },
    (items) =>
      items?.filter((item) => item.inference.entryId !== input.entryId),
  )
  return () => {
    for (const [queryKey, data] of previous)
      queryClient.setQueryData(queryKey, data)
  }
}

/**
 * The V2 server answers writes at once and rebuilds entries, relations and
 * categories in background reactors. Invalidate now, then again after the
 * reactors had time to run, so the screen settles on the rebuilt reads.
 */
export async function invalidateAfterReactors(
  queryClient: QueryClient,
  scope: FinanceInvalidationScope = 'ledger',
  delays: ReadonlyArray<number> = [1_500],
) {
  await invalidateFinance(queryClient, scope)
  for (const delay of delays)
    setTimeout(() => void invalidateFinance(queryClient, scope), delay)
}
