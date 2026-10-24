import { addDays, daysBetween, monthStart } from '../domain/LocalDate.ts'
import { convert } from '../rates/Conversion.ts'
import type { RateTable } from '../rates/Conversion.ts'

/** The buckets whose categories are spending, and so may have a cap. */
export const spendingBuckets: ReadonlySet<string> = new Set([
  'essential',
  'lifestyle',
  'tax',
  'business',
])

/** A cap the person set for a category from `fromMonth` on; null removes it. */
export interface CategoryCap {
  readonly categoryId: string
  readonly fromMonth: string
  readonly cents: number | null
}

export interface SpendingEntry {
  readonly accountId: string
  readonly bookedOn: string
  readonly amountCents: number
  readonly currency: string
  readonly categoryId: string | null
  readonly bucket: string | null
  readonly excludedFromSpending: boolean
}

export interface CategorySpending {
  readonly categoryId: string
  /** Outflows less refunds, in reais; positive when spent. */
  readonly spentCents: number
  readonly entryCount: number
  /** The caps of the period's months, prorated to its days; null without any. */
  readonly capCents: number | null
}

/** The cap in force for a category in `month`: the latest set from that month or before. */
export const capIn = (
  caps: ReadonlyArray<CategoryCap>,
  categoryId: string,
  month: string,
) =>
  caps
    .filter((cap) => cap.categoryId === categoryId && cap.fromMonth <= month)
    .reduce<CategoryCap | null>(
      (latest, cap) =>
        latest === null || cap.fromMonth > latest.fromMonth ? cap : latest,
      null,
    )?.cents ?? null

/**
 * A category's caps over `from`..`to`: each month's cap weighted by the share
 * of its days the period covers, so a whole month is its cap and a week a
 * quarter of it. Null when no month of the period has a cap.
 */
const periodCap = (
  caps: ReadonlyArray<CategoryCap>,
  categoryId: string,
  from: string,
  to: string,
) => {
  let total: number | null = null
  for (
    let start = monthStart(from);
    start <= to;
    start = monthStart(start, 1)
  ) {
    const cap = capIn(caps, categoryId, start.slice(0, 7))
    if (cap === null) continue
    const end = addDays(monthStart(start, 1), -1)
    const days = daysBetween(end, start) + 1
    const covered =
      daysBetween(to < end ? to : end, from > start ? from : start) + 1
    total = (total ?? 0) + (cap * covered) / days
  }
  return total === null ? null : Math.round(total)
}

/**
 * Spending per category from `from` to `to`, by purchase date, on the given
 * accounts, against the caps of the period. Movements between the person's
 * own accounts and categories outside spending are left out; outflows
 * without a category are reported apart, as they may be spending too.
 * Amounts in another currency count in reais at the rate of their day.
 */
export const spendingAgainstCaps = (input: {
  readonly from: string
  readonly to: string
  readonly accountIds: ReadonlySet<string>
  readonly entries: ReadonlyArray<SpendingEntry>
  readonly caps: ReadonlyArray<CategoryCap>
  readonly rates: RateTable
}) => {
  const spent = new Map<string, { cents: number; count: number }>()
  let unclassifiedCents = 0
  let unconvertedCount = 0
  for (const entry of input.entries) {
    if (entry.bookedOn < input.from || entry.bookedOn > input.to) continue
    if (!input.accountIds.has(entry.accountId)) continue
    if (entry.excludedFromSpending) continue
    const counted =
      entry.categoryId === null || spendingBuckets.has(entry.bucket ?? '')
    if (!counted) continue
    const value = convert(
      input.rates,
      entry.amountCents,
      entry.currency,
      entry.bookedOn,
    )
    if (value === null) {
      unconvertedCount++
      continue
    }
    if (entry.categoryId === null) {
      if (value.cents < 0) unclassifiedCents -= value.cents
      continue
    }
    const category = spent.get(entry.categoryId) ?? { cents: 0, count: 0 }
    category.cents -= value.cents
    category.count++
    spent.set(entry.categoryId, category)
  }
  const capped = new Set(input.caps.map((cap) => cap.categoryId))
  const categories = [...new Set([...spent.keys(), ...capped])]
    .map((categoryId): CategorySpending => ({
      categoryId,
      spentCents: spent.get(categoryId)?.cents ?? 0,
      entryCount: spent.get(categoryId)?.count ?? 0,
      capCents: periodCap(input.caps, categoryId, input.from, input.to),
    }))
    .filter((category) => category.entryCount > 0 || category.capCents !== null)
    .sort(
      (a, b) =>
        b.spentCents - a.spentCents || a.categoryId.localeCompare(b.categoryId),
    )
  return { categories, unclassifiedCents, unconvertedCount }
}
