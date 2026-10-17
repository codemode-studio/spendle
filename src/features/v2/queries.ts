import { queryOptions, skipToken } from '@tanstack/react-query'
import type { QueryClient, QueryKey } from '@tanstack/react-query'

import type { Entry } from '@spendle/server/api'

import { financeQueryKeys, invalidateFinance } from '#/features/finance/queries'
import type { FinanceInvalidationScope } from '#/features/finance/queries'

import { getSpaceFn } from './space.functions'
import {
  balanceProofFn,
  listAccountsFn,
  listOwnersFn,
} from './accounts.functions'
import { cardOverviewFn, cycleEntriesFn } from './cards.functions'
import {
  categoryLedgerFn,
  listCategoriesFn,
  providerMappingsFn,
  storePatternsFn,
} from './categories.functions'
import { listImportsFn } from './imports.functions'
import { investmentsSnapshotFn } from './investments.functions'
import {
  categoryReviewFn,
  entriesPageFn,
  entryCountsFn,
} from './entries.functions'
import type { EntryPageQuery } from './entries.functions'
import {
  linkCandidatesFn,
  orphanedDecisionsFn,
  relationsFn,
} from './reconciliation.functions'
import {
  assistantStatusFn,
  detectedRecurrencesFn,
  forecastFn,
  linkCandidatesFn as recurrenceCandidatesFn,
  monthFn,
  monthHistoryFn,
  planningStateFn,
  recurrenceBookFn,
} from './planning.functions'
import { assistantQueryKeys } from '#/features/home/query-keys'
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
  relations: (status?: string) =>
    [
      ...financeQueryKeys.all,
      'read',
      'reconciliation',
      'relations',
      status ?? 'all',
    ] as const,
  orphanedDecisions: () =>
    [...financeQueryKeys.all, 'read', 'reconciliation', 'orphaned'] as const,
  linkCandidates: (entryId: string, text: string) =>
    [
      ...financeQueryKeys.all,
      'read',
      'reconciliation',
      'candidates',
      entryId,
      text,
    ] as const,
  cardOverview: (accountId: string) =>
    [...financeQueryKeys.all, 'read', 'cards', accountId, 'overview'] as const,
  cycleEntries: (accountId: string, closingOn: string) =>
    [
      ...financeQueryKeys.all,
      'read',
      'cards',
      accountId,
      'cycle',
      closingOn,
    ] as const,
  imports: () => [...financeQueryKeys.all, 'read', 'imports'] as const,
  categoryLedger: () =>
    [...financeQueryKeys.all, 'read', 'categories'] as const,
  /** Same key as the V1 knowledge base, so its invalidation group applies. */
  storePatterns: () =>
    [...financeQueryKeys.all, 'read', 'knowledge-base'] as const,
  providerMappings: () =>
    [...financeQueryKeys.all, 'read', 'knowledge-base', 'provider'] as const,
  /** Under `read`, so every ledger invalidation refreshes positions too. */
  investments: () => [...financeQueryKeys.all, 'read', 'investments'] as const,
  connectSettings: () =>
    [...financeQueryKeys.all, 'open-finance', 'connect-settings'] as const,
  planningState: () => [...financeQueryKeys.all, 'read', 'planning'] as const,
  /** Under the snapshot prefix, which every ledger change refreshes. */
  month: (month?: string) => financeQueryKeys.snapshot(month),
  monthHistory: (months: number) => financeQueryKeys.strategyHistory(months),
  forecast: () => [...financeQueryKeys.all, 'read', 'forecast'] as const,
  recurrenceBook: () =>
    [...financeQueryKeys.all, 'read', 'recurrence-book'] as const,
}

export const planningStateOptions = () =>
  queryOptions({
    queryKey: v2QueryKeys.planningState(),
    queryFn: () => planningStateFn(),
    staleTime: 15_000,
  })

export const monthOptions = (month?: string) =>
  queryOptions({
    queryKey: v2QueryKeys.month(month),
    queryFn: () => monthFn({ data: { month } }),
    staleTime: 15_000,
  })

export const monthHistoryOptions = (months = 11) =>
  queryOptions({
    queryKey: v2QueryKeys.monthHistory(months),
    queryFn: () => monthHistoryFn({ data: { months } }),
    staleTime: 60_000,
    gcTime: 30 * 60_000,
  })

export const forecastOptions = () =>
  queryOptions({
    queryKey: v2QueryKeys.forecast(),
    queryFn: () => forecastFn(),
    staleTime: 15_000,
  })

