import * as Schema from 'effect/Schema'

/** Integer minor units (centavos for BRL). Money never passes through floats. */
export const Cents = Schema.Int

/** ISO 4217 code, for example `BRL`. */
export const Currency = Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/))

const isCalendarDate = (date: string) => {
  const [year, month, day] = date.split('-').map(Number) as [
    number,
    number,
    number,
  ]
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  const days =
    [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0
  return day >= 1 && day <= days
}

/** A real calendar date without time zone, `YYYY-MM-DD`, as banks report booking dates. */
export const LocalDate = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/),
  Schema.makeFilter(isCalendarDate, { description: 'a real calendar date' }),
)
