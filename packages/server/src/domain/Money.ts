import * as Schema from 'effect/Schema'

/** Integer minor units (centavos for BRL). Money never passes through floats. */
export const Cents = Schema.Int

/** ISO 4217 code, for example `BRL`. */
export const Currency = Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/))

/** A calendar date without time zone, `YYYY-MM-DD`, as banks report booking dates. */
export const LocalDate = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/),
)