export const recurrenceBookOptions = () =>
  queryOptions({
    queryKey: v2QueryKeys.recurrenceBook(),
    queryFn: () => recurrenceBookFn(),
    staleTime: 15_000,
  })

export const detectedRecurrencesOptions = () =>
  queryOptions({
    queryKey: financeQueryKeys.recurrenceDetection(),
    queryFn: () => detectedRecurrencesFn(),
    staleTime: 15_000,
  })

export const recurrenceCandidatesOptions = (
  occurrence: { recurrenceId: string; expectedDate: string } | null,
) =>
  queryOptions({
    queryKey: financeQueryKeys.recurrenceLinkCandidates(
      occurrence ? `${occurrence.recurrenceId}|${occurrence.expectedDate}` : '',
    ),
    queryFn: occurrence
      ? () => recurrenceCandidatesFn({ data: occurrence })
      : skipToken,
    staleTime: 0,
  })

export const assistantStatusOptions = () =>
  queryOptions({
    queryKey: assistantQueryKeys.status(),
    queryFn: () => assistantStatusFn(),
    staleTime: 5 * 60_000,
  })

/** The caller's family space and who belongs to it. */
export const spaceOptions = () =>
  queryOptions({
    queryKey: ['space'] as const,
    queryFn: () => getSpaceFn(),
    staleTime: 60_000,
  })

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

export const relationsOptions = (
  status?: 'suggested' | 'confirmed' | 'conflict',
) =>
  queryOptions({
    queryKey: v2QueryKeys.relations(status),
    queryFn: () => relationsFn({ data: { status } }),
    staleTime: 15_000,
  })

export const orphanedDecisionsOptions = () =>
  queryOptions({
    queryKey: v2QueryKeys.orphanedDecisions(),
    queryFn: () => orphanedDecisionsFn(),
    staleTime: 15_000,
  })

export const linkCandidatesOptions = (entryId: string | null, text = '') =>
  queryOptions({
    queryKey: v2QueryKeys.linkCandidates(entryId ?? '', text),
    queryFn: entryId
      ? () => linkCandidatesFn({ data: { entryId, text } })
      : skipToken,
    staleTime: 0,
  })

export const cardOverviewOptions = (accountId: string) =>
  queryOptions({
    queryKey: v2QueryKeys.cardOverview(accountId),
    queryFn: () => cardOverviewFn({ data: { accountId } }),
    staleTime: 15_000,
  })

export const cycleEntriesOptions = (
  accountId: string,
  cycle: { closingOn: string; entryIds: ReadonlyArray<string> },
) =>
  queryOptions({
    queryKey: v2QueryKeys.cycleEntries(accountId, cycle.closingOn),
    queryFn: () =>
      cycleEntriesFn({ data: { accountId, entryIds: cycle.entryIds } }),
    staleTime: 15_000,
  })

export const importsOptions = () =>
  queryOptions({
    queryKey: v2QueryKeys.imports(),
    queryFn: () => listImportsFn({ data: {} }),
    staleTime: 15_000,
  })

export const investmentsOptions = () =>
  queryOptions({
    queryKey: v2QueryKeys.investments(),
    queryFn: () => investmentsSnapshotFn(),
    staleTime: 60_000,
  })

/** Same key as the V1 category analysis, which the ledger invalidations cover. */
export const categoryLedgerOptions = () =>
  queryOptions({
    queryKey: v2QueryKeys.categoryLedger(),
    queryFn: () => categoryLedgerFn(),
    staleTime: 15_000,
  })

export const storePatternsOptions = () =>
  queryOptions({
    queryKey: v2QueryKeys.storePatterns(),
    queryFn: () => storePatternsFn(),
    staleTime: 15_000,
  })

export const providerMappingsOptions = () =>
  queryOptions({
    queryKey: v2QueryKeys.providerMappings(),
    queryFn: () => providerMappingsFn(),
    staleTime: 60_000,
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
 * Shows the person's note on every cached transaction page at once;
 * returns the rollback for a failed save.
 */
export async function patchEntryNote(
  queryClient: QueryClient,
  input: { entryId: string; note: string | null },
) {
  const filter = { queryKey: v2QueryKeys.entriesPages() }
  await queryClient.cancelQueries(filter)
  const previous = queryClient.getQueriesData(filter)
  queryClient.setQueriesData<{ entries: ReadonlyArray<Entry> }>(
    filter,
    (page) =>
      page && 'entries' in page
        ? {
            ...page,
            entries: page.entries.map((entry) =>
              entry.id === input.entryId
                ? { ...entry, note: input.note }
                : entry,
            ),
          }
        : page,
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
