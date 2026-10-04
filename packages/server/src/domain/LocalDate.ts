import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'

// Calendar arithmetic on `YYYY-MM-DD` strings. Dates are anchored at UTC
// midnight only to reuse DateTime's calendar math; no time zone is implied.
const parse = (date: string) => DateTime.makeUnsafe(`${date}T00:00:00Z`)

export const addDays = (date: string, days: number) =>
  DateTime.formatIsoDateUtc(DateTime.add(parse(date), { days }))

/** The first day of the month `months` away from the month containing `date`. */
export const monthStart = (date: string, months = 0) =>
  DateTime.formatIsoDateUtc(
    DateTime.add(parse(`${date.slice(0, 7)}-01`), { months }),
  )

/** `day` of the month containing `date`, clamped to that month's last day. */
export const dayOfMonth = (date: string, day: number) => {
  const first = monthStart(date)
  const last = Number(addDays(monthStart(date, 1), -1).slice(8))
  return `${first.slice(0, 8)}${String(Math.min(day, last)).padStart(2, '0')}`
}

export const max = (a: string, b: string) => (a > b ? a : b)

/** Days since a fixed epoch (the inverse of civil-from-days); exact for the Gregorian calendar. */
export const dayNumber = (date: string) => {
  const [year, month, day] = date.split('-').map(Number) as [
    number,
    number,
    number,
  ]
  const y = month <= 2 ? year - 1 : year
  const era = Math.floor(y / 400)
  const yearOfEra = y - era * 400
  const dayOfYear =
    Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1
  return (
    era * 146097 +
    yearOfEra * 365 +
    Math.floor(yearOfEra / 4) -
    Math.floor(yearOfEra / 100) +
    dayOfYear
  )
}

/** Whole days between two dates, regardless of order. */
export const daysBetween = (a: string, b: string) =>
  Math.abs(dayNumber(a) - dayNumber(b))

const saoPaulo = DateTime.zoneMakeNamedUnsafe('America/Sao_Paulo')

/** The São Paulo calendar day of an instant; Brazilian banks book on it. */
export const dateInSaoPaulo = (instant: DateTime.DateTime | string) =>
  DateTime.formatIsoDate(
    DateTime.makeZonedUnsafe(instant, { timeZone: saoPaulo }),
  )

/** Today's date in São Paulo, from the Effect clock. */
export const today = Effect.map(DateTime.now, dateInSaoPaulo)

/** 0 = Sunday … 6 = Saturday. */
export const weekday = (date: string) => {
  const [year, month, day] = date.split('-').map(Number) as [
    number,
    number,
    number,
  ]
  // Sakamoto's method.
  const offsets = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4]
  const y = month < 3 ? year - 1 : year
  return (
    (y +
      Math.floor(y / 4) -
      Math.floor(y / 100) +
      Math.floor(y / 400) +
      offsets[month - 1]! +
      day) %
    7
  )
}

/** The date itself on a weekday, else the following Monday. Bank holidays are not known here. */
export const nextBusinessDay = (date: string) => {
  const day = weekday(date)
  return day === 6 ? addDays(date, 2) : day === 0 ? addDays(date, 1) : date
}
