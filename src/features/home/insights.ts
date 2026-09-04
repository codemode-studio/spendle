/**
 * Derivações do painel sobre o snapshot financeiro real.
 * Tudo aqui é cálculo puro (roda no cliente e no servidor) — nenhum dado fictício.
 */
import type { getFinanceSnapshotFn } from '#/features/finance/finance.functions'

export type FinanceSnapshot = Awaited<ReturnType<typeof getFinanceSnapshotFn>>

type Scope = FinanceSnapshot['scopes'][number]

const COMPANY_SCOPES = new Set(['company_br', 'company_us'])
const SPENDING_BUCKETS = new Set(['essential', 'lifestyle', 'tax'])
const ALLOCATION_BUCKETS = new Set(['investment', 'reserve'])
const OTHER_COLOR = '#94a3b8'

function isFamilyScope(scope: Scope | null | undefined) {
  return !scope || !COMPANY_SCOPES.has(scope.type)
}

export function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

export function shiftDays(iso: string, days: number) {
  const date = new Date(`${iso}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

export interface Period {
  /** Inclusive, ISO date. */
  start: string
  /** Inclusive, ISO date. */
  end: string
}

/** Janela de `days` dias terminando `endOffset` dias antes de hoje. */
export function trailingPeriod(days: number, endOffset = 0): Period {
  const today = todayIso()
  const end = shiftDays(today, -endOffset)
  return { start: shiftDays(end, -(days - 1)), end }
}

function inPeriod(date: string, period: Period) {
  return date >= period.start && date <= period.end
}

// ─── Transações da família ───────────────────────────────────────────────────

export interface FamilyTransaction {
  id: string
  postedAt: string
  description: string
  normalized: string
  /** Valor em BRL (base), assinado. */
  amountCents: number
  categoryId: string | null
  categoryName: string
  color: string
  bucket: string | null
  source: 'account' | 'card'
  uncategorized: boolean
}

/** IDs de transações que são transferências internas / pagamento de fatura confirmados. */
function internalTransferIds(snapshot: FinanceSnapshot) {
  const ids = new Set<string>()
  for (const group of snapshot.reconciliations) {
    if (group.status !== 'confirmed') continue
    if (!['transfer', 'fx_transfer', 'card_payment'].includes(group.type)) {
      continue
    }
    for (const link of group.links) ids.add(link.transactionId)
  }
  return ids
}

/** IDs de transações já casadas com recorrências. */
function recurrenceMatchedIds(snapshot: FinanceSnapshot) {
  const ids = new Set<string>()
  for (const recurrence of snapshot.recurrences) {
    for (const occurrence of recurrence.occurrences) {
      for (const match of occurrence.matches) {
        if (match.status === 'confirmed' || match.status === 'auto_confirmed') {
          ids.add(match.transactionId)
        }
      }
    }
  }
  return ids
}

/**
 * Lançamentos confirmados da família, em BRL, sem transferências internas,
 * pagamentos de fatura e movimentos da empresa.
 */
export function familyTransactions(
  snapshot: FinanceSnapshot,
): Array<FamilyTransaction> {
  const excluded = internalTransferIds(snapshot)
  const scopeById = new Map(snapshot.scopes.map((scope) => [scope.id, scope]))
  const result: Array<FamilyTransaction> = []

  for (const transaction of snapshot.transactions) {
    if (transaction.status !== 'confirmed') continue
    if (excluded.has(transaction.id)) continue
    if (transaction.counterpartyAccountId) continue
    const scopeId =
      transaction.account?.ownershipScopeId ??
      transaction.creditCard?.ownershipScopeId
    if (scopeId && !isFamilyScope(scopeById.get(scopeId))) continue
    const category = transaction.category
    const bucket = category?.bucket ?? null
    if (bucket === 'business') continue
    const uncategorized = !category || category.id === 'uncategorized'
    if (bucket === 'excluded' && !uncategorized) continue
    const amount =
      transaction.baseAmountCents ??
      (transaction.currency === 'BRL' ? transaction.amountCents : null)
    if (amount === null) continue
    result.push({
      id: transaction.id,
      postedAt: transaction.postedAt,
      description: transaction.description,
      normalized: transaction.normalizedDescription,
      amountCents: amount,
      categoryId: uncategorized ? null : category.id,
      categoryName: uncategorized ? 'Sem categoria' : category.name,
      color: uncategorized ? OTHER_COLOR : category.color,
      bucket: uncategorized ? null : bucket,
      source: transaction.creditCardId ? 'card' : 'account',
      uncategorized,
    })
  }
  return result
}

export function isSpending(transaction: FamilyTransaction) {
  return (
    transaction.amountCents < 0 &&
    !transaction.uncategorized &&
    transaction.bucket !== null &&
    SPENDING_BUCKETS.has(transaction.bucket)
  )
}

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
  const periodDays =
    Math.round(
      (Date.parse(`${period.end}T12:00:00Z`) -
        Date.parse(`${period.start}T12:00:00Z`)) /
        86_400_000,
    ) + 1
  const reference: Period = {
    start: shiftDays(period.start, -referenceDays),
    end: shiftDays(period.start, -1),
  }
  const scale = periodDays / referenceDays
  const current = new Map<
    string,
    { name: string; color: string; cents: number; count: number }
  >()
  const previous = new Map<string, number>()

  for (const transaction of transactions) {
    if (!isSpending(transaction)) continue
    const id = transaction.categoryId ?? 'uncategorized'
    if (inPeriod(transaction.postedAt, period)) {
      const entry = current.get(id) ?? {
        name: transaction.categoryName,
        color: transaction.color,
        cents: 0,
        count: 0,
      }
      entry.cents += -transaction.amountCents
      entry.count += 1
      current.set(id, entry)
    } else if (inPeriod(transaction.postedAt, reference)) {
      previous.set(id, (previous.get(id) ?? 0) + -transaction.amountCents)
    }
  }

  const totalCents = [...current.values()].reduce((sum, e) => sum + e.cents, 0)
  const referenceTotalCents = Math.round(
    [...previous.values()].reduce((sum, value) => sum + value, 0) * scale,
  )
  const ids = new Set([...current.keys(), ...previous.keys()])
  const all: Array<CategoryShare> = []
  for (const id of ids) {
    const entry = current.get(id)
    const referenceCents = Math.round((previous.get(id) ?? 0) * scale)
    const cents = entry?.cents ?? 0
    if (cents === 0 && referenceCents === 0) continue
    all.push({
      id,
      name: entry?.name ?? id,
      color: entry?.color ?? OTHER_COLOR,
      cents,
      count: entry?.count ?? 0,
      share: totalCents > 0 ? cents / totalCents : 0,
      referenceCents,
      deltaCents: cents - referenceCents,
      deltaRatio:
        referenceCents > 0 ? (cents - referenceCents) / referenceCents : null,
      folded: false,
    })
  }
  all.sort((a, b) => b.cents - a.cents)

  const visible = all.filter((item) => item.cents > 0)
  if (visible.length <= limit)
    return { totalCents, referenceTotalCents, items: visible }
  const head = visible.slice(0, limit - 1)
  const tail = visible.slice(limit - 1)
  const folded: CategoryShare = {
    id: 'other',
    name: `Outras (${tail.length})`,
    color: OTHER_COLOR,
    cents: tail.reduce((sum, item) => sum + item.cents, 0),
    count: tail.reduce((sum, item) => sum + item.count, 0),
    share: 0,
    referenceCents: tail.reduce((sum, item) => sum + item.referenceCents, 0),
    deltaCents: 0,
    deltaRatio: null,
    folded: true,
  }
  folded.share = totalCents > 0 ? folded.cents / totalCents : 0
  folded.deltaCents = folded.cents - folded.referenceCents
  folded.deltaRatio =
    folded.referenceCents > 0 ? folded.deltaCents / folded.referenceCents : null
  return { totalCents, referenceTotalCents, items: [...head, folded] }
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
): CashProjection {
  const today = todayIso()
  const accounts = familyOperatingAccounts(snapshot)
  const accountIds = new Set(accounts.map((account) => account.id))
  const startBalance = operatingCashCents(snapshot)
  const excluded = internalTransferIds(snapshot)
  const matched = recurrenceMatchedIds(snapshot)

  const variableWindowStart = shiftDays(today, -60)
  let variableTotal = 0
  const historyDelta = new Map<string, number>()
  const historyStart = shiftDays(today, -daysBack)

  for (const transaction of snapshot.transactions) {
    if (transaction.status !== 'confirmed') continue
    if (!transaction.accountId || !accountIds.has(transaction.accountId)) {
      continue
    }
    if (transaction.postedAt > today) continue
    if (transaction.postedAt >= historyStart) {
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
      !transaction.counterpartyAccountId &&
      transaction.category?.bucket !== 'excluded'
    ) {
      variableTotal += -transaction.amountCents
    }
  }
  const dailyVariableCents = Math.round(variableTotal / 60)

  const horizon = shiftDays(today, daysAhead)
  const futureDelta = new Map<string, number>()
  const addFuture = (date: string, cents: number) => {
    futureDelta.set(date, (futureDelta.get(date) ?? 0) + cents)
  }
  for (const recurrence of snapshot.recurrences) {
    if (!recurrence.active || recurrence.creditCardId) continue
    for (const occurrence of recurrence.occurrences) {
      if (occurrence.status !== 'expected') continue
      if (occurrence.expectedDate <= today || occurrence.expectedDate > horizon)
        continue
      const cents =
        occurrence.currency === 'BRL'
          ? occurrence.expectedAmountCents
          : recurrence.baseAmountCents
      if (cents === null) continue
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
): Array<Commitment> {
  const today = todayIso()
  const horizon = shiftDays(today, daysAhead)
  const events: Array<Commitment> = []

  for (const recurrence of snapshot.recurrences) {
    // Recorrências no cartão são pagas pela fatura, que já entra abaixo.
    if (!recurrence.active || recurrence.creditCardId) continue
    for (const occurrence of recurrence.occurrences) {
      if (occurrence.status !== 'expected') continue
      if (occurrence.expectedDate <= today || occurrence.expectedDate > horizon)
        continue
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
        name: `Fatura ${card.name}`,
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
  last14: PeriodTotals
  previous14: PeriodTotals
  categories30: CategoryBreakdown
  categories14: CategoryBreakdown
  merchants30: Array<MerchantShare>
  cash: CashProjection
  cashTodayCents: number
  commitments30: Array<Commitment>
  netWorthCents: number
  reserve: FinanceSnapshot['dashboard']['reserve']
  /** Meses de gasto cobertos por caixa + reserva. */
  runwayMonths: number | null
  /** Data do lançamento mais recente da família (ou null sem dados). */
  latestPostedAt: string | null
  integrity: FinanceSnapshot['dashboard']['integrity']
}

export function buildHomeView(snapshot: FinanceSnapshot): HomeView {
  const transactions = familyTransactions(snapshot)
  const p30 = trailingPeriod(30)
  const p30prev = trailingPeriod(30, 30)
  const p14 = trailingPeriod(14)
  const p14prev = trailingPeriod(14, 14)
  const last30 = periodTotals(transactions, p30)
  const previous30 = periodTotals(transactions, p30prev)
  const cash = projectCash(snapshot)
  const cashTodayCents = operatingCashCents(snapshot)
  const reference90 = periodTotals(transactions, trailingPeriod(90))
  const monthlyBurn = reference90.spendingCents / 3
  const runwayMonths =
    monthlyBurn > 0
      ? (cashTodayCents + snapshot.dashboard.reserve.currentCents) / monthlyBurn
      : null

  return {
    transactions,
    last30,
    previous30,
    last14: periodTotals(transactions, p14),
    previous14: periodTotals(transactions, p14prev),
    categories30: categoryBreakdown(transactions, p30),
    categories14: categoryBreakdown(transactions, p14, 84, 20),
    merchants30: topMerchants(transactions, p30),
    cash,
    cashTodayCents,
    commitments30: upcomingCommitments(snapshot, 30),
    netWorthCents: snapshot.dashboard.netWorthCents,
    reserve: snapshot.dashboard.reserve,
    integrity: snapshot.dashboard.integrity,
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
): Array<Insight> {
  const insights: Array<Insight> = []
  const pct = (ratio: number) =>
    `${ratio > 0 ? '+' : ''}${Math.round(ratio * 100)}%`

  // 0. Extratos desatualizados: sem dados recentes, o resto perde valor.
  if (view.latestPostedAt) {
    const staleDays = Math.round(
      (Date.parse(`${todayIso()}T12:00:00Z`) -
        Date.parse(`${view.latestPostedAt}T12:00:00Z`)) /
        86_400_000,
    )
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
      view.previous14.spendingCents > 0
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
          ? `Gastos da quinzena: ${formatCents(view.last14.spendingCents)}`
          : `Gastos da quinzena ${ratio >= 0 ? 'subiram' : 'caíram'} ${pct(Math.abs(ratio) * Math.sign(ratio))}`,
      body: `${formatCents(view.last14.spendingCents)} nos últimos 14 dias contra ${formatCents(view.previous14.spendingCents)} na quinzena anterior.${
        biggest && biggest.deltaCents !== 0
          ? ` Maior variação: ${biggest.name} (${biggest.deltaCents > 0 ? '+' : '−'}${formatCents(Math.abs(biggest.deltaCents))}).`
          : ''
      }`,
      to: '/transacoes',
      cta: 'Ver lançamentos',
    })
  }

  // 2. Categorias acima da média (vazamentos)
  const leaks = view.categories30.items
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
      title: `Assinaturas somam ${formatCents(subscriptions.cents)} por mês`,
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
      body: `${top.map((item) => shortName(item.name)).join(', ')} concentram ${formatCents(cents)} (${Math.round((cents / view.last30.spendingCents) * 100)}% dos gastos dos últimos 30 dias).`,
    })
  }

  // 5. Compromissos dos próximos 14 dias vs caixa
  const today = todayIso()
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
      body: `Mínimo previsto de ${formatCents(view.cash.lowPoint.balanceCents)}. Antecipe receitas ou reordene aportes.`,
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
      body: `${view.last30.uncategorizedCount} lançamentos dos últimos 30 dias ficam fora da análise até serem classificados.`,
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

export function formatShortDate(iso: string) {
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: 'short',
    timeZone: 'UTC',
  })
    .format(new Date(`${iso}T12:00:00Z`))
    .replace('.', '')
}

// ─── Briefing para a análise com IA ──────────────────────────────────────────

const reais = (cents: number) => Math.round(cents) / 100

/** Resumo compacto e numérico do momento financeiro, para o modelo analisar. */
export function buildAnalysisBrief(snapshot: FinanceSnapshot) {
  const view = buildHomeView(snapshot)
  const totals = (t: PeriodTotals) => ({
    periodo: `${t.period.start} a ${t.period.end}`,
    receitas: reais(t.incomeCents),
    gastos: reais(t.spendingCents),
    aportes: reais(t.allocationCents),
    semCategoria: reais(t.uncategorizedCents),
  })
  return {
    hoje: todayIso(),
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
