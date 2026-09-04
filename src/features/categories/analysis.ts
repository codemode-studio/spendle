import type { FamilyTransaction, Period } from '#/features/home/insights'
import { isSpending, shiftDays } from '#/features/home/insights'

const OTHER_COLOR = '#94a3b8'

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

function daysBetween(start: string, end: string) {
  return (
    Math.round(
      (Date.parse(`${end}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) /
        86_400_000,
    ) + 1
  )
}

const shortMonth = new Intl.DateTimeFormat('pt-BR', {
  month: 'short',
  timeZone: 'UTC',
})
const longMonth = new Intl.DateTimeFormat('pt-BR', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
})

export function monthsInPeriod(period: Period): Array<MonthPoint> {
  const months: Array<MonthPoint> = []
  let cursor = `${period.start.slice(0, 7)}-01`
  while (cursor.slice(0, 7) <= period.end.slice(0, 7)) {
    const date = new Date(`${cursor}T12:00:00Z`)
    const key = cursor.slice(0, 7)
    const monthEnd = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
    )
      .toISOString()
      .slice(0, 10)
    months.push({
      key,
      label: shortMonth.format(date).replace('.', ''),
      fullLabel: longMonth.format(date),
      cents: 0,
      partial: cursor < period.start || monthEnd > period.end,
    })
    date.setUTCMonth(date.getUTCMonth() + 1)
    cursor = date.toISOString().slice(0, 10)
  }
  return months
}

function ratio(current: number, previous: number) {
  return previous > 0 ? (current - previous) / previous : null
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
  const previousPeriod: Period = {
    start: shiftDays(period.start, -periodDays),
    end: shiftDays(period.start, -1),
  }
  const months = monthsInPeriod(period)
  const monthIndex = new Map(months.map((month, index) => [month.key, index]))
  const monthsSpan = Math.max(periodDays / (365.25 / 12), 1)

  const current = new Map<
    string,
    {
      name: string
      color: string
      cents: number
      count: number
      monthly: Array<number>
    }
  >()
  const previous = new Map<string, number>()
  let totalCents = 0
  let spendingCount = 0
  let uncategorizedCents = 0
  let uncategorizedCount = 0

  for (const transaction of transactions) {
    const date = transaction.postedAt
    const inCurrent = date >= period.start && date <= period.end
    const inPrevious =
      date >= previousPeriod.start && date <= previousPeriod.end
    if (!inCurrent && !inPrevious) continue
    if (transaction.uncategorized) {
      if (inCurrent && transaction.amountCents < 0) {
        uncategorizedCents += -transaction.amountCents
        uncategorizedCount += 1
      }
      continue
    }
    if (!isSpending(transaction)) continue
    const id = transaction.categoryId ?? 'uncategorized'
    const cents = -transaction.amountCents
    if (inCurrent) {
      const entry = current.get(id) ?? {
        name: transaction.categoryName,
        color: transaction.color || OTHER_COLOR,
        cents: 0,
        count: 0,
        monthly: months.map(() => 0),
      }
      entry.cents += cents
      entry.count += 1
      const index = monthIndex.get(date.slice(0, 7))
      if (index !== undefined) {
        entry.monthly[index] = (entry.monthly[index] ?? 0) + cents
        months[index].cents += cents
      }
      current.set(id, entry)
      totalCents += cents
      spendingCount += 1
    } else {
      previous.set(id, (previous.get(id) ?? 0) + cents)
    }
  }

  const previousTotalCents = [...previous.values()].reduce(
    (sum, value) => sum + value,
    0,
  )
  const items: Array<CategoryTrend> = [...current.entries()]
    .map(([id, entry]) => {
      const previousCents = previous.get(id) ?? 0
      return {
        id,
        name: entry.name,
        color: entry.color,
        cents: entry.cents,
        count: entry.count,
        share: totalCents > 0 ? entry.cents / totalCents : 0,
        monthly: entry.monthly,
        averageMonthlyCents: Math.round(entry.cents / monthsSpan),
        previousCents,
        deltaRatio: ratio(entry.cents, previousCents),
      }
    })
    .sort((left, right) => right.cents - left.cents)

  return {
    period,
    previousPeriod,
    periodDays,
    months,
    totalCents,
    previousTotalCents,
    deltaRatio: ratio(totalCents, previousTotalCents),
    averageMonthlyCents: Math.round(totalCents / monthsSpan),
    spendingCount,
    uncategorizedCents,
    uncategorizedCount,
    items,
  }
}
