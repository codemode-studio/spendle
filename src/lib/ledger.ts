import { daysBetween, inPeriod, todayIso } from './period'
import type { Period } from './period'

export const OTHER_CATEGORY_COLOR = '#94a3b8'

/** Buckets home and category analysis count as spending, taxes included. */
const ANALYSIS_SPENDING_BUCKETS = new Set<string>([
  'essential',
  'lifestyle',
  'tax',
  'business',
])

export interface FamilyTransaction {
  id: string
  postedAt: string
  description: string
  normalized: string
  /** Signed value converted to BRL. */
  amountCents: number
  categoryId: string | null
  categoryName: string
  color: string
  bucket: string | null
  source: 'account' | 'card'
  uncategorized: boolean
}

export interface CategorySpendCurrent {
  name: string
  color: string
  cents: number
  count: number
}

export interface CategorySpend {
  id: string
  name: string
  color: string
  cents: number
  count: number
  share: number
  previousCents: number
  deltaCents: number
  deltaRatio: number | null
}

export interface CategorySpending {
  current: Map<string, CategorySpendCurrent>
  /** Values scaled to a window with the same number of days as `period`. */
  previous: Map<string, number>
  totalCents: number
  previousTotalCents: number
  spendingCount: number
  items: Array<CategorySpend>
}

export function isSpending(transaction: FamilyTransaction) {
  return (
    transaction.amountCents < 0 &&
    !transaction.uncategorized &&
    transaction.bucket !== null &&
    ANALYSIS_SPENDING_BUCKETS.has(transaction.bucket)
  )
}

/** Returns the first and last posted dates, or `null` when there are no rows. */
function ledgerSpan(entries: ReadonlyArray<{ postedAt: string }>) {
  if (entries.length === 0) return null
  let start = entries[0].postedAt
  let end = start
  for (const entry of entries.slice(1)) {
    if (entry.postedAt < start) start = entry.postedAt
    if (entry.postedAt > end) end = entry.postedAt
  }
  return { start, end } satisfies Period
}

/** Full history through `today`; future entries do not move the start forward. */
export function fullPeriod(
  entries: ReadonlyArray<{ postedAt: string }>,
  today = todayIso(),
): Period {
  const span = ledgerSpan(entries)
  return {
    start: span && span.start < today ? span.start : today,
    end: today,
  }
}

/**
 * Category spending in one period against another. A longer comparison period
 * is scaled to the current period length before shares and deltas are derived.
 */
export function spendingByCategory(
  entries: ReadonlyArray<FamilyTransaction>,
  period: Period,
  previousPeriod: Period,
): CategorySpending {
  const current = new Map<string, CategorySpendCurrent>()
  const previousRaw = new Map<string, number>()
  let spendingCount = 0

  for (const entry of entries) {
    if (!isSpending(entry)) continue
    const id = entry.categoryId ?? 'uncategorized'
    const cents = -entry.amountCents
    if (inPeriod(entry.postedAt, period)) {
      const category = current.get(id) ?? {
        name: entry.categoryName,
        color: entry.color || OTHER_CATEGORY_COLOR,
        cents: 0,
        count: 0,
      }
      category.cents += cents
      category.count += 1
      current.set(id, category)
      spendingCount += 1
    } else if (inPeriod(entry.postedAt, previousPeriod)) {
      previousRaw.set(id, (previousRaw.get(id) ?? 0) + cents)
    }
  }

  const currentDays = daysBetween(period.start, period.end)
  const previousDays = daysBetween(previousPeriod.start, previousPeriod.end)
  const scale = previousDays > 0 ? currentDays / previousDays : 0
  const previous = new Map(
    [...previousRaw].map(([id, cents]) => [id, Math.round(cents * scale)]),
  )
  const totalCents = [...current.values()].reduce(
    (sum, category) => sum + category.cents,
    0,
  )
  const previousTotalCents = Math.round(
    [...previousRaw.values()].reduce((sum, cents) => sum + cents, 0) * scale,
  )
  const ids = new Set([...current.keys(), ...previous.keys()])
  const items = [...ids]
    .map((id): CategorySpend => {
      const category = current.get(id)
      const cents = category?.cents ?? 0
      const previousCents = previous.get(id) ?? 0
      const deltaCents = cents - previousCents
      return {
        id,
        name: category?.name ?? id,
        color: category?.color ?? OTHER_CATEGORY_COLOR,
        cents,
        count: category?.count ?? 0,
        share: totalCents > 0 ? cents / totalCents : 0,
        previousCents,
        deltaCents,
        deltaRatio: previousCents > 0 ? deltaCents / previousCents : null,
      }
    })
    .filter((item) => item.cents !== 0 || item.previousCents !== 0)
    .sort((left, right) => right.cents - left.cents)

  return {
    current,
    previous,
    totalCents,
    previousTotalCents,
    spendingCount,
    items,
  }
}
