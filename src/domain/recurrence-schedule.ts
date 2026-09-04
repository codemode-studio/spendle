export const LOOKBACK_DAYS = 45

export type RecurrenceFrequency = 'monthly' | 'yearly'

export function shiftDays(iso: string, days: number) {
  const date = new Date(`${iso}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

export function median(values: number[]) {
  if (!values.length) return undefined
  const ordered = [...values].sort((left, right) => left - right)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2
}

export function addRecurrencePeriod(
  date: string,
  frequency: RecurrenceFrequency,
  scheduleAnchor = date,
) {
  const [year, month] = date.split('-').map(Number)
  const [, anchorMonth, anchorDay] = scheduleAnchor.split('-').map(Number)
  const targetYear =
    frequency === 'monthly' ? year + Math.floor(month / 12) : year + 1
  const normalizedMonth = frequency === 'monthly' ? month % 12 : anchorMonth - 1
  const lastDay = new Date(
    Date.UTC(targetYear, normalizedMonth + 1, 0),
  ).getUTCDate()
  return new Date(
    Date.UTC(targetYear, normalizedMonth, Math.min(anchorDay, lastDay)),
  )
    .toISOString()
    .slice(0, 10)
}

export function previousRecurrencePeriod(
  date: string,
  frequency: RecurrenceFrequency,
  scheduleAnchor: string,
) {
  const [year, month] = date.split('-').map(Number)
  const [, anchorMonth, anchorDay] = scheduleAnchor.split('-').map(Number)
  const targetYear =
    frequency === 'monthly' ? (month === 1 ? year - 1 : year) : year - 1
  const targetMonth =
    frequency === 'monthly' ? (month === 1 ? 11 : month - 2) : anchorMonth - 1
  const lastDay = new Date(
    Date.UTC(targetYear, targetMonth + 1, 0),
  ).getUTCDate()
  return new Date(
    Date.UTC(targetYear, targetMonth, Math.min(anchorDay, lastDay)),
  )
    .toISOString()
    .slice(0, 10)
}

export function aggregateWindow(
  occurrence: { expectedDate: string },
  recurrence: {
    frequency: RecurrenceFrequency
    scheduleAnchor: string
  },
) {
  return {
    start: occurrence.expectedDate,
    end: addRecurrencePeriod(
      occurrence.expectedDate,
      recurrence.frequency,
      recurrence.scheduleAnchor,
    ),
  }
}

export function occurrenceDates(
  input: {
    startsOn: string
    scheduleAnchor: string
    nextDate: string
    frequency: RecurrenceFrequency
  },
  options: { today?: string } = {},
) {
  const today = options.today ?? new Date().toISOString().slice(0, 10)
  const result: string[] = []
  let date = input.startsOn === '1970-01-01' ? input.nextDate : input.startsOn
  if (input.startsOn === '1970-01-01') {
    const previous = previousRecurrencePeriod(
      date,
      input.frequency,
      input.scheduleAnchor,
    )
    if (previous >= shiftDays(today, -LOOKBACK_DAYS)) date = previous
  }
  const lastDate = input.nextDate > today ? input.nextDate : today
  while (date <= lastDate) {
    result.push(date)
    date = addRecurrencePeriod(date, input.frequency, input.scheduleAnchor)
  }
  return result
}
