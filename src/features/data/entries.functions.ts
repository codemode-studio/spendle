import { createServerFn } from '@tanstack/react-start'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { EntryFilters } from '@spendle/server/api'

import { api } from '#/lib/api/client.server'

import { entriesAt } from './entries.server'

const entryId = Schema.Struct({ entryId: Schema.String })

const { cursor: _cursor, limit: _limit, ...filterFields } = EntryFilters.fields

/** The transaction list's filters: the API's, without cursor or limit, plus a page number. */
export const EntryPageQuery = Schema.Struct({
  ...filterFields,
  page: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 })),
})
export type EntryPageQuery = typeof EntryPageQuery.Type

export const entriesPageFn = createServerFn({ method: 'GET' })
  .validator(Schema.toStandardSchemaV1(EntryPageQuery))
  .handler(({ data }) => {
    const { page, ...filters } = data
    return api((client) => entriesAt(client, filters, page))
  })

/** How many entries wait for a category decision, across the whole ledger. */
export const entryCountsFn = createServerFn({ method: 'GET' }).handler(() =>
  api((client) =>
    Effect.all({
      review: client.entries
        .list({ query: { categoryStatus: 'review', limit: 1 } })
        .pipe(Effect.map((page) => page.total)),
      uncategorized: client.entries
        .list({ query: { categoryStatus: 'none', limit: 1 } })
        .pipe(Effect.map((page) => page.total)),
      total: client.entries
        .list({ query: { limit: 1 } })
        .pipe(Effect.map((page) => page.total)),
    }),
  ),
)

export const entryDetailFn = createServerFn({ method: 'GET' })
  .validator(Schema.toStandardSchemaV1(entryId))
  .handler(({ data }) => api((client) => client.entries.get({ params: data })))

/** The person's category for an entry, chosen in the transaction list. */
export const decideCategoryFn = createServerFn({ method: 'POST' })
  .validator(
    Schema.toStandardSchemaV1(
      Schema.Struct({
        entryId: Schema.String,
        categoryId: Schema.String,
        learn: Schema.optional(Schema.Boolean),
      }),
    ),
  )
  .handler(({ data }) =>
    api((client) =>
      client.categoryDecisions.decide({
        params: { entryId: data.entryId },
        payload: { categoryId: data.categoryId, learn: data.learn },
      }),
    ),
  )

export const confirmCategoryFn = createServerFn({ method: 'POST' })
  .validator(Schema.toStandardSchemaV1(entryId))
  .handler(({ data }) =>
    api((client) => client.categoryDecisions.confirm({ params: data })),
  )

export const correctCategoryFn = createServerFn({ method: 'POST' })
  .validator(
    Schema.toStandardSchemaV1(
      Schema.Struct({ entryId: Schema.String, categoryId: Schema.String }),
    ),
  )
  .handler(({ data }) =>
    api((client) =>
      client.categoryDecisions.correct({
        params: { entryId: data.entryId },
        payload: { categoryId: data.categoryId },
      }),
    ),
  )

export const undoCategoryFn = createServerFn({ method: 'POST' })
  .validator(Schema.toStandardSchemaV1(entryId))
  .handler(({ data }) =>
    api((client) => client.categoryDecisions.undo({ params: data })),
  )

export const categoryReviewFn = createServerFn({ method: 'GET' }).handler(() =>
  api((client) => client.categoryDecisions.review()),
)
