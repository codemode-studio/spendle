import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { assistantQueryKeys } from '#/features/home/query-keys'
import {
  financeQueryKeys,
  invalidateFinance,
  onboardingOptions,
  strategyHistoryOptions,
} from './queries'
import type { FinanceInvalidationScope } from './queries'

// Concrete cached instances exercise prefix matching, including inactive months.
const queries = {
  january: financeQueryKeys.snapshot('2026-01'),
  february: financeQueryKeys.snapshot('2026-02'),
  configuration: ['finance', 'read', 'configuration'],
  onboarding: financeQueryKeys.onboarding(),
  transactions: ['finance', 'read', 'transactions', { page: 2 }],
  knowledge: financeQueryKeys.knowledgeBase(),
  imports: financeQueryKeys.importReview(),
  detection: financeQueryKeys.recurrenceDetection(),
  candidate: financeQueryKeys.recurrenceLinkCandidates('occurrence-1'),
  history: financeQueryKeys.strategyHistory(3),
  assistant: assistantQueryKeys.status(),
  analysis: assistantQueryKeys.latestAnalysis(''),
  unrelated: ['unrelated'],
}
const reads = [
  'january',
  'february',
  'configuration',
  'onboarding',
  'transactions',
  'knowledge',
]
const ledger = [
  ...reads,
  'imports',
  'detection',
  'candidate',
  'history',
  'analysis',
]
const expected: Record<FinanceInvalidationScope, string[]> = {
  ledger,
  ownershipScope: reads,
  stagedTransactionCategory: ['imports', 'knowledge'],
  knowledgeBase: ledger,
  aiConsent: [...ledger, 'assistant'],
  strategy: ledger,
  budgetClose: [...reads, 'history', 'analysis'],
}

describe('financial cache invalidation', () => {
  it('retains small shell and monthly queries beyond the default cache window', () => {
    expect(strategyHistoryOptions(11).gcTime).toBe(30 * 60_000)
    expect(onboardingOptions().gcTime).toBe(30 * 60_000)
  })

  it.each(Object.entries(expected))(
    '%s invalidates affected data and leaves other data fresh',
    async (scope, staleNames) => {
      const client = new QueryClient({
        defaultOptions: { queries: { staleTime: Infinity } },
      })
      try {
        for (const key of Object.values(queries))
          client.setQueryData(key, { value: 1 })
        await invalidateFinance(client, scope as FinanceInvalidationScope)
        for (const [name, key] of Object.entries(queries)) {
          expect(client.getQueryState(key)?.isInvalidated, name).toBe(
            staleNames.includes(name),
          )
        }
      } finally {
        client.clear()
      }
    },
  )
})
