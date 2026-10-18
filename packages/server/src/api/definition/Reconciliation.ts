import * as Schema from 'effect/Schema'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import * as HttpApiSchema from 'effect/http-api/HttpApiSchema'

import { Entry, Relation, RelationKind, RelationStatus } from './Entries.ts'
import { EndpointErrors } from './Errors.ts'

/** A relation with both of its entries, as the review screen shows it. */
export const RelationView = Schema.Struct({
  ...Relation.fields,
  /** Null only while the entries are being resolved again. */
  outflow: Schema.NullOr(Entry),
  inflow: Schema.NullOr(Entry),
})

/**
 * A confirmation that no longer holds its entries. The entries it still
 * reserves stay out of automatic pairing until the person rejects it or
 * links them elsewhere.
 */
export const OrphanedDecision = Schema.Struct({
  key: Schema.String,
  missing: Schema.Array(Schema.String),
  reason: Schema.Literals([
    'entry_missing',
    'entry_split',
    'overlapping_confirmation',
  ]),
  reserved: Schema.Array(Schema.String),
})

export class ReconciliationApi extends HttpApiGroup.make('reconciliation')
  .add(
    HttpApiEndpoint.get('relations', '/relations', {
      query: {
        status: Schema.optional(RelationStatus),
        kind: Schema.optional(RelationKind),
        /** Relations with an entry of this account on either side. */
        accountId: Schema.optional(Schema.String),
      },
      success: Schema.Array(RelationView),
      error: EndpointErrors,
    }),
    HttpApiEndpoint.post('decide', '/decisions', {
      /**
       * Confirms or rejects a relation by key, or rejects an orphaned
       * confirmation to release its entries. A rejected pair is never
       * suggested again.
       */
      payload: Schema.Struct({
        key: Schema.String,
        decision: Schema.Literals(['confirmed', 'rejected']),
      }),
      success: HttpApiSchema.NoContent,
      error: EndpointErrors,
    }),
    HttpApiEndpoint.post('link', '/links', {
      /**
       * Pairs entries the matcher missed: a transfer or card payment across
       * accounts, or a refund of a purchase on the same account.
       */
      payload: Schema.Struct({
        outflowEntryId: Schema.String,
        inflowEntryId: Schema.String,
      }),
      success: Schema.Struct({ key: Schema.String }),
      error: EndpointErrors,
    }),
    HttpApiEndpoint.get('orphanedDecisions', '/orphaned-decisions', {
      success: Schema.Array(OrphanedDecision),
      error: EndpointErrors,
    }),
  )
  .prefix('/api/reconciliation') {}
