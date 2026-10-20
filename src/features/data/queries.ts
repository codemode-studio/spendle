import { queryOptions, skipToken } from '@tanstack/react-query'
import type { QueryClient, QueryKey } from '@tanstack/react-query'

import type { Entry, Relation } from '@spendle/server/api'

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
 * API reads live under `['finance', 'read', …]`, so every invalidation group
 * that refreshes the ledger (`invalidateFinance(queryClient, 'ledger')`) also
 * refreshes them.
 */
export const queryKeys = {
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
  /** The prefix of every transaction page, which category edits patch. */
  entriesPages: () =>
    [...financeQueryKeys.all, 'read', 'transactions'] as const,
  entriesPage: (query: EntryPageQuery) =>
    [...queryKeys.entriesPages(), query] as const,
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
  /** The prefix of every relation list, which decisions patch. */
  allRelations: () =>
    [...financeQueryKeys.all, 'read', 'reconciliation', 'relations'] as const,
  relations: (status?: string) =>
    [...queryKeys.allRelations(), status ?? 'all'] as const,
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
  /** The `knowledge-base` key, so its invalidation group applies. */
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
    queryKey: queryKeys.planningState(),
    queryFn: () => planningStateFn(),
    staleTime: 15_000,
  })

export const monthOptions = (month?: string) =>
  queryOptions({
    queryKey: queryKeys.month(month),
    queryFn: () => monthFn({ data: { month } }),
    staleTime: 15_000,
  })

export const monthHistoryOptions = (months = 11) =>
  queryOptions({
    queryKey: queryKeys.monthHistory(months),
    queryFn: () => monthHistoryFn({ data: { months } }),
    staleTime: 60_000,
    gcTime: 30 * 60_000,
  })

export const forecastOptions = () =>
  queryOptions({
    queryKey: queryKeys.forecast(),
    queryFn: () => forecastFn(),
    staleTime: 15_000,
  })

export const recurrenceBookOptions = () =>
  queryOptions({
    queryKey: queryKeys.recurrenceBook(),
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
    queryKey: queryKeys.owners(),
    queryFn: () => listOwnersFn(),
    staleTime: 60_000,
  })

export const accountsOptions = (includeArchived = false) =>
  queryOptions({
    queryKey: queryKeys.accounts(includeArchived),
    queryFn: () => listAccountsFn({ data: { includeArchived } }),
    staleTime: 15_000,
  })

export const balanceProofOptions = (accountId?: string) =>
  queryOptions({
    queryKey: queryKeys.balanceProof(accountId ?? ''),
    queryFn: accountId
      ? () => balanceProofFn({ data: { accountId } })
      : skipToken,
    staleTime: 15_000,
  })

export const connectionsOptions = () =>
  queryOptions({
    queryKey: queryKeys.connections(),
    queryFn: () => listConnectionsFn(),
    staleTime: 15_000,
  })

export const providerAccountsOptions = (connectionId: string) =>
  queryOptions({
    queryKey: queryKeys.providerAccounts(connectionId),
    queryFn: () => providerAccountsFn({ data: { connectionId } }),
    staleTime: 15_000,
  })

export const connectSettingsOptions = () =>
  queryOptions({
    queryKey: queryKeys.connectSettings(),
    queryFn: () => connectSettingsFn(),
    staleTime: Infinity,
  })

export const entriesPageOptions = (query: EntryPageQuery) =>
  queryOptions({
    queryKey: queryKeys.entriesPage(query),
    queryFn: () => entriesPageFn({ data: query }),
    staleTime: 15_000,
  })

export const entryCountsOptions = () =>
  queryOptions({
    queryKey: queryKeys.entryCounts(),
    queryFn: () => entryCountsFn(),
    staleTime: 15_000,
  })

export const categoriesOptions = (includeArchived = false) =>
  queryOptions({
    queryKey: queryKeys.categories(includeArchived),
    queryFn: () => listCategoriesFn({ data: { includeArchived } }),
    staleTime: 60_000,
  })

export const categoryReviewOptions = () =>
  queryOptions({
    queryKey: queryKeys.categoryReview(),
    queryFn: () => categoryReviewFn(),
    staleTime: 15_000,
  })

export const relationsOptions = (
  status?: 'suggested' | 'confirmed' | 'conflict',
) =>
  queryOptions({
    queryKey: queryKeys.relations(status),
    queryFn: () => relationsFn({ data: { status } }),
    staleTime: 15_000,
  })

