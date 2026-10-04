import { addDays, dayOfMonth, monthStart } from '../domain/LocalDate.ts'

export const historyMonthOptions = [3, 6] as const
export type HistoryMonths = (typeof historyMonthOptions)[number]

/** Days re-read before the latest stored fact, so late or changed reports are caught. */
export const overlapDays = 7

/**
 * First day copied for a newly linked account. Accounts start on a month
 * boundary so the first month is complete. Cards start the day after the
 * closing that precedes that month, so the first statement is whole.
 */
export const historyStart = (input: {
  readonly today: string
  readonly months: HistoryMonths
  readonly closingDay?: number | undefined
}) => {
  const start = monthStart(input.today, -input.months)
  if (input.closingDay === undefined) return start
  return addDays(dayOfMonth(monthStart(start, -1), input.closingDay), 1)
}

/** Where a later sync starts reading: the overlap before the latest stored fact. */
export const continuationStart = (latestBookedOn: string) =>
  addDays(latestBookedOn, -overlapDays)
