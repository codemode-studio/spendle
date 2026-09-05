/**
 * Derivações do painel sobre o snapshot financeiro real.
 * Tudo aqui é cálculo puro (roda no cliente e no servidor) — nenhum dado fictício.
 */
import {
  familyTransactions,
  internalTransferIds,
  isFamilyScope,
  isSpending,
  OTHER_CATEGORY_COLOR,
  recurrenceMatchedIds,
  spendingByCategory,
} from '#/domain/ledger'
import type { FamilyTransaction } from '#/domain/ledger'
import {
  daysBetween,
  formatShortDate,
  inPeriod,
  shiftDays,
  todayIso,
  trailingPeriod,
} from '#/domain/period'
import type { Period } from '#/domain/period'
import type {
  DashboardSnapshot,
  FinanceSnapshot,
} from '#/features/finance/snapshot.types'

import { knowledgeExactPatterns } from '#/domain/knowledge-pattern'
import { addRecurrencePeriod } from '#/domain/recurrence-schedule'

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

export function periodTotals(
  transactions: Array<FamilyTransaction>,
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

/** Entradas bancárias na moeda do extrato; não equivalem a receita classificada. */
export function accountInflowsByCurrency(
  snapshot: FinanceSnapshot,
  period: Period,
) {
  const internal = internalTransferIds(snapshot)
  const totals = new Map<
    string,
    {
      currency: string
      cents: number
      transactionIds: string[]
      uncategorizedCount: number
    }
  >()
  for (const row of snapshot.transactions) {
    if (
      !row.accountId ||
      row.status !== 'confirmed' ||
      row.amountCents <= 0 ||
      !inPeriod(row.postedAt, period) ||
      internal.has(row.id) ||
      row.counterpartyAccountId
    )
      continue
    const total = totals.get(row.currency) ?? {
      currency: row.currency,
      cents: 0,
      transactionIds: [],
      uncategorizedCount: 0,
    }
    total.cents += row.amountCents
    total.transactionIds.push(row.id)
    if (!row.categoryId || row.categoryId === 'uncategorized')
      total.uncategorizedCount += 1
    totals.set(row.currency, total)
  }
  return [...totals.values()].sort((a, b) =>
    a.currency.localeCompare(b.currency),
  )
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
export function categoryBreakdown(
  transactions: Array<FamilyTransaction>,
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

// ─── Maiores destinos (estabelecimentos) ─────────────────────────────────────

export interface MerchantShare {
  key: string
  name: string
  cents: number
  count: number
  categoryName: string
  color: string
}

export function topMerchants(
  transactions: Array<FamilyTransaction>,
  period: Period,
  limit = 5,
): Array<MerchantShare> {
  const merchants = new Map<string, MerchantShare>()
  for (const transaction of transactions) {
    if (!isSpending(transaction)) continue
    if (!inPeriod(transaction.postedAt, period)) continue
    const key = transaction.normalized || transaction.description
    const entry = merchants.get(key) ?? {
      key,
      name: transaction.description,
      cents: 0,
      count: 0,
      categoryName: transaction.categoryName,
      color: transaction.color,
    }
    entry.cents += -transaction.amountCents
    entry.count += 1
    merchants.set(key, entry)
  }
  return [...merchants.values()]
    .sort((a, b) => b.cents - a.cents)
    .slice(0, limit)
}

// ─── Caixa da família ────────────────────────────────────────────────────────

function familyOperatingAccounts(snapshot: FinanceSnapshot) {
  return snapshot.accounts.filter(
    (account) =>
      account.active &&
      account.purpose === 'operating' &&
      account.currency === 'BRL' &&
      isFamilyScope(account.scope),
  )
}

/** Caixa disponível hoje: contas operacionais da família em BRL. */
export function operatingCashCents(snapshot: FinanceSnapshot) {
  return familyOperatingAccounts(snapshot).reduce(
    (sum, account) => sum + account.balanceCents,
    0,
  )
}

export interface CashPoint {
  date: string
  balanceCents: number
  lowCents?: number
  highCents?: number
}

export interface CashProjection {
  points: Array<CashPoint>
  todayIndex: number
  lowPoint: CashPoint | null
  in30Cents: number
  dailyVariableCents: number
  recurringEstimateTransactionIds: string[]
  largestHistoricalExpenses: Array<{
    id: string
    date: string
    description: string
    cents: number
  }>
  assumptions: {
    days: number
    startingCents: number
    estimatedIncomeCents: number
    estimatedRecurrenceCents: number
    closedCardCents: number
    scheduledCardCents: number
    estimatedCardCents: number
    historicalEstimateCents: number
  }
}

/** Completa o cenário sem criar ocorrências ou substituir pagamentos registrados. */
function forecastOccurrences(
  recurrence: FinanceSnapshot['recurrences'][number],
  horizon: string,
) {
  const occurrences = new Map(
    recurrence.occurrences.map((occurrence) => [
      occurrence.expectedDate,
      {
        id: occurrence.id,
        expectedDate: occurrence.expectedDate,
        expectedAmountCents: occurrence.expectedAmountCents,
        currency: occurrence.currency,
        direction: occurrence.direction,
        status: occurrence.status,
      },
    ]),
  )
  for (
    let date = recurrence.nextDate;
    date <= horizon;
    date = addRecurrencePeriod(
      date,
      recurrence.frequency,
      recurrence.scheduleAnchor,
    )
  ) {
    if (occurrences.has(date)) continue
    occurrences.set(date, {
      id: `forecast:${recurrence.id}:${date}`,
      expectedDate: date,
      expectedAmountCents: Math.abs(recurrence.amountCents),
      currency: recurrence.currency,
      direction: recurrence.direction,
      status: 'expected',
    })
  }
  return [...occurrences.values()]
}

/**
 * Caixa operacional: histórico real (reconstruído das transações) + projeção
 * aplicando recorrências esperadas em conta, faturas conhecidas e a média
 * diária de gasto variável dos últimos 60 dias.
 */
export function projectCash(
  snapshot: FinanceSnapshot,
  daysBack = 90,
  daysAhead = 60,
  today = todayIso(),
): CashProjection {
  const accounts = familyOperatingAccounts(snapshot)
  const accountIds = new Set(accounts.map((account) => account.id))
  const startBalance = operatingCashCents(snapshot)
  const excluded = internalTransferIds(snapshot)
  const matched = recurrenceMatchedIds({
    recurrences: snapshot.recurrences.filter(
      (recurrence) => recurrence.active && !recurrence.creditCardId,
    ),
  })
  const cardIds = new Set(
    snapshot.cards
      .filter((card) => isFamilyScope(card.scope) && card.currency === 'BRL')
      .map((card) => card.id),
  )
  const installmentIds = new Set(
    snapshot.installmentPlans.map((plan) => plan.sourceTransactionId),
  )

  const recurringEstimates = snapshot.recurrences
    .filter(
      (recurrence) =>
        recurrence.active &&
        !recurrence.creditCardId &&
        recurrence.direction === 'expense',
    )
    .map((recurrence) => ({
      recurrence,
      patterns: new Set(
        recurrence.knowledgeReferences.flatMap((entry) =>
          knowledgeExactPatterns(entry.description),
        ),
      ),
    }))
  const recurringEstimateTransactionIds: string[] = []
  const variableWindowStart = shiftDays(today, -60)
  let variableTotal = 0
  const historicalExpenses: CashProjection['largestHistoricalExpenses'] = []
  const historyDelta = new Map<string, number>()
  const historyStart = shiftDays(today, -daysBack)

  for (const transaction of snapshot.transactions) {
    if (transaction.status !== 'confirmed') continue
    const inOperatingAccount =
      transaction.accountId !== null && accountIds.has(transaction.accountId)
    const inBrlCard =
      transaction.creditCardId !== null && cardIds.has(transaction.creditCardId)
    if (!inOperatingAccount && !inBrlCard) continue
    if (transaction.postedAt > today) continue
    if (inOperatingAccount && transaction.postedAt >= historyStart) {
      historyDelta.set(
        transaction.postedAt,
        (historyDelta.get(transaction.postedAt) ?? 0) + transaction.amountCents,
      )
    }
    if (
      transaction.amountCents < 0 &&
      transaction.postedAt >= variableWindowStart &&
      !excluded.has(transaction.id) &&
      !matched.has(transaction.id) &&
      !installmentIds.has(transaction.id) &&
      !ALLOCATION_BUCKETS.has(transaction.category?.bucket ?? '') &&
      !transaction.counterpartyAccountId &&
      (transaction.category?.bucket !== 'excluded' ||
        transaction.category.id === 'uncategorized')
    ) {
      const patterns = knowledgeExactPatterns(transaction.description)
      const covered = recurringEstimates.filter(
        ({ recurrence, patterns: approved }) =>
          recurrence.currency === transaction.currency &&
          patterns.some(
            (pattern) => pattern.length > 2 && approved.has(pattern),
          ) &&
          (recurrence.amountMode === 'variable' ||
            Math.abs(
              Math.abs(transaction.amountCents) - recurrence.amountCents,
            ) <=
              Math.round(
                (recurrence.amountCents * recurrence.amountToleranceBps) /
                  10_000,
              )),
      )
      // Só uma recorrência compatível pode substituir a média; não confirma pagamento.
      if (covered.length === 1)
        recurringEstimateTransactionIds.push(transaction.id)
      else {
        variableTotal += -transaction.amountCents
        historicalExpenses.push({
          id: transaction.id,
          date: transaction.postedAt,
          description: transaction.description,
          cents: -transaction.amountCents,
        })
      }
    }
  }
  const dailyVariableCents = Math.round(variableTotal / 60)

  const assumptions = {
    days: daysAhead,
    startingCents: startBalance,
    estimatedIncomeCents: 0,
    estimatedRecurrenceCents: 0,
    closedCardCents: 0,
    scheduledCardCents: 0,
    estimatedCardCents: 0,
    historicalEstimateCents: dailyVariableCents * daysAhead,
  }
  const horizon = shiftDays(today, daysAhead)
  const futureDelta = new Map<string, number>()
  const addFuture = (date: string, cents: number) => {
    futureDelta.set(date, (futureDelta.get(date) ?? 0) + cents)
  }
  for (const recurrence of snapshot.recurrences) {
    if (!recurrence.active || recurrence.creditCardId) continue
    for (const occurrence of forecastOccurrences(recurrence, horizon)) {
      if (
        occurrence.status !== 'expected' ||
        occurrence.expectedDate <= today ||
        occurrence.expectedDate > horizon
      ) {
        continue
      }
      const cents =
        occurrence.currency === 'BRL'
          ? occurrence.expectedAmountCents
          : recurrence.baseAmountCents
      if (cents === null) continue
      if (occurrence.direction === 'income')
        assumptions.estimatedIncomeCents += cents
      else assumptions.estimatedRecurrenceCents += cents
      addFuture(
        occurrence.expectedDate,
        occurrence.direction === 'income' ? cents : -cents,
      )
    }
  }
  for (const card of snapshot.cards) {
    // Faturas em moeda estrangeira não têm conversão no snapshot: ficam fora
    // em vez de entrar como se fossem reais.
    if (!isFamilyScope(card.scope) || card.currency !== 'BRL') continue
    for (const statement of card.upcomingStatements) {
      if (statement.dueDate <= today || statement.dueDate > horizon) continue
      if (statement.certainty === 'closed')
        assumptions.closedCardCents += Math.abs(statement.amountCents)
      else if (statement.certainty === 'installment_schedule')
        assumptions.scheduledCardCents += Math.abs(statement.amountCents)
      else assumptions.estimatedCardCents += Math.abs(statement.amountCents)
      addFuture(statement.dueDate, -Math.abs(statement.amountCents))
    }
  }

  const history: Array<CashPoint> = []
  let balance = startBalance
  for (let i = 0; i <= daysBack; i++) {
    const date = shiftDays(today, -i)
    history.push({ date, balanceCents: balance })
    balance -= historyDelta.get(date) ?? 0
  }
  history.reverse()
  const points = [...history]
  const todayIndex = points.length - 1

  balance = startBalance
  for (let i = 1; i <= daysAhead; i++) {
    const date = shiftDays(today, i)
    balance += (futureDelta.get(date) ?? 0) - dailyVariableCents
    const spread = Math.round(dailyVariableCents * i * 0.25)
    points.push({
      date,
      balanceCents: balance,
      lowCents: balance - spread,
      highCents: balance + spread,
    })
  }

  const future = points.slice(todayIndex + 1)
  const lowPoint = future.length
    ? future.reduce((min, p) => (p.balanceCents < min.balanceCents ? p : min))
    : null
  return {
    points,
    todayIndex,
    lowPoint,
    in30Cents:
      points[Math.min(todayIndex + 30, points.length - 1)].balanceCents,
    dailyVariableCents,
    recurringEstimateTransactionIds,
    assumptions,
    largestHistoricalExpenses: historicalExpenses
      .sort((a, b) => b.cents - a.cents)
      .slice(0, 5),
  }
}

// ─── Compromissos ────────────────────────────────────────────────────────────

export interface Commitment {
  id: string
  date: string
  name: string
  amountCents: number
  kind: 'income' | 'expense' | 'statement'
}

export function upcomingCommitments(
  snapshot: FinanceSnapshot,
  daysAhead = 30,
  today = todayIso(),
): Array<Commitment> {
  const horizon = shiftDays(today, daysAhead)
  const events: Array<Commitment> = []

  for (const recurrence of snapshot.recurrences) {
    // Recorrências no cartão são pagas pela fatura, que já entra abaixo.
    if (!recurrence.active || recurrence.creditCardId) continue
    for (const occurrence of forecastOccurrences(recurrence, horizon)) {
      if (
        occurrence.status !== 'expected' ||
        occurrence.expectedDate <= today ||
        occurrence.expectedDate > horizon
      ) {
        continue
      }
      const cents =
        occurrence.currency === 'BRL'
          ? occurrence.expectedAmountCents
          : recurrence.baseAmountCents
      if (cents === null) continue
      events.push({
        id: occurrence.id,
        date: occurrence.expectedDate,
        name: recurrence.name,
        amountCents: occurrence.direction === 'income' ? cents : -cents,
        kind: occurrence.direction === 'income' ? 'income' : 'expense',
      })
    }
  }
  for (const card of snapshot.cards) {
    if (!isFamilyScope(card.scope) || card.currency !== 'BRL') continue
    for (const statement of card.upcomingStatements) {
      if (statement.dueDate <= today || statement.dueDate > horizon) continue
      if (statement.amountCents === 0) continue
      events.push({
        id: `${card.id}-${statement.dueDate}`,
        date: statement.dueDate,
        name: `${statement.certainty === 'installment_schedule' ? 'Parcelas conhecidas' : 'Fatura'} ${card.name}`,
        amountCents: -Math.abs(statement.amountCents),
        kind: 'statement',
      })
    }
  }
  return events.sort((a, b) => a.date.localeCompare(b.date))
}

// ─── Visão consolidada do painel ─────────────────────────────────────────────

export interface HomeView {
  transactions: Array<FamilyTransaction>
  last30: PeriodTotals
  previous30: PeriodTotals
  accountInflows30: ReturnType<typeof accountInflowsByCurrency>
  last14: PeriodTotals
  previous14: PeriodTotals
  categories30: CategoryBreakdown
  categories14: CategoryBreakdown
  merchants30: Array<MerchantShare>
  cash: CashProjection
  cashTodayCents: number
  commitments30: Array<Commitment>
  netWorthCents: number
  reserve: DashboardSnapshot['reserve']
  /** Meses de gasto cobertos por caixa + reserva. */
  runwayMonths: number | null
  /** Data do lançamento mais recente da família (ou null sem dados). */
  latestPostedAt: string | null
  integrity: DashboardSnapshot['integrity']
  comparisonReady: { fortnight: boolean; month: boolean; categories: boolean }
}

export function buildHomeView(
  snapshot: FinanceSnapshot,
  today = todayIso(),
): HomeView {
  const transactions = familyTransactions(snapshot)
  const p30 = trailingPeriod(30, 0, today)
  const p30prev = trailingPeriod(30, 30, today)
  const p14 = trailingPeriod(14, 0, today)
  const p14prev = trailingPeriod(14, 14, today)
  const last30 = periodTotals(transactions, p30)
  const previous30 = periodTotals(transactions, p30prev)
  const cash = projectCash(snapshot, 90, 60, today)
  const cashTodayCents = operatingCashCents(snapshot)
  const reference90 = periodTotals(transactions, trailingPeriod(90, 0, today))
  const sources = [...snapshot.accounts, ...snapshot.cards].filter(
    (source) =>
      source.active && source.currency === 'BRL' && isFamilyScope(source.scope),
  )
  const canCompare = (days: number) => {
    const period = trailingPeriod(days, 0, today)
    return (
      !snapshot.dashboard.integrity.partial &&
      sources.length > 0 &&
      sources.every((source) =>
        source.coverage.intervals.some(
          (interval) =>
            interval.start <= period.start && interval.end >= period.end,
        ),
      )
    )
  }
  const monthlyBurn =
    (reference90.spendingCents + reference90.uncategorizedCents) / 3
  const runwayMonths =
    monthlyBurn > 0
      ? (cashTodayCents + snapshot.dashboard.reserve.currentCents) / monthlyBurn
      : null

  return {
    transactions,
    last30,
    previous30,
    accountInflows30: accountInflowsByCurrency(snapshot, p30),
    last14: periodTotals(transactions, p14),
    previous14: periodTotals(transactions, p14prev),
    categories30: categoryBreakdown(transactions, p30),
    categories14: categoryBreakdown(transactions, p14, 84, 20),
    merchants30: topMerchants(transactions, p30),
    cash,
    cashTodayCents,
    commitments30: upcomingCommitments(snapshot, 30, today),
    netWorthCents: snapshot.dashboard.netWorthCents,
    reserve: snapshot.dashboard.reserve,
    integrity: snapshot.dashboard.integrity,
    comparisonReady: {
      fortnight: canCompare(28),
      month: canCompare(60),
      categories: canCompare(120),
    },
    runwayMonths,
    latestPostedAt: transactions.reduce<string | null>(
      (latest, transaction) =>
        latest === null || transaction.postedAt > latest
          ? transaction.postedAt
          : latest,
      null,
    ),
  }
}

// ─── Insights determinísticos (feed do assistente) ───────────────────────────

export interface Insight {
  id: string
  tone: 'alert' | 'warn' | 'good' | 'neutral'
  title: string
  body: string
  to?: '/transacoes' | '/planejamento' | '/configuracoes' | '/importar'
  search?: { tab: 'contas' | 'cartoes' }
  cta?: string
}

const integrityLabels: Record<string, string> = {
  uncategorized_confirmed: 'transações confirmadas sem categoria',
  pending_transaction: 'transações pendentes',
  missing_base_conversion: 'valores sem conversão para BRL',
  missing_balance_conversion: 'saldos sem conversão para BRL',
  review_import: 'importações em revisão',
  suggested_reconciliation: 'conciliações para revisar',
  overdue_recurrence: 'recorrências atrasadas',
  recurrence_category_conflict: 'conflitos de categoria em recorrências',
  unverified_balance: 'saldos sem verificação recente',
}

export function buildInsights(
  view: HomeView,
  formatCents: (cents: number) => string,
  today = todayIso(),
): Array<Insight> {
  const insights: Array<Insight> = []
  const pct = (ratio: number) =>
    `${ratio > 0 ? '+' : ''}${Math.round(ratio * 100)}%`

  // 0. Extratos desatualizados: sem dados recentes, o resto perde valor.
  if (view.latestPostedAt) {
    const staleDays = daysBetween(view.latestPostedAt, today, {
      inclusive: false,
    })
    if (staleDays >= 5) {
      insights.push({
        id: 'stale-data',
        tone: 'warn',
        title: `Extratos parados há ${staleDays} dias`,
        body: `O lançamento mais recente é de ${formatShortDate(view.latestPostedAt)}. Importe os extratos novos para atualizar a análise.`,
        to: '/importar',
        cta: 'Importar',
      })
    }
  }

  // 0b. Pendências que deixam os números parciais.
  if (view.integrity.partial && view.integrity.issues.length > 0) {
    const detail = view.integrity.issues
      .map((issue) => `${issue.count} ${integrityLabels[issue.code]}`)
      .join(' · ')
    insights.push({
      id: 'integrity',
      tone: 'warn',
      title: `${view.integrity.totalCount} pendências deixam os números parciais`,
      body: `${detail}.`,
      to: '/transacoes',
      cta: 'Revisar',
    })
  }

  // 1. Quinzena atual vs anterior
  if (view.last14.spendingCents > 0 || view.previous14.spendingCents > 0) {
    const delta = view.last14.spendingCents - view.previous14.spendingCents
    const ratio =
      view.comparisonReady.fortnight && view.previous14.spendingCents > 0
        ? delta / view.previous14.spendingCents
        : null
    const biggest = [...view.categories14.items]
      .filter((item) => !item.folded)
      .sort((a, b) => Math.abs(b.deltaCents) - Math.abs(a.deltaCents))
      .at(0)
    insights.push({
      id: 'fortnight',
      tone:
        ratio !== null && ratio > 0.15
          ? 'warn'
          : ratio !== null && ratio < -0.1
            ? 'good'
            : 'neutral',
      title:
        ratio === null
          ? `Gastos classificados na quinzena: ${formatCents(view.last14.spendingCents)}`
          : `Gastos da quinzena ${ratio >= 0 ? 'subiram' : 'caíram'} ${pct(Math.abs(ratio) * Math.sign(ratio))}`,
      body: !view.comparisonReady.fortnight
        ? 'Cobertura ou classificação parcial. Os valores importados não comprovam aumento ou queda do consumo.'
        : `${formatCents(view.last14.spendingCents)} nos últimos 14 dias contra ${formatCents(view.previous14.spendingCents)} na quinzena anterior.${
            biggest && biggest.deltaCents !== 0
              ? ` Maior variação: ${biggest.name} (${biggest.deltaCents > 0 ? '+' : '−'}${formatCents(Math.abs(biggest.deltaCents))}).`
              : ''
          }`,
      to: '/transacoes',
      cta: 'Ver lançamentos',
    })
  }

  // 2. Categorias acima da média (vazamentos)
  const leaks = (view.comparisonReady.categories ? view.categories30.items : [])
    .filter(
      (item) =>
        !item.folded &&
        item.deltaRatio !== null &&
        item.deltaRatio >= 0.2 &&
        item.deltaCents >= 15_000,
    )
    .slice(0, 2)
  for (const leak of leaks) {
    insights.push({
      id: `leak-${leak.id}`,
      tone: 'alert',
      title: `${leak.name} ${pct(leak.deltaRatio ?? 0)} acima da média`,
      body: `${formatCents(leak.cents)} nos últimos 30 dias, contra uma média de ${formatCents(leak.referenceCents)} por mês nos 90 dias anteriores.`,
      to: '/transacoes',
      cta: 'Investigar',
    })
  }

  // 3. Assinaturas
  const subscriptions = view.categories30.items.find(
    (item) => item.id === 'subscriptions',
  )
  if (subscriptions && subscriptions.cents > 0) {
    insights.push({
      id: 'subscriptions',
      tone: 'neutral',
      title: `Assinaturas identificadas: ${formatCents(subscriptions.cents)} em 30 dias`,
      body: `${subscriptions.count} cobranças nos últimos 30 dias.`,
      to: '/transacoes',
      cta: 'Revisar',
    })
  }

  // 4. Maiores destinos
  if (view.merchants30.length >= 3 && view.last30.spendingCents > 0) {
    const top = view.merchants30.slice(0, 3)
    const cents = top.reduce((sum, item) => sum + item.cents, 0)
    insights.push({
      id: 'merchants',
      tone: 'neutral',
      title: 'Onde mais foi o dinheiro',
      body: `${top.map((item) => shortName(item.name)).join(', ')} concentram ${formatCents(cents)} (${Math.round((cents / view.last30.spendingCents) * 100)}% dos gastos classificados dos últimos 30 dias).`,
    })
  }

  // 5. Compromissos dos próximos 14 dias vs caixa
  const in14 = shiftDays(today, 14)
  const due = view.commitments30.filter(
    (item) => item.date <= in14 && item.amountCents < 0,
  )
  const dueCents = due.reduce((sum, item) => sum + -item.amountCents, 0)
  if (dueCents > 0) {
    const covered = view.cashTodayCents >= dueCents
    insights.push({
      id: 'commitments',
      tone: covered ? 'neutral' : 'alert',
      title: `${formatCents(dueCents)} comprometidos nos próximos 14 dias`,
      body: `${due.length} ${due.length === 1 ? 'vencimento' : 'vencimentos'} entre recorrências e faturas. Caixa disponível hoje: ${formatCents(view.cashTodayCents)}${covered ? '.' : ' — não cobre tudo.'}`,
      to: '/configuracoes',
      search: { tab: 'cartoes' },
      cta: 'Ver vencimentos',
    })
  }

  // 6. Projeção negativa
  if (view.cash.lowPoint && view.cash.lowPoint.balanceCents < 0) {
    insights.push({
      id: 'cash-negative',
      tone: 'alert',
      title: `Caixa projetado fica negativo em ${formatShortDate(view.cash.lowPoint.date)}`,
      body: `Mínimo neste cenário: ${formatCents(view.cash.lowPoint.balanceCents)}. Confira renda esperada e continuidade dos gastos históricos antes de decidir.`,
      to: '/planejamento',
      cta: 'Planejar',
    })
  }

  // 7. Sem categoria
  if (view.last30.uncategorizedCents > 0) {
    insights.push({
      id: 'uncategorized',
      tone: 'warn',
      title: `${formatCents(view.last30.uncategorizedCents)} sem categoria`,
      body: `${view.last30.uncategorizedCount} lançamentos dos últimos 30 dias ficam fora dos totais por categoria, mas suas saídas continuam consideradas no caixa.`,
      to: '/transacoes',
      cta: 'Classificar',
    })
  }

  // 8. Reserva
  if (view.reserve.targetCents > 0) {
    const ratio = view.reserve.currentCents / view.reserve.targetCents
    insights.push({
      id: 'reserve',
      tone: view.reserve.complete ? 'good' : 'neutral',
      title: view.reserve.complete
        ? 'Reserva de emergência completa'
        : `Reserva em ${Math.round(ratio * 100)}% da meta`,
      body: `${formatCents(view.reserve.currentCents)} de ${formatCents(view.reserve.targetCents)} (${view.reserve.months} meses de gastos).`,
      to: '/planejamento',
      cta: 'Ver plano',
    })
  }

  return insights.slice(0, 7)
}

function shortName(value: string, max = 28) {
  const clean = value.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean
}

// ─── Briefing para a análise com IA ──────────────────────────────────────────

const reais = (cents: number) => Math.round(cents) / 100

/** Resumo compacto e numérico do momento financeiro, para o modelo analisar. */
export function buildAnalysisBrief(
  snapshot: FinanceSnapshot,
  today = todayIso(),
) {
  const view = buildHomeView(snapshot, today)
  const totals = (t: PeriodTotals) => ({
    periodo: `${t.period.start} a ${t.period.end}`,
    receitas: reais(t.incomeCents),
    gastos: reais(t.spendingCents),
    aportes: reais(t.allocationCents),
    semCategoria: reais(t.uncategorizedCents),
  })
  return {
    hoje: today,
    moeda: 'BRL',
    quinzenaAtual: totals(view.last14),
    quinzenaAnterior: totals(view.previous14),
    ultimos30Dias: totals(view.last30),
    trintaDiasAnteriores: totals(view.previous30),
    gastosPorCategoria30Dias: view.categories30.items.map((item) => ({
      categoria: item.name,
      gasto: reais(item.cents),
      lancamentos: item.count,
      mediaMensal90Dias: reais(item.referenceCents),
      variacao: item.deltaRatio,
    })),
    gastosPorCategoriaQuinzena: view.categories14.items
      .filter((item) => item.cents > 0 || item.referenceCents > 0)
      .map((item) => ({
        categoria: item.name,
        gasto: reais(item.cents),
        mediaQuinzena: reais(item.referenceCents),
      })),
    maioresDestinos30Dias: view.merchants30.map((item) => ({
      descricao: item.name,
      categoria: item.categoryName,
      total: reais(item.cents),
      vezes: item.count,
    })),
    caixa: {
      disponivelHoje: reais(view.cashTodayCents),
      projetadoEm30Dias: reais(view.cash.in30Cents),
      minimoProjetado: view.cash.lowPoint
        ? {
            data: view.cash.lowPoint.date,
            valor: reais(view.cash.lowPoint.balanceCents),
          }
        : null,
      gastoVariavelDiarioMedio: reais(view.cash.dailyVariableCents),
      folegoMeses: view.runwayMonths
        ? Math.round(view.runwayMonths * 10) / 10
        : null,
    },
    patrimonioLiquido: reais(view.netWorthCents),
    reserva: {
      atual: reais(view.reserve.currentCents),
      meta: reais(view.reserve.targetCents),
      mesesDeGasto: view.reserve.months,
      completa: view.reserve.complete,
    },
    compromissosProximos30Dias: view.commitments30.map((item) => ({
      data: item.date,
      nome: item.name,
      valor: reais(item.amountCents),
      tipo: item.kind,
    })),
    recorrenciasAtivas: snapshot.recurrences.flatMap((recurrence) => {
      if (!recurrence.active || recurrence.baseAmountCents === null) return []
      return [
        {
          nome: recurrence.name,
          direcao: recurrence.direction,
          valorMensal: reais(
            recurrence.baseAmountCents /
              (recurrence.frequency === 'yearly' ? 12 : 1),
          ),
          frequencia: recurrence.frequency,
        },
      ]
    }),
    metas: snapshot.goals.map((goal) => ({
      nome: goal.name,
      atual: reais(goal.currentCents),
      alvo: reais(goal.targetCents),
    })),
  }
}

export type AnalysisBrief = ReturnType<typeof buildAnalysisBrief>
