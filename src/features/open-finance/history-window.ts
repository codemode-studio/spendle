import { addMonths, resolveCardCycle } from '#/domain/credit-card'
import { shiftDays } from '#/domain/period'

export const pluggyHistoryMonths = [3, 6] as const
export type PluggyHistoryMonths = (typeof pluggyHistoryMonths)[number]

/** Days re-read before the latest local fact so overlap becomes evidence. */
export const PLUGGY_OVERLAP_DAYS = 7

/**
 * First day copied for an instrument without local history. Accounts start
 * on a month boundary so the first budget month is complete; cards start on
 * the statement cycle containing that day so the first statement is whole.
 */
export function pluggyHistoryStart(input: {
  today: string
  months: PluggyHistoryMonths
  closingDay?: number
}) {
  const monthStart = addMonths(`${input.today.slice(0, 7)}-01`, -input.months)
  if (input.closingDay === undefined) return monthStart
  const previousClosing = resolveCardCycle(
    addMonths(monthStart, -1),
    input.closingDay,
    input.closingDay,
  ).closingDate
  return shiftDays(previousClosing, 1)
}

/** Continues an instrument that already has local facts. */
export function pluggyContinuationStart(latestPostedAt: string) {
  return shiftDays(latestPostedAt, -PLUGGY_OVERLAP_DAYS)
}
