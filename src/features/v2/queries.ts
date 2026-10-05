import { queryOptions, skipToken } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'

import { financeQueryKeys, invalidateFinance } from '#/features/finance/queries'
import type { FinanceInvalidationScope } from '#/features/finance/queries'

import {
  balanceProofFn,
  listAccountsFn,
  listOwnersFn,
} from './accounts.functions'
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
