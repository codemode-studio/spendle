import { createServerFn } from '@tanstack/react-start'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { allEntries, api } from '#/lib/api/client.server'

const accountId = Schema.Struct({ accountId: Schema.String })

/** The card's cycles and its instalment plans, in one read. */
export const cardOverviewFn = createServerFn({ method: 'GET' })
  .validator(Schema.toStandardSchemaV1(accountId))
  .handler(({ data }) =>
    api((client) =>
      Effect.all(
        {
          cycles: client.cards.cycles({ params: data }),
          installments: client.cards.installments({ params: data }),
        },
        { concurrency: 'unbounded' },
      ),
    ),
  )

/** The entries a cycle bills, latest first. */
export const cycleEntriesFn = createServerFn({ method: 'GET' })
  .validator(
    Schema.toStandardSchemaV1(
      Schema.Struct({
        accountId: Schema.String,
        entryIds: Schema.Array(Schema.String),
      }),
    ),
  )
  .handler(({ data }) =>
    api((client) =>
      allEntries(client, { accountId: data.accountId }).pipe(
        Effect.map((entries) => {
          const wanted = new Set(data.entryIds)
          return entries.filter((entry) => wanted.has(entry.id))
        }),
      ),
    ),
  )
