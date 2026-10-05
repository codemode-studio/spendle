import { createServerFn } from '@tanstack/react-start'
import * as Schema from 'effect/Schema'

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
