/**
 * What variable categories (groceries, delivery, fuel…) will still cost
 * in a month, estimated from their history. Pure: the month view gathers
 * the spending and this decides the estimate, so a better rule reruns
 * over the same history.
 */
import { median } from './Schedule.ts'

/** Complete months before the current one the estimate looks at. */
export const historyMonths = 3

export interface CategoryHistory {
  readonly categoryId: string
  /** Net spending in each trailing month, refunds subtracted; months without any count as zero. */
  readonly monthlyCents: ReadonlyArray<number>
  /** Already spent in the month being estimated. */
  readonly spentCents: number
}

export interface CategoryEstimate {
  readonly categoryId: string
  readonly medianCents: number
  readonly spentCents: number
  readonly estimateCents: number
}

/**
 * Each category's typical month is the median of its trailing months, so
 * one unusual month moves nothing. What remains is that month prorated to
 * the days still ahead, never more than the typical month minus what was
 * already spent: a category that reached its usual amount adds nothing.
 */
export const estimateVariableSpending = (input: {
  readonly categories: ReadonlyArray<CategoryHistory>
  readonly remainingDays: number
  readonly monthDays: number
}): ReadonlyArray<CategoryEstimate> =>
  input.categories.flatMap((category) => {
    const typical = Math.round(
      median(category.monthlyCents.map((cents) => Math.max(0, cents))) ?? 0,
    )
    if (typical <= 0 || input.remainingDays <= 0) return []
    const prorated = Math.round(
      (typical * Math.min(input.remainingDays, input.monthDays)) /
        input.monthDays,
    )
    const estimateCents = Math.min(
      prorated,
      Math.max(0, typical - Math.max(0, category.spentCents)),
    )
    return estimateCents > 0
      ? [
          {
            categoryId: category.categoryId,
            medianCents: typical,
            spentCents: category.spentCents,
            estimateCents,
          },
        ]
      : []
  })
