import * as Schema from 'effect/Schema'

/** A value that was in another currency, shown in reais. */
export const Converted = Schema.Struct({
  /** The value in centavos. */
  cents: Schema.Int,
  currency: Schema.String,
  /** The value in its own currency's minor units. */
  originalCents: Schema.Int,
  /** Reais per unit × 1 000 000. */
  rateMicros: Schema.Int,
  /** The day the rate applies to. */
  rateDate: Schema.String,
  source: Schema.String,
})
export type Converted = typeof Converted.Type

/** The rates other currencies in use convert at, and those without one (left out of totals). */
export const Exchange = Schema.Struct({
  rates: Schema.Array(
    Schema.Struct({
      currency: Schema.String,
      rateMicros: Schema.Int,
      date: Schema.String,
      source: Schema.String,
    }),
  ),
  missing: Schema.Array(Schema.String),
})
export type Exchange = typeof Exchange.Type
