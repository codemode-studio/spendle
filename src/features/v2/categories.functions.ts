import { createServerFn } from '@tanstack/react-start'
import * as Schema from 'effect/Schema'

import { StoreEdit } from '@spendle/server/api'

import { v2 } from '#/lib/v2/client.server'

import { categoryLedger } from './categories.server'

export const listCategoriesFn = createServerFn({ method: 'GET' })
  .validator(
    Schema.toStandardSchemaV1(
      Schema.Struct({ includeArchived: Schema.Boolean }),
    ),
  )
  .handler(({ data }) =>
    v2((client) =>
      client.categories.list({
        query: { includeArchived: data.includeArchived },
      }),
    ),
  )

/** Entries shaped for the category analysis on /categorias. */
export const categoryLedgerFn = createServerFn({ method: 'GET' }).handler(() =>
  v2(categoryLedger),
)

export const storePatternsFn = createServerFn({ method: 'GET' }).handler(() =>
  v2((client) => client.categoryStore.patterns()),
)

export const providerMappingsFn = createServerFn({ method: 'GET' }).handler(
  () => v2((client) => client.categoryStore.providerMappings()),
)

const storeEdit = Schema.toStandardSchemaV1(Schema.Struct({ edit: StoreEdit }))

/** The entries a knowledge-base edit would recategorize; nothing changes. */
export const previewStoreEditFn = createServerFn({ method: 'POST' })
  .validator(storeEdit)
  .handler(({ data }) =>
    v2((client) => client.categoryStore.preview({ payload: data })),
  )

/** Applies the person's knowledge-base edit; entries follow in the background. */
export const applyStoreEditFn = createServerFn({ method: 'POST' })
  .validator(storeEdit)
  .handler(({ data }) =>
    v2((client) => client.categoryStore.edit({ payload: data })),
  )
