import * as Effect from 'effect/Effect'

import type { ApiClient } from '#/lib/api/client.server'

/**
 * Entries that could be the other side of `entryId`: the opposite direction
 * and the same amount on any account, latest first. Refunds may be partial,
 * so smaller amounts on the same account are offered too.
 */
export function linkCandidates(
  client: ApiClient,
  entryId: string,
  search?: string,
) {
  return Effect.gen(function* () {
    const { entry } = yield* client.entries.get({ params: { entryId } })
    const amount = Math.abs(entry.amountCents)
    const direction = entry.amountCents < 0 ? 'inflow' : 'outflow'
    const text = search?.trim() || undefined
    const [sameAmount, partial] = yield* Effect.all(
      [
        client.entries.list({
          query: {
            direction,
            minAmountCents: amount,
            maxAmountCents: amount,
            text,
            limit: 30,
          },
        }),
        client.entries.list({
          query: {
            direction,
            accountId: entry.accountId,
            maxAmountCents: amount,
            text,
            limit: 30,
          },
        }),
      ],
      { concurrency: 'unbounded' },
    )
    const seen = new Set<string>([entry.id])
    const candidates = [...sameAmount.entries, ...partial.entries].filter(
      (candidate) => {
        if (seen.has(candidate.id)) return false
        seen.add(candidate.id)
        return true
      },
    )
    return { entry, candidates }
  })
}
