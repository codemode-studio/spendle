/**
 * Read model da Home sobre o razão real da família (V2).
 * Tudo aqui é cálculo puro (roda no cliente e no servidor) — nenhum dado fictício.
 * Caixa e compromissos vêm da previsão de caixa do V2.
 */
import {
  isSpending,
  OTHER_CATEGORY_COLOR,
  spendingByCategory,
} from '#/domain/ledger'
import type { FamilyTransaction } from '#/domain/ledger'
import { inPeriod, shiftDays, todayIso, trailingPeriod } from '#/domain/period'
import type { Period } from '#/domain/period'

const ALLOCATION_BUCKETS = new Set(['investment', 'reserve'])

// ─── Totais por período ──────────────────────────────────────────────────────

export interface PeriodTotals {
  period: Period
  incomeCents: number
  spendingCents: number
  allocationCents: number
  uncategorizedCents: number
  uncategorizedCount: number
  spendingCount: number
}

function periodTotals(
  transactions: ReadonlyArray<FamilyTransaction>,
  period: Period,
): PeriodTotals {
  const totals: PeriodTotals = {
    period,
    incomeCents: 0,
    spendingCents: 0,
    allocationCents: 0,
    uncategorizedCents: 0,
    uncategorizedCount: 0,
    spendingCount: 0,
  }
  for (const transaction of transactions) {
    if (!inPeriod(transaction.postedAt, period)) continue
    const amount = transaction.amountCents
    if (transaction.uncategorized) {
      if (amount < 0) {
        totals.uncategorizedCents += -amount
        totals.uncategorizedCount += 1
      }
      continue
    }
    if (amount > 0 && transaction.bucket === 'income') {
      totals.incomeCents += amount
    } else if (isSpending(transaction)) {
      totals.spendingCents += -amount
      totals.spendingCount += 1
    } else if (
      amount < 0 &&
      transaction.bucket !== null &&
      ALLOCATION_BUCKETS.has(transaction.bucket)
    ) {
      totals.allocationCents += -amount
    }
  }
  return totals
}

// ─── Gastos por categoria ────────────────────────────────────────────────────

export interface CategoryShare {
  id: string
  name: string
  color: string
  cents: number
  count: number
  /** Participação no total do período (0–1). */
  share: number
  /** Média para uma janela do mesmo tamanho, calculada no período de referência. */
  referenceCents: number
  deltaCents: number
  /** Variação vs referência (0.2 = +20%). `null` quando não há referência. */
  deltaRatio: number | null
  folded: boolean
}

export interface CategoryBreakdown {
  totalCents: number
  referenceTotalCents: number
  items: Array<CategoryShare>
}

/**
 * Gastos por categoria no período, comparados com a média de janelas do mesmo
 * tamanho nos `referenceDays` dias anteriores. As categorias além de `limit`
 * são agrupadas em "Outras".
 */
function categoryBreakdown(
  transactions: ReadonlyArray<FamilyTransaction>,
  period: Period,
  referenceDays = 90,
  limit = 7,
): CategoryBreakdown {
  const reference: Period = {
    start: shiftDays(period.start, -referenceDays),
    end: shiftDays(period.start, -1),
  }
  const spending = spendingByCategory(transactions, period, reference)
  const all: Array<CategoryShare> = spending.items.map((item) => ({
    id: item.id,
    name: item.name,
    color: item.color,
    cents: item.cents,
    count: item.count,
    share: item.share,
    referenceCents: item.previousCents,
    deltaCents: item.deltaCents,
    deltaRatio: item.deltaRatio,
    folded: false,
  }))

  const visible = all.filter((item) => item.cents > 0)
  if (visible.length <= limit)
    return {
      totalCents: spending.totalCents,
      referenceTotalCents: spending.previousTotalCents,
      items: visible,
    }
  const head = visible.slice(0, limit - 1)
  const tail = visible.slice(limit - 1)
  const folded: CategoryShare = {
    id: 'other',
    name: `Outras (${tail.length})`,
    color: OTHER_CATEGORY_COLOR,
    cents: tail.reduce((sum, item) => sum + item.cents, 0),
    count: tail.reduce((sum, item) => sum + item.count, 0),
    share: 0,
    referenceCents: tail.reduce((sum, item) => sum + item.referenceCents, 0),
    deltaCents: 0,
    deltaRatio: null,
    folded: true,
  }
  folded.share =
    spending.totalCents > 0 ? folded.cents / spending.totalCents : 0
  folded.deltaCents = folded.cents - folded.referenceCents
  folded.deltaRatio =
    folded.referenceCents > 0 ? folded.deltaCents / folded.referenceCents : null
  return {
    totalCents: spending.totalCents,
    referenceTotalCents: spending.previousTotalCents,
    items: [...head, folded],
  }
}

// ─── Visão consolidada do painel ─────────────────────────────────────────────

export interface HomeView {
  last30: PeriodTotals
  categories30: CategoryBreakdown
  /** Data do lançamento mais recente da família (ou null sem dados). */
  latestPostedAt: string | null
  integrity: { partial: boolean }
  comparisonReady: { fortnight: boolean; month: boolean; categories: boolean }
}

/**
 * Totais e categorias dos últimos 30 dias sobre o razão da família (V2).
 * Comparações só valem quando o histórico cobre a janela inteira e não há
 * pendências que deixem o mês parcial.
 */
export function buildHomeView(
  transactions: ReadonlyArray<FamilyTransaction>,
  integrity: { partial: boolean },
  today = todayIso(),
): HomeView {
  const p30 = trailingPeriod(30, 0, today)
  const earliest = transactions.reduce<string | null>(
    (first, transaction) =>
      first === null || transaction.postedAt < first
        ? transaction.postedAt
        : first,
    null,
  )
  const canCompare = (days: number) =>
    !integrity.partial &&
    earliest !== null &&
    earliest <= trailingPeriod(days, 0, today).start

  return {
    last30: periodTotals(transactions, p30),
    categories30: categoryBreakdown(transactions, p30),
    integrity: { partial: integrity.partial },
    comparisonReady: {
      fortnight: canCompare(28),
      month: canCompare(60),
      categories: canCompare(120),
    },
    latestPostedAt: transactions.reduce<string | null>(
      (latest, transaction) =>
        latest === null || transaction.postedAt > latest
          ? transaction.postedAt
          : latest,
      null,
    ),
  }
}
