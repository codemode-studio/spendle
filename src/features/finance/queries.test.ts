import { QueryClient } from '@tanstack/react-query'
import type { QueryKey } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'

import { assistantQueryKeys } from '#/features/home/query-keys'

import {
  financeInvalidationGroups,
  financeInvalidationKeys,
  financeQueryKeys,
  invalidateFinance,
} from './queries'
import type { FinanceInvalidationScope } from './queries'

const invalidationTable = {
  ledger: {
    families: [
      'snapshot',
      'importReview',
      'recurrenceDetection',
      'strategyHistory',
      'recurrenceLinkCandidates',
    ],
    queryKeys: [
      financeQueryKeys.snapshots(),
      financeQueryKeys.importReview(),
      financeQueryKeys.recurrenceDetection(),
      financeQueryKeys.strategyHistories(),
      financeQueryKeys.recurrenceLinkCandidatesAll(),
    ],
  },
  ownershipScope: {
    families: ['snapshot'],
    queryKeys: [financeQueryKeys.snapshots()],
  },
  stagedTransactionCategory: {
    families: ['importReview'],
    queryKeys: [financeQueryKeys.importReview()],
  },
  aiConsent: {
    families: [
      'assistant',
      'snapshot',
      'importReview',
      'recurrenceDetection',
      'strategyHistory',
      'recurrenceLinkCandidates',
    ],
    queryKeys: [
      assistantQueryKeys.status(),
      financeQueryKeys.snapshots(),
      financeQueryKeys.importReview(),
      financeQueryKeys.recurrenceDetection(),
      financeQueryKeys.strategyHistories(),
      financeQueryKeys.recurrenceLinkCandidatesAll(),
    ],
  },
  strategy: {
    families: [
      'snapshot',
      'importReview',
      'recurrenceDetection',
      'strategyHistory',
      'recurrenceLinkCandidates',
    ],
    queryKeys: [
      financeQueryKeys.snapshots(),
      financeQueryKeys.importReview(),
      financeQueryKeys.recurrenceDetection(),
      financeQueryKeys.strategyHistories(),
      financeQueryKeys.recurrenceLinkCandidatesAll(),
    ],
  },
  budgetClose: {
    families: ['snapshot', 'strategyHistory'],
    queryKeys: [
      financeQueryKeys.snapshots(),
      financeQueryKeys.strategyHistories(),
    ],
  },
} satisfies Record<
  FinanceInvalidationScope,
  { families: ReadonlyArray<string>; queryKeys: Array<QueryKey> }
>

const invalidationScopes = Object.keys(
  invalidationTable,
) as Array<FinanceInvalidationScope>

describe('finance invalidation groups', () => {
  it.each(invalidationScopes)('%s has the expected scope set', (scope) => {
    expect(financeInvalidationGroups[scope]).toEqual(
      invalidationTable[scope].families,
    )
    expect(financeInvalidationKeys(scope)).toEqual(
      invalidationTable[scope].queryKeys,
    )
  })

  it.each(invalidationScopes)(
    '%s invalidates its expected queries',
    async (scope) => {
      const queryClient = new QueryClient()
      const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries')

      await invalidateFinance(queryClient, scope)

      expect(
        invalidateQueries.mock.calls.map(([filters]) => filters?.queryKey),
      ).toEqual(invalidationTable[scope].queryKeys)
    },
  )

  it('includes every derived ledger family in ledger invalidation', () => {
    expect(financeInvalidationKeys('ledger')).toEqual(
      expect.arrayContaining([
        financeQueryKeys.importReview(),
        financeQueryKeys.recurrenceDetection(),
        financeQueryKeys.strategyHistories(),
        financeQueryKeys.recurrenceLinkCandidatesAll(),
      ]),
    )
  })
})
