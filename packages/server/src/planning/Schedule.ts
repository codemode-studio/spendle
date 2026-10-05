import { dayNumber } from '../domain/LocalDate.ts'

/** How often a recurrence repeats. */
export type Frequency = 'monthly' | 'yearly'

const lastDayOf = (year: number, monthIndex: number) =>
  [
    31,
    (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][monthIndex]!

const format = (year: number, monthIndex: number, day: number) =>
  `${String(year).padStart(4, '0')}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`

const parts = (date: string) =>
  date.split('-').map(Number) as [number, number, number]

/**
 * The date one period after `date`, on the anchor's day (and month, for
 * yearly schedules), clamped to the month's last day.
 */
export const addPeriod = (
  date: string,
  frequency: Frequency,
  anchor = date,
) => {
  const [year, month] = parts(date)
  const [, anchorMonth, anchorDay] = parts(anchor)
  const targetYear =
    frequency === 'monthly' ? year + Math.floor(month / 12) : year + 1
  const monthIndex = frequency === 'monthly' ? month % 12 : anchorMonth - 1
  return format(
    targetYear,
    monthIndex,
    Math.min(anchorDay, lastDayOf(targetYear, monthIndex)),
  )
}

/** The date one period before `date`, on the anchor's day. */
export const previousPeriod = (
  date: string,
  frequency: Frequency,
  anchor: string,
) => {
  const [year, month] = parts(date)
  const [, anchorMonth, anchorDay] = parts(anchor)
  const targetYear =
    frequency === 'monthly' ? (month === 1 ? year - 1 : year) : year - 1
  const monthIndex =
    frequency === 'monthly' ? (month === 1 ? 11 : month - 2) : anchorMonth - 1
  return format(
    targetYear,
    monthIndex,
    Math.min(anchorDay, lastDayOf(targetYear, monthIndex)),
  )
}

/** The period an envelope occurrence collects payments for: `[start, end)`. */
export const aggregateWindow = (
  expectedDate: string,
  schedule: { readonly frequency: Frequency; readonly scheduleAnchor: string },
) => ({
  start: expectedDate,
  end: addPeriod(expectedDate, schedule.frequency, schedule.scheduleAnchor),
})

/** Every scheduled date from `startsOn` through `through`, inclusive. */
export const scheduleDates = (
  schedule: {
    readonly startsOn: string
    readonly scheduleAnchor: string
    readonly frequency: Frequency
  },
  through: string,
) => {
  const dates: Array<string> = []
  for (
    let date = schedule.startsOn;
    date <= through;
    date = addPeriod(date, schedule.frequency, schedule.scheduleAnchor)
  )
    dates.push(date)
  return dates
}

/** Signed whole days from `from` to `to`. */
export const daysFrom = (from: string, to: string) =>
  dayNumber(to) - dayNumber(from)

export const median = (values: ReadonlyArray<number>) => {
  if (values.length === 0) return undefined
  const ordered = [...values].sort((a, b) => a - b)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2
    ? ordered[middle]!
    : (ordered[middle - 1]! + ordered[middle]!) / 2
}
