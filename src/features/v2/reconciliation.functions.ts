import { createServerFn } from '@tanstack/react-start'
import * as Schema from 'effect/Schema'

import { RelationKind, RelationStatus } from '@spendle/server/api'

import { v2 } from '#/lib/v2/client.server'

import { linkCandidates } from './reconciliation.server'

export const relationsFn = createServerFn({ method: 'GET' })
  .validator(
    Schema.toStandardSchemaV1(
      Schema.Struct({
        status: Schema.optional(RelationStatus),
        kind: Schema.optional(RelationKind),
        accountId: Schema.optional(Schema.String),
      }),
    ),
  )
  .handler(({ data }) =>
    v2((client) => client.reconciliation.relations({ query: data })),
  )

export const orphanedDecisionsFn = createServerFn({ method: 'GET' }).handler(
  () => v2((client) => client.reconciliation.orphanedDecisions()),
)

/** Confirms or rejects a relation, or releases an orphaned confirmation. */
export const decideRelationFn = createServerFn({ method: 'POST' })
  .validator(
    Schema.toStandardSchemaV1(
      Schema.Struct({
        key: Schema.String,
        decision: Schema.Literals(['confirmed', 'rejected']),
      }),
    ),
  )
  .handler(async ({ data }) => {
    await v2((client) => client.reconciliation.decide({ payload: data }))
    return data
  })

export const linkEntriesFn = createServerFn({ method: 'POST' })
  .validator(
    Schema.toStandardSchemaV1(
      Schema.Struct({
        outflowEntryId: Schema.String,
        inflowEntryId: Schema.String,
      }),
    ),
  )
  .handler(({ data }) =>
    v2((client) => client.reconciliation.link({ payload: data })),
  )

export const linkCandidatesFn = createServerFn({ method: 'GET' })
  .validator(
    Schema.toStandardSchemaV1(
      Schema.Struct({
        entryId: Schema.String,
        text: Schema.optional(Schema.String),
      }),
    ),
  )
  .handler(({ data }) =>
    v2((client) => linkCandidates(client, data.entryId, data.text)),
  )
