import { isSpending, spendingByCategory } from '#/domain/ledger'
import type { FamilyTransaction } from '#/domain/ledger'
import {
  daysBetween,
  inPeriod,
  monthKey,
  monthsInPeriod,
  previousPeriod as periodBefore,
} from '#/domain/period'
import type { Period } from '#/domain/period'

export interface MonthPoint {
  /** `YYYY-MM` */
  key: string
  /** `abr` */
  label: string
  /** `abril de 2026` */
  fullLabel: string
  cents: number
  /** Só parte do mês cai dentro do período. */
  partial: boolean
}

export interface CategoryTrend {
  id: string
  name: string
  color: string
  cents: number
  count: number
  /** Participação no total do período (0–1). */
  share: number
  /** Gasto por mês, na ordem de `months`. */
  monthly: Array<number>
  averageMonthlyCents: number
  /** Gasto no período imediatamente anterior, de mesmo tamanho. */
  previousCents: number
  /** Variação vs período anterior (0.2 = +20%). `null` sem referência. */
  deltaRatio: number | null
}

export interface CategoryAnalysis {
  period: Period
  previousPeriod: Period
  periodDays: number
  months: Array<MonthPoint>
  totalCents: number
  previousTotalCents: number
  deltaRatio: number | null
  averageMonthlyCents: number
  spendingCount: number
  uncategorizedCents: number
  uncategorizedCount: number
  items: Array<CategoryTrend>
}

/**
 * Gastos por categoria num período, com série mensal por categoria e
 * comparação com o período imediatamente anterior de mesmo tamanho.
 */
export function analyzeCategories(
  transactions: Array<FamilyTransaction>,
  period: Period,
): CategoryAnalysis {
  const periodDays = daysBetween(period.start, period.end)
  const previousPeriod = periodBefore(period)
  const spending = spendingByCategory(transactions, period, previousPeriod)
  const months: Array<MonthPoint> = monthsInPeriod(period).map((month) => ({
    ...month,
    cents: 0,
  }))
  const monthIndex = new Map(months.map((month, index) => [month.key, index]))
  const monthsSpan = Math.max(periodDays / (365.25 / 12), 1)
  const monthlyByCategory = new Map<string, Array<number>>()
  let uncategorizedCents = 0
  let uncategorizedCount = 0

  for (const transaction of transactions) {
    if (!inPeriod(transaction.postedAt, period)) continue
    if (transaction.uncategorized) {
      if (transaction.amountCents < 0) {
        uncategorizedCents += -transaction.amountCents
        uncategorizedCount += 1
      }
      continue
    }
    if (!isSpending(transaction)) continue
    const id = transaction.categoryId ?? 'uncategorized'
    const cents = -transaction.amountCents
    const monthly = monthlyByCategory.get(id) ?? months.map(() => 0)
    const index = monthIndex.get(monthKey(transaction.postedAt))
    if (index !== undefined) {
      monthly[index] = (monthly[index] ?? 0) + cents
      months[index].cents += cents
    }
    monthlyByCategory.set(id, monthly)
  }

  const items: Array<CategoryTrend> = spending.items
    .filter((item) => item.cents > 0)
    .map((item) => ({
      id: item.id,
      name: item.name,
      color: item.color,
      cents: item.cents,
      count: item.count,
      share: item.share,
      monthly: monthlyByCategory.get(item.id) ?? months.map(() => 0),
      averageMonthlyCents: Math.round(item.cents / monthsSpan),
      previousCents: item.previousCents,
      deltaRatio: item.deltaRatio,
    }))

  return {
    period,
    previousPeriod,
    periodDays,
    months,
    totalCents: spending.totalCents,
    previousTotalCents: spending.previousTotalCents,
    deltaRatio:
      spending.previousTotalCents > 0
        ? (spending.totalCents - spending.previousTotalCents) /
          spending.previousTotalCents
        : null,
    averageMonthlyCents: Math.round(spending.totalCents / monthsSpan),
    spendingCount: spending.spendingCount,
    uncategorizedCents,
    uncategorizedCount,
    items,
  }
}
