import * as Effect from 'effect/Effect'
import type { V2Client } from '#/lib/v2/client.server'

/** Whether any recurrence is active. */
export function hasActiveRecurrences(client: V2Client) {
  return client.recurrences
    .book()
    .pipe(
      Effect.map(({ recurrences }) =>
        recurrences.some((recurrence) => recurrence.active),
      ),
    )
}

/**
 * The ledger steps of the setup, from V2: an active account or card, any
 * entry, and no entry left without a category or waiting for review.
 * Counts only; never loads entries.
 */
export function ledgerSetup(client: V2Client) {
  const count = (query: Parameters<V2Client['entries']['list']>[0]['query']) =>
    client.entries
      .list({ query: { ...query, limit: 1 } })
      .pipe(Effect.map((page) => page.total))
  return Effect.all({
    accounts: client.accounts
      .list({ query: {} })
      .pipe(Effect.map((accounts) => accounts.length > 0)),
    entries: count({}),
    uncategorized: count({ categoryStatus: 'none' }),
    review: count({ categoryStatus: 'review' }),
  }).pipe(
    Effect.map(({ accounts, entries, uncategorized, review }) => ({
      accounts,
      transactions: entries > 0,
      categories: entries > 0 && uncategorized + review === 0,
      uncategorizedCount: uncategorized + review,
    })),
  )
}