export const orphanedDecisionsOptions = () =>
  queryOptions({
    queryKey: queryKeys.orphanedDecisions(),
    queryFn: () => orphanedDecisionsFn(),
    staleTime: 15_000,
  })

export const linkCandidatesOptions = (entryId: string | null, text = '') =>
  queryOptions({
    queryKey: queryKeys.linkCandidates(entryId ?? '', text),
    queryFn: entryId
      ? () => linkCandidatesFn({ data: { entryId, text } })
      : skipToken,
    staleTime: 0,
  })

export const cardOverviewOptions = (accountId: string) =>
  queryOptions({
    queryKey: queryKeys.cardOverview(accountId),
    queryFn: () => cardOverviewFn({ data: { accountId } }),
    staleTime: 15_000,
  })

export const cycleEntriesOptions = (
  accountId: string,
  cycle: { closingOn: string; entryIds: ReadonlyArray<string> },
) =>
  queryOptions({
    queryKey: queryKeys.cycleEntries(accountId, cycle.closingOn),
    queryFn: () =>
      cycleEntriesFn({ data: { accountId, entryIds: cycle.entryIds } }),
    staleTime: 15_000,
  })

export const importsOptions = () =>
  queryOptions({
    queryKey: queryKeys.imports(),
    queryFn: () => listImportsFn({ data: {} }),
    staleTime: 15_000,
  })

export const investmentsOptions = () =>
  queryOptions({
    queryKey: queryKeys.investments(),
    queryFn: () => investmentsSnapshotFn(),
    staleTime: 60_000,
  })

/** Under `read`, so the ledger invalidations cover the category analysis. */
export const categoryLedgerOptions = () =>
  queryOptions({
    queryKey: queryKeys.categoryLedger(),
    queryFn: () => categoryLedgerFn(),
    staleTime: 15_000,
  })

export const storePatternsOptions = () =>
  queryOptions({
    queryKey: queryKeys.storePatterns(),
    queryFn: () => storePatternsFn(),
    staleTime: 15_000,
  })

export const providerMappingsOptions = () =>
  queryOptions({
    queryKey: queryKeys.providerMappings(),
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
    { queryKey: queryKeys.entriesPages() },
    { queryKey: queryKeys.categoryReview() },
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
    { queryKey: queryKeys.entriesPages() },
    (page) =>
      page && 'entries' in page
        ? { ...page, entries: page.entries.map(decided) }
        : page,
  )
  queryClient.setQueriesData<ReadonlyArray<{ inference: { entryId: string } }>>(
    { queryKey: queryKeys.categoryReview() },
    (items) =>
      items?.filter((item) => item.inference.entryId !== input.entryId),
  )
  return () => {
    for (const [queryKey, data] of previous)
      queryClient.setQueryData(queryKey, data)
  }
}

/**
 * Applies the person's verdict on a pair to the cached lists at once: a
 * confirmed pair moves to the confirmed ones as theirs, a rejected pair or
 * released confirmation leaves. Returns the rollback for a failed decision.
 */
export async function patchRelationDecision(
  queryClient: QueryClient,
  input: { key: string; decision: 'confirmed' | 'rejected' },
) {
  const relations = { queryKey: queryKeys.allRelations() }
  const orphaned = { queryKey: queryKeys.orphanedDecisions() }
  await Promise.all([
    queryClient.cancelQueries(relations),
    queryClient.cancelQueries(orphaned),
  ])
  const previous = [
    ...queryClient.getQueriesData(relations),
    ...queryClient.getQueriesData(orphaned),
  ]
  queryClient.setQueriesData<ReadonlyArray<Relation>>(relations, (items) =>
    items?.flatMap((item) =>
      item.key !== input.key
        ? [item]
        : input.decision === 'rejected'
          ? []
          : [
              {
                ...item,
                status: 'confirmed' as const,
                origin: 'person' as const,
              },
            ],
    ),
  )
  queryClient.setQueriesData<ReadonlyArray<{ key: string }>>(
    orphaned,
    (items) => items?.filter((item) => item.key !== input.key),
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
  const filter = { queryKey: queryKeys.entriesPages() }
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
 * The API answers writes at once and rebuilds entries, relations and
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
