import * as Schema from 'effect/Schema'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import * as HttpApiSchema from 'effect/http-api/HttpApiSchema'

import { LocalDate } from './Entries.ts'
import { EndpointErrors } from './Errors.ts'

/** Signed centavos (outflows negative); never zero. */
const SignedCents = Schema.Int.check(
  Schema.makeFilter((cents: number) => cents !== 0, {
    description: 'a non-zero amount',
  }),
)

/** A transaction the person types in, in the account's currency. */
export const ManualTransactionFields = Schema.Struct({
  bookedOn: LocalDate,
  amountCents: SignedCents,
  /** 2 to 200 characters once trimmed. */
  description: Schema.String.check(Schema.isMaxLength(200)),
})
export type ManualTransactionFields = typeof ManualTransactionFields.Type

export const NewManualTransaction = Schema.Struct({
  accountId: Schema.String,
  ...ManualTransactionFields.fields,
  /** The person's category for it; omitted or `uncategorized` lets inference decide. */
  categoryId: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
})

export const ManualTransactionReceipt = Schema.Struct({
  /** Identifies the typed-in transaction for edits and deletion. */
  externalId: Schema.String,
  /** The entry it became, already resolved. */
  entryId: Schema.NullOr(Schema.String),
})

export const EntryNote = Schema.Struct({
  entryId: Schema.String,
  note: Schema.NullOr(Schema.String),
})

const externalParams = { externalId: Schema.String }

/**
 * What the person types in: transactions (facts from the `manual` source,
 * edited as new versions), balances they inform (checkpoints of the
 * balance proof) and notes on entries.
 */
export class ManualApi extends HttpApiGroup.make('manual')
  .add(
    HttpApiEndpoint.post('createTransaction', '/manual/transactions', {
      payload: NewManualTransaction,
      success: ManualTransactionReceipt,
      error: EndpointErrors,
    }),
    HttpApiEndpoint.put(
      'reviseTransaction',
      '/manual/transactions/:externalId',
      {
        params: externalParams,
        payload: ManualTransactionFields,
        success: ManualTransactionReceipt,
        error: EndpointErrors,
      },
    ),
    HttpApiEndpoint.delete(
      'removeTransaction',
      '/manual/transactions/:externalId',
      {
        params: externalParams,
        success: HttpApiSchema.NoContent,
        error: EndpointErrors,
      },
    ),
    HttpApiEndpoint.post(
      'recordCheckpoint',
      '/accounts/:accountId/checkpoints',
      {
        params: { accountId: Schema.String },
        /** The balance at the end of `asOf`, as the person sees it at the bank. */
        payload: Schema.Struct({ asOf: LocalDate, balanceCents: Schema.Int }),
        success: Schema.Struct({ id: Schema.String }),
        error: EndpointErrors,
      },
    ),
    HttpApiEndpoint.delete('withdrawCheckpoint', '/checkpoints/:checkpointId', {
      params: { checkpointId: Schema.String },
      success: Schema.Struct({ accountId: Schema.String }),
      error: EndpointErrors,
    }),
    HttpApiEndpoint.put('setNote', '/entries/:entryId/note', {
      params: { entryId: Schema.String },
      /** Null or blank clears the note. */
      payload: Schema.Struct({
        note: Schema.NullOr(Schema.String.check(Schema.isMaxLength(500))),
      }),
      success: EntryNote,
      error: EndpointErrors,
    }),
  )
  .prefix('/api') {}
