import * as Effect from 'effect/Effect'

import type { EntryFilters } from '@spendle/server/api'

import type { ApiClient } from '#/lib/api/client.server'

export const entriesPageSize = 50

/**
 * One numbered page of entries, read by offset. A page past the end comes
 * back empty with the total, and falls back to the last page.
 */
export function entriesAt(
  client: ApiClient,
  filters: Omit<EntryFilters, 'cursor' | 'limit' | 'offset'>,
  page: number,
): Effect.Effect<
  {
    entries: Effect.Success<ReturnType<ApiClient['entries']['list']>>['entries']
    total: number
    page: number
    pageSize: number
  },
  Effect.Error<ReturnType<ApiClient['entries']['list']>>
> {
  return Effect.gen(function* () {
    const found = yield* client.entries.list({
      query: {
        ...filters,
        limit: entriesPageSize,
        offset: page * entriesPageSize,
      },
    })
    if (found.entries.length === 0 && page > 0) {
      const last = Math.max(0, Math.ceil(found.total / entriesPageSize) - 1)
      return yield* entriesAt(client, filters, last)
    }
    return {
      entries: found.entries,
      total: found.total,
      page,
      pageSize: entriesPageSize,
    }
  })
}
