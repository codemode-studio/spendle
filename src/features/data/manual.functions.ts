import { createServerFn } from '@tanstack/react-start'
import * as Schema from 'effect/Schema'

import {
  ManualTransactionFields,
  NewManualTransaction,
} from '@spendle/server/api'

import { api } from '#/lib/api/client.server'

/** A transaction the person types in; the answer carries the entry it became. */
export const createManualTransactionFn = createServerFn({ method: 'POST' })
  .validator(Schema.toStandardSchemaV1(NewManualTransaction))
  .handler(({ data }) =>
    api((client) => client.manual.createTransaction({ payload: data })),
  )

/** A correction of a typed-in transaction: the API keeps it as the next version. */
export const reviseManualTransactionFn = createServerFn({ method: 'POST' })
  .validator(
    Schema.toStandardSchemaV1(
      Schema.Struct({
        externalId: Schema.String,
        ...ManualTransactionFields.fields,
      }),
    ),
  )
  .handler(({ data }) => {
    const { externalId, ...payload } = data
    return api((client) =>
      client.manual.reviseTransaction({ params: { externalId }, payload }),
    )
  })

export const removeManualTransactionFn = createServerFn({ method: 'POST' })
  .validator(
    Schema.toStandardSchemaV1(Schema.Struct({ externalId: Schema.String })),
  )
  .handler(({ data }) =>
    api((client) => client.manual.removeTransaction({ params: data })),
  )

/** The person's note on an entry; null or blank clears it. */
export const setEntryNoteFn = createServerFn({ method: 'POST' })
  .validator(
    Schema.toStandardSchemaV1(
      Schema.Struct({
        entryId: Schema.String,
        note: Schema.NullOr(Schema.String.check(Schema.isMaxLength(500))),
      }),
    ),
  )
  .handler(({ data }) =>
    api((client) =>
      client.manual.setNote({
        params: { entryId: data.entryId },
        payload: { note: data.note },
      }),
    ),
  )

/** Marks an entry one-off (counted in its month, left out of averages) or clears it. */
export const setEntryOneOffFn = createServerFn({ method: 'POST' })
  .validator(
    Schema.toStandardSchemaV1(
      Schema.Struct({ entryId: Schema.String, oneOff: Schema.Boolean }),
    ),
  )
  .handler(({ data }) =>
    api((client) =>
      client.manual.setOneOff({
        params: { entryId: data.entryId },
        payload: { oneOff: data.oneOff },
      }),
    ),
  )

/** The balance the person sees at the bank, checked by the balance proof. */
export const recordCheckpointFn = createServerFn({ method: 'POST' })
  .validator(
    Schema.toStandardSchemaV1(
      Schema.Struct({
        accountId: Schema.String,
        asOf: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
        balanceCents: Schema.Int,
      }),
    ),
  )
  .handler(({ data }) =>
    api((client) =>
      client.manual.recordCheckpoint({
        params: { accountId: data.accountId },
        payload: { asOf: data.asOf, balanceCents: data.balanceCents },
      }),
    ),
  )

export const withdrawCheckpointFn = createServerFn({ method: 'POST' })
  .validator(
    Schema.toStandardSchemaV1(Schema.Struct({ checkpointId: Schema.String })),
  )
  .handler(({ data }) =>
    api((client) => client.manual.withdrawCheckpoint({ params: data })),
  )
