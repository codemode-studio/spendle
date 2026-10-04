import { MutationObserver, QueryClient } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'

import { investmentsOptions } from '#/features/investments/queries'

import { pluggyCorrectionMutationOptions } from './correction-mutation'

const portfolio = vi.hoisted(() => ({ totalCents: 30_000 }))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('#/features/investments/investments.functions', () => ({
  getInvestmentsSnapshotFn: () =>
    Promise.resolve({ summary: { totalCents: portfolio.totalCents } }),
}))

describe('Pluggy correction mutation', () => {
  it('refetches the investment portfolio after accepting a correction', async () => {
    const client = new QueryClient()
    try {
      // The real portfolio options keep their 5 minute staleTime.
      await client.fetchQuery(investmentsOptions())

      const resolve = vi.fn(() => {
        portfolio.totalCents = 50_000
        return Promise.resolve({ ok: true })
      })
      await new MutationObserver(
        client,
        pluggyCorrectionMutationOptions(client, resolve),
      ).mutate({ data: { observationId: 'observation-1', action: 'accept' } })

      expect(resolve).toHaveBeenCalledOnce()
      // Reopening Investimentos inside the stale window shows the new value.
      const reopened = await client.fetchQuery(investmentsOptions())
      expect(reopened.summary.totalCents).toBe(50_000)
    } finally {
      client.clear()
    }
  })
})
