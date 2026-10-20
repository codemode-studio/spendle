import * as Effect from 'effect/Effect'
import type { ApiClient } from '#/lib/api/client.server'

/** Whether any recurrence is active. */
export function hasActiveRecurrences(client: ApiClient) {
  return client.recurrences
    .book()
    .pipe(
      Effect.map(({ recurrences }) =>
        recurrences.some((recurrence) => recurrence.active),
      ),
    )
}

/**
 * The ledger steps of the setup, from the API: an active account or card, any
 * entry, and no entry left without a category or waiting for review.
 * Counts only; never loads entries.
 */
export function ledgerSetup(client: ApiClient) {
  return Effect.all(
    {
      accounts: client.accounts
        .list({ query: {} })
        .pipe(Effect.map((accounts) => accounts.length > 0)),
      counts: client.entries.counts(),
    },
    { concurrency: 'unbounded' },
  ).pipe(
    Effect.map(({ accounts, counts }) => ({
      accounts,
      transactions: counts.total > 0,
      categories:
        counts.total > 0 && counts.uncategorized + counts.review === 0,
      uncategorizedCount: counts.uncategorized + counts.review,
    })),
  )
}
