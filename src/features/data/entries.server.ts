import * as Effect from 'effect/Effect'

import type { EntryFilters } from '@spendle/server/api'

import type { ApiClient } from '#/lib/api/client.server'

export const entriesPageSize = 50

/** The largest page the API serves; used to skip ahead in few requests. */
const skipStep = 200

/**
 * One numbered page of entries. The API pages by opaque cursor, so the
 * entries before the page are skipped in steps of 200, following the cursor
 * each step returns. A page past the end falls back to the last page.
 */
export function entriesAt(
  client: ApiClient,
  filters: Omit<EntryFilters, 'cursor' | 'limit'>,
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
    let cursor: string | undefined
    let remaining = page * entriesPageSize
    while (remaining > 0) {
      const limit = Math.min(remaining, skipStep)
      const skipped = yield* client.entries.list({
        query: { ...filters, limit, cursor },
      })
      if (skipped.nextCursor === null) {
        const last = Math.max(0, Math.ceil(skipped.total / entriesPageSize) - 1)
        return yield* entriesAt(client, filters, Math.min(last, page - 1))
      }
      cursor = skipped.nextCursor
      remaining -= limit
    }
    const found = yield* client.entries.list({
      query: { ...filters, limit: entriesPageSize, cursor },
    })
    return {
      entries: found.entries,
      total: found.total,
      page,
      pageSize: entriesPageSize,
    }
  })
}
