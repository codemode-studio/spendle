import { isAcceptedRecurrenceMatchStatus } from './recurrence-book'
import { daysBetween, inPeriod, todayIso } from './period'
import type { Period } from './period'

export const OTHER_CATEGORY_COLOR = '#94a3b8'

export const ownershipScopeTypes = [
  'household',
  'person',
  'company_br',
  'company_us',
] as const

export type OwnershipScopeType = (typeof ownershipScopeTypes)[number]

/**
 * Taxes are spending in the ledger analysis, but they are not a strategy
 * envelope. Calendar-month budget accounting therefore uses only `essential`
 * and `lifestyle`, while home and category analysis also includes `tax`.
 */
export const analysisSpendingBuckets = [
  'essential',
  'lifestyle',
  'tax',
] as const
export type AnalysisSpendingBucket = (typeof analysisSpendingBuckets)[number]

export const budgetSpendingBuckets = ['essential', 'lifestyle'] as const
export type BudgetSpendingBucket = (typeof budgetSpendingBuckets)[number]

export const internalTransferTypes = [
  'transfer',
  'fx_transfer',
  'card_payment',
] as const
export type InternalTransferType = (typeof internalTransferTypes)[number]

const COMPANY_SCOPE_TYPES = new Set<OwnershipScopeType>([
  'company_br',
  'company_us',
])
const ANALYSIS_SPENDING_BUCKETS = new Set<string>(analysisSpendingBuckets)
const BUDGET_SPENDING_BUCKETS = new Set<string>(budgetSpendingBuckets)
const INTERNAL_TRANSFER_TYPES = new Set<string>(internalTransferTypes)

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

export interface LedgerSnapshot {
  scopes: ReadonlyArray<{ id: string; type: OwnershipScopeType }>
  transactions: ReadonlyArray<{
    id: string
    postedAt: string
    description: string
    normalizedDescription: string
    amountCents: number
    baseAmountCents: number | null
    currency: string
    status: string
    counterpartyAccountId: string | null
    creditCardId: string | null
    account: { ownershipScopeId: string } | null
    creditCard: { ownershipScopeId: string } | null
    category: {
      id: string
      name: string
      color: string
      bucket: string
    } | null
  }>
  reconciliations: ReadonlyArray<{
    status: string
    type: string
    links: ReadonlyArray<{ transactionId: string }>
  }>
  recurrences: ReadonlyArray<{
    occurrences: ReadonlyArray<{
      matches: ReadonlyArray<{ transactionId: string; status: string }>
    }>
  }>
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

type Scope =
  OwnershipScopeType | { type: OwnershipScopeType } | null | undefined

export function isFamilyScope(scope: Scope) {
  const type = typeof scope === 'string' ? scope : scope?.type
  return type === undefined || !COMPANY_SCOPE_TYPES.has(type)
}

export function isBudgetSpendingBucket(
  bucket: string | null,
): bucket is BudgetSpendingBucket {
  return bucket !== null && BUDGET_SPENDING_BUCKETS.has(bucket)
}

export function isInternalTransferType(
  type: string,
): type is InternalTransferType {
  return INTERNAL_TRANSFER_TYPES.has(type)
}

export function isSpending(transaction: FamilyTransaction) {
  return (
    transaction.amountCents < 0 &&
    !transaction.uncategorized &&
    transaction.bucket !== null &&
    ANALYSIS_SPENDING_BUCKETS.has(transaction.bucket)
  )
}

export function baseAmount(transaction: {
  baseAmountCents: number | null
  currency: string
  amountCents: number
}) {
  return (
    transaction.baseAmountCents ??
    (transaction.currency === 'BRL' ? transaction.amountCents : null)
  )
}

export function internalTransferIds(
  snapshot: Pick<LedgerSnapshot, 'reconciliations'>,
) {
  const ids = new Set<string>()
  for (const group of snapshot.reconciliations) {
    if (group.status !== 'confirmed' || !isInternalTransferType(group.type)) {
      continue
    }
    for (const link of group.links) ids.add(link.transactionId)
  }
  return ids
}

export function recurrenceMatchedIds(
  snapshot: Pick<LedgerSnapshot, 'recurrences'>,
) {
  const ids = new Set<string>()
  for (const recurrence of snapshot.recurrences) {
    for (const occurrence of recurrence.occurrences) {
      for (const match of occurrence.matches) {
        if (isAcceptedRecurrenceMatchStatus(match.status)) {
          ids.add(match.transactionId)
        }
      }
    }
  }
  return ids
}

/**
 * Confirmed family entries in BRL, without internal transfers, card payments,
 * company movements, or categories excluded from analysis.
 */
export function familyTransactions(
  snapshot: Pick<LedgerSnapshot, 'scopes' | 'transactions' | 'reconciliations'>,
): Array<FamilyTransaction> {
  const excluded = internalTransferIds(snapshot)
  const scopeById = new Map(snapshot.scopes.map((scope) => [scope.id, scope]))
  const result: Array<FamilyTransaction> = []

  for (const transaction of snapshot.transactions) {
    if (transaction.status !== 'confirmed') continue
    if (excluded.has(transaction.id) || transaction.counterpartyAccountId)
      continue
    const scopeId =
      transaction.account?.ownershipScopeId ??
      transaction.creditCard?.ownershipScopeId
    if (scopeId && !isFamilyScope(scopeById.get(scopeId))) continue
    const category = transaction.category
    const bucket = category?.bucket ?? null
    if (bucket === 'business') continue
    const uncategorized = !category || category.id === 'uncategorized'
    if (bucket === 'excluded' && !uncategorized) continue
    const amount = baseAmount(transaction)
    if (amount === null) continue
    result.push({
      id: transaction.id,
      postedAt: transaction.postedAt,
      description: transaction.description,
      normalized: transaction.normalizedDescription,
      amountCents: amount,
      categoryId: uncategorized ? null : category.id,
      categoryName: uncategorized ? 'Sem categoria' : category.name,
      color: uncategorized ? OTHER_CATEGORY_COLOR : category.color,
      bucket: uncategorized ? null : bucket,
      source: transaction.creditCardId ? 'card' : 'account',
      uncategorized,
    })
  }
  return result
}

/** Returns the first and last posted dates, or `null` when there are no rows. */
export function ledgerSpan(entries: ReadonlyArray<{ postedAt: string }>) {
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
