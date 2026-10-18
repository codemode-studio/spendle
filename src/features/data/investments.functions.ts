import { createServerFn } from '@tanstack/react-start'
import * as Schema from 'effect/Schema'

import { api } from '#/lib/api/client.server'

const PositionFields = Schema.Struct({
  assetClassId: Schema.String,
  name: Schema.String.check(Schema.isMinLength(2), Schema.isMaxLength(100)),
  reserve: Schema.Boolean,
})

export const investmentsSnapshotFn = createServerFn({ method: 'GET' }).handler(
  () => api((client) => client.investments.snapshot({ query: {} })),
)

/** Puts a brokerage movement into a position, or into a new one. */
export const classifyMovementFn = createServerFn({ method: 'POST' })
  .validator(
    Schema.toStandardSchemaV1(
      Schema.Struct({
        entryId: Schema.String,
        positionId: Schema.optional(Schema.String),
        newPosition: Schema.optional(PositionFields),
      }),
    ),
  )
  .handler(({ data }) =>
    api((client) => client.investments.classify({ payload: data })),
  )

export const unclassifyMovementFn = createServerFn({ method: 'POST' })
  .validator(
    Schema.toStandardSchemaV1(Schema.Struct({ entryId: Schema.String })),
  )
  .handler(({ data }) =>
    api((client) => client.investments.unclassify({ params: data })),
  )

/** The position's total at the end of a day, as the person reads it at the broker. */
export const recordValuationFn = createServerFn({ method: 'POST' })
  .validator(
    Schema.toStandardSchemaV1(
      Schema.Struct({
        positionId: Schema.String,
        asOf: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
        amountCents: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      }),
    ),
  )
  .handler(({ data }) =>
    api((client) =>
      client.investments.recordValuation({
        params: { positionId: data.positionId },
        payload: { asOf: data.asOf, amountCents: data.amountCents },
      }),
    ),
  )
