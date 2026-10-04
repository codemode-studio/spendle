import { convertMinorUnitsAtRate } from './currency'
import { addMonths } from './credit-card'
import { knowledgeExactPatterns } from './knowledge-pattern'
import { daysBetween, shiftDays } from './period'
import { isFamilyScope, isInternalTransferType } from './ledger'
import type { OwnershipScopeType } from './ledger'
import {
  isAcceptedRecurrenceMatchStatus,
  pendingTransactionCoversRecurrence,
} from './recurrence-book'
import type { RecurrenceProjectionRule } from './recurrence-book'
import { addRecurrencePeriod } from './recurrence-schedule'
import type { RecurrenceFrequency } from './recurrence-schedule'

type CashTransaction = {
  id: string
  postedAt: string
  amountCents: number
  baseAmountCents: number | null
  baseCurrency: string
  currency: string
  description: string
  status: 'pending' | 'confirmed' | 'excluded'
  accountId: string | null
  creditCardId: string | null
  counterpartyAccountId: string | null
  categoryId: string | null
  account: { ownershipScopeId: string } | null
  creditCard: { ownershipScopeId: string } | null
}

type CashRecurrence = Omit<
  RecurrenceProjectionRule,
  'expectedDate' | 'expectedAmountCents'
> & {
  id: string
  name: string
  categoryId: string | null
  active: boolean
  amountCents: number
  nextDate: string
  frequency: RecurrenceFrequency
  scheduleAnchor: string
}

type CashOccurrence = {
  id: string
  recurrenceId: string
  expectedDate: string
  expectedAmountCents: number
  currency: string
  direction: 'income' | 'expense'
  categoryId: string
  status: string
}

interface MonthlyCashFlowFacts {
  accounts: ReadonlyArray<{
    id: string
    active: boolean
    purpose: string
    currency: string
    initialBalanceCents: number
    statementBalanceAt: string | null
    statementBalanceCents: number | null
  }>
  transactions: ReadonlyArray<CashTransaction>
  scopes: ReadonlyArray<{ id: string; type: OwnershipScopeType }>
  recurrences: ReadonlyArray<CashRecurrence>
  occurrences: ReadonlyArray<CashOccurrence>
  checkpoints: ReadonlyArray<{
    accountId: string | null
    reviewState: string
    asOf: string
    balanceCents: number
  }>
  exchangeRates: ReadonlyArray<{
    date: string
    fromCurrency: string
    toCurrency: string
    rateMicros: number
  }>
  baseCurrency: string
  reconciliations: ReadonlyArray<{
    type: string
    status: string
    transactionIds: string[]
  }>
}

type MonthCommitments = {
  forecasting: boolean
  lines: ReadonlyArray<{ cents: number; paidCents: number }>
  savingsRemainingCents: number
}

/** Uma pendência cobre no máximo uma ocorrência, pela ordem de vencimento. */
export function pendingRecurrencePayments(
  input: Pick<
    MonthlyCashFlowFacts,
    'transactions' | 'scopes' | 'recurrences' | 'occurrences'
  > & { month: string },
) {
  const {
    transactions,
    recurrences: recurrenceRows,
    occurrences: recurrenceOccurrenceRows,
  } = input
  const currentMonth = input.month
  const scopeById = new Map(input.scopes.map((scope) => [scope.id, scope]))
  const recurrenceById = new Map(recurrenceRows.map((row) => [row.id, row]))
  const projectedPendingTransactionIds = new Set<string>()
  const projectedPendingByOccurrenceId = new Map<string, CashTransaction>()
  const pendingFamilyTransactions = transactions.filter((transaction) => {
    const ownershipScopeId =
      transaction.account?.ownershipScopeId ??
      transaction.creditCard?.ownershipScopeId
    const scopeType = ownershipScopeId
      ? scopeById.get(ownershipScopeId)?.type
      : null
    return transaction.status === 'pending' && isFamilyScope(scopeType)
  })
  for (const occurrence of recurrenceOccurrenceRows
    .filter(
      (item) =>
        item.status === 'expected' &&
        item.expectedDate.startsWith(currentMonth),
    )
    .sort((left, right) =>
      left.expectedDate.localeCompare(right.expectedDate),
    )) {
    const recurrence = recurrenceById.get(occurrence.recurrenceId)
    if (!recurrence?.active) continue
    const pendingMatch = pendingFamilyTransactions.find(
      (transaction) =>
        !projectedPendingTransactionIds.has(transaction.id) &&
        pendingTransactionCoversRecurrence({
          recurrenceName: recurrence.name,
          categoryId: occurrence.categoryId,
          rule: {
            expectedDate: occurrence.expectedDate,
            expectedAmountCents: occurrence.expectedAmountCents,
            currency: occurrence.currency,
            direction: occurrence.direction,
            amountMode: recurrence.amountMode,
            destinationMode: recurrence.destinationMode,
            accountId: recurrence.accountId,
            creditCardId: recurrence.creditCardId,
            dateToleranceDays: recurrence.dateToleranceDays,
            amountToleranceBps: recurrence.amountToleranceBps,
          },
          transaction: {
            id: transaction.id,
            postedAt: transaction.postedAt,
            amountCents: transaction.amountCents,
            currency: transaction.currency,
            description: transaction.description,
            status: transaction.status,
            accountId: transaction.accountId,
            creditCardId: transaction.creditCardId,
            categoryId: transaction.categoryId,
          },
        }),
    )
    if (pendingMatch) {
      projectedPendingTransactionIds.add(pendingMatch.id)
      projectedPendingByOccurrenceId.set(occurrence.id, pendingMatch)
    }
  }
  return projectedPendingByOccurrenceId
}

/**
 * Caixa operacional: contas ativas de finalidade operacional, saldo reconstruído
 * por checkpoints e movimentos postados, convertido para a moeda-base. É a única
 * definição de caixa usada pela Home, pelo resumo mensal e pela projeção.
 */
function createCashPosition(
  input: MonthlyCashFlowFacts & { referenceDate: string },
) {
  const { accounts, transactions, checkpoints: checkpointRows } = input
  const settings = { baseCurrency: input.baseCurrency }
  // A leitura não precisa conhecer a ordem das cotações.
  const exchangeRateRows = [...input.exchangeRates].sort((a, b) =>
    b.date.localeCompare(a.date),
  )
  const amountInBaseCurrency = (transaction: CashTransaction) => {
    if (transaction.currency === input.baseCurrency)
      return transaction.amountCents
    return transaction.baseCurrency === input.baseCurrency &&
      transaction.baseAmountCents !== null
      ? transaction.baseAmountCents
      : null
  }
  const convertToBaseCurrency = (value: number, currency: string) => {
    if (currency === settings.baseCurrency) return value
    const directRate = exchangeRateRows.find(
      (rate) =>
        rate.fromCurrency === currency &&
        rate.toCurrency === settings.baseCurrency,
    )
    if (directRate) {
      return convertMinorUnitsAtRate(
        value,
        currency,
        settings.baseCurrency,
        directRate.rateMicros,
      )
    }
    const inverseRate = exchangeRateRows.find(
      (rate) =>
        rate.fromCurrency === settings.baseCurrency &&
        rate.toCurrency === currency,
    )
    return inverseRate
      ? convertMinorUnitsAtRate(
          value,
          currency,
          settings.baseCurrency,
          Math.round(1_000_000_000_000 / inverseRate.rateMicros),
        )
      : null
  }
  const cashAccounts = accounts.filter(
    (a) => a.active && a.purpose === 'operating',
  )
  const cashAccountIds = new Set(cashAccounts.map((a) => a.id))
  const cashMovements = transactions.filter(
    (t) =>
      t.accountId &&
      cashAccountIds.has(t.accountId) &&
      t.status === 'confirmed',
  )
  const convertCash = (cents: number, currency: string, date: string) => {
    if (cents === 0 || currency === settings.baseCurrency) return cents
    const rate = exchangeRateRows.find(
      (r) =>
        r.date <= date &&
        r.fromCurrency === currency &&
        r.toCurrency === settings.baseCurrency,
    )
    if (rate)
      return convertMinorUnitsAtRate(
        cents,
        currency,
        settings.baseCurrency,
        rate.rateMicros,
      )
    const inverse = exchangeRateRows.find(
      (r) =>
        r.date <= date &&
        r.toCurrency === currency &&
        r.fromCurrency === settings.baseCurrency,
    )
    return inverse
      ? convertMinorUnitsAtRate(
          cents,
          currency,
          settings.baseCurrency,
          Math.round(1_000_000_000_000 / inverse.rateMicros),
        )
      : null
  }
  const cashAt = (date: string): number | null => {
    let sum = 0
    for (const account of cashAccounts) {
      const anchors = checkpointRows
        .filter(
          (c) => c.accountId === account.id && c.reviewState !== 'invalidated',
        )
        .map((c) => ({ date: c.asOf, cents: c.balanceCents }))
      if (account.statementBalanceAt && account.statementBalanceCents !== null)
        anchors.push({
          date: account.statementBalanceAt,
          cents: account.statementBalanceCents,
        })
      const native =
        date === input.referenceDate
          ? (account.statementBalanceCents ?? account.initialBalanceCents) +
            cashMovements
              .filter(
                (t) =>
                  t.accountId === account.id &&
                  (!account.statementBalanceAt ||
                    t.postedAt > account.statementBalanceAt),
              )
              .reduce((movement, t) => movement + t.amountCents, 0)
          : recordedBalanceAt({
              date,
              initialCents: account.initialBalanceCents,
              anchors,
              movements: cashMovements
                .filter((t) => t.accountId === account.id)
                .map((t) => ({ date: t.postedAt, cents: t.amountCents })),
            })
      if (native === null) return null
      const converted = convertCash(native, account.currency, date)
      if (converted === null) return null
      sum += converted
    }
    return sum
  }
  return {
    cashAccounts,
    cashAccountIds,
    cashMovements,
    amountInBaseCurrency,
    convertToBaseCurrency,
    cashAt,
  }
}

/** Calcula caixa realizado e previsto a partir dos fatos, sem alterar o ledger. */
export function buildMonthlyCashFlow(
  input: MonthlyCashFlowFacts & {
    month: string
    referenceDate: string
    commitments: MonthCommitments
  },
) {
  const {
    transactions,
    recurrences: recurrenceRows,
    referenceDate,
    month: currentMonth,
    commitments: familyMonth,
    reconciliations: reconciliationsForSummary,
  } = input
  const {
    cashAccountIds,
    cashMovements,
    amountInBaseCurrency,
    convertToBaseCurrency,
    cashAt,
  } = createCashPosition(input)
  const transactionById = new Map(transactions.map((row) => [row.id, row]))
  const occurrencesByRecurrence = new Map<string, CashOccurrence[]>()
  for (const occurrence of input.occurrences) {
    const rows = occurrencesByRecurrence.get(occurrence.recurrenceId) ?? []
    rows.push(occurrence)
    occurrencesByRecurrence.set(occurrence.recurrenceId, rows)
  }
  const projectedPendingByOccurrenceId = pendingRecurrencePayments(input)

  const monthStart = currentMonth + '-01'
  const monthEnd = shiftDays(addMonths(monthStart, 1), -1)
  const cashDate = monthEnd < referenceDate ? monthEnd : referenceDate
  // Own transfers between operating accounts move money without changing consolidated cash.
  const ownCashTransferIds = new Set(
    reconciliationsForSummary
      .filter(
        (g) =>
          g.status === 'confirmed' &&
          ['transfer', 'fx_transfer', 'profit_distribution'].includes(g.type) &&
          g.transactionIds.every((id) =>
            cashAccountIds.has(transactionById.get(id)?.accountId ?? ''),
          ),
      )
      .flatMap((g) => g.transactionIds),
  )
  let receivedCents = 0
  let paidCents = 0
  for (const t of cashMovements) {
    if (
      t.postedAt < monthStart ||
      t.postedAt > cashDate ||
      ownCashTransferIds.has(t.id)
    )
      continue
    const cents = amountInBaseCurrency(transactionById.get(t.id)!)
    if (cents === null) continue
    if (cents > 0) receivedCents += cents
    else paidCents -= cents
  }
  let expectedIncomeCents = 0
  const coveredPendingIds = new Set<string>()
  for (const recurrence of recurrenceRows) {
    if (
      !recurrence.active ||
      recurrence.direction !== 'income' ||
      recurrence.creditCardId ||
      ['transfer', 'profit_distribution_income'].includes(
        recurrence.categoryId ?? '',
      ) ||
      (recurrence.accountId && !cashAccountIds.has(recurrence.accountId))
    )
      continue
    const instances = new Map(
      (occurrencesByRecurrence.get(recurrence.id) ?? []).map((o) => [
        o.expectedDate,
        {
          id: o.id,
          date: o.expectedDate,
          cents: o.expectedAmountCents,
          status: o.status,
        },
      ]),
    )
    for (
      let date = recurrence.nextDate;
      date <= monthEnd;
      date = addRecurrencePeriod(
        date,
        recurrence.frequency,
        recurrence.scheduleAnchor,
      )
    ) {
      if (date >= monthStart && !instances.has(date))
        instances.set(date, {
          id: '',
          date,
          cents: recurrence.amountCents,
          status: 'expected',
        })
    }
    for (const o of instances.values()) {
      if (
        o.status !== 'expected' ||
        o.date < referenceDate ||
        o.date < monthStart ||
        o.date > monthEnd
      )
        continue
      const pending = projectedPendingByOccurrenceId.get(o.id)
      if (pending) coveredPendingIds.add(pending.id)
      expectedIncomeCents += pending
        ? (amountInBaseCurrency(pending) ?? 0)
        : (convertToBaseCurrency(o.cents, recurrence.currency) ?? 0)
    }
  }
  for (const t of transactions) {
    if (
      t.status === 'pending' &&
      t.accountId &&
      cashAccountIds.has(t.accountId) &&
      t.amountCents > 0 &&
      !ownCashTransferIds.has(t.id) &&
      !(
        t.counterpartyAccountId && cashAccountIds.has(t.counterpartyAccountId)
      ) &&
      !(t.categoryId === 'transfer' && !t.counterpartyAccountId) &&
      t.postedAt >= referenceDate &&
      t.postedAt >= monthStart &&
      t.postedAt <= monthEnd &&
      !coveredPendingIds.has(t.id)
    )
      expectedIncomeCents += amountInBaseCurrency(t) ?? 0
  }
  return summarizeMonthlyCashFlow({
    forecasting: familyMonth.forecasting,
    openingCashCents: cashAt(shiftDays(monthStart, -1)),
    cashCents:
      currentMonth > referenceDate.slice(0, 7) ? null : cashAt(cashDate),
    receivedCents,
    paidCents,
    expectedIncomeCents,
    remainingExpenseCents: Math.max(
      0,
      familyMonth.lines.reduce((sum, l) => sum + l.cents - l.paidCents, 0),
    ),
    goalRemainingCents: familyMonth.savingsRemainingCents,
  })
}

/** Reconstruct a recorded balance around a dated statement, without creating ledger entries. */
function recordedBalanceAt(input: {
  date: string
  initialCents: number
  anchors: Array<{ date: string; cents: number }>
  movements: Array<{ date: string; cents: number }>
}): number | null {
  const anchors = [...input.anchors].sort((a, b) =>
    a.date.localeCompare(b.date),
  )
  const anchor =
    anchors.filter((a) => a.date <= input.date).at(-1) ?? anchors.at(0)
  if (!anchor) {
    if (
      !input.movements.some((m) => m.date <= input.date) &&
      input.initialCents !== 0
    )
      return null
    return (
      input.initialCents +
      input.movements
        .filter((m) => m.date <= input.date)
        .reduce((sum, m) => sum + m.cents, 0)
    )
  }
  if (
    anchor.date > input.date &&
    !input.movements.some((m) => m.date <= input.date)
  )
    return anchor.cents === 0 && input.movements.length === 0 ? 0 : null
  return (
    anchor.cents +
    input.movements.reduce((sum, m) => {
      if (anchor.date <= input.date)
        return (
          sum + (m.date > anchor.date && m.date <= input.date ? m.cents : 0)
        )
      return sum - (m.date > input.date && m.date <= anchor.date ? m.cents : 0)
    }, 0)
  )
}

function summarizeMonthlyCashFlow(input: {
  forecasting: boolean
  openingCashCents: number | null
  cashCents: number | null
  receivedCents: number
  paidCents: number
  expectedIncomeCents: number
  remainingExpenseCents: number
  goalRemainingCents: number
}) {
  const expectedIncomeCents = input.forecasting ? input.expectedIncomeCents : 0
  const remainingExpenseCents = input.forecasting
    ? input.remainingExpenseCents
    : 0
  const closingCashCents =
    input.cashCents === null
      ? null
      : input.cashCents + expectedIncomeCents - remainingExpenseCents
  return {
    ...input,
    expectedIncomeCents,
    remainingExpenseCents,
    closingCashCents,
    afterGoalsCents:
      closingCashCents === null
        ? null
        : closingCashCents - (input.forecasting ? input.goalRemainingCents : 0),
    unexplainedChangeCents:
      input.cashCents === null || input.openingCashCents === null
        ? null
        : input.cashCents -
          input.openingCashCents -
          input.receivedCents +
          input.paidCents,
  }
}

// ─── Projeção de caixa ───────────────────────────────────────────────────────

const VARIABLE_WINDOW_DAYS = 60
const ALLOCATION_BUCKETS = new Set(['investment', 'reserve'])

export interface CashPoint {
  date: string
  balanceCents: number
  lowCents?: number
  highCents?: number
}

/** Compromisso datado que move o caixa, na moeda-base e com sinal. */
export interface CashEvent {
  id: string
  date: string
  name: string
  amountCents: number
  kind: 'income' | 'expense' | 'statement'
  certainty: 'closed' | 'installment_schedule' | 'open' | null
}

export interface CashProjection {
  today: string
  /** Vazio quando o caixa de hoje é desconhecido. */
  points: Array<CashPoint>
  todayIndex: number
  lowPoint: CashPoint | null
  in30Cents: number | null
  dailyVariableCents: number
  /** Compromissos dentro do horizonte, em ordem de data. */
  scheduled: Array<CashEvent>
  recurringEstimateTransactionIds: string[]
  largestHistoricalExpenses: Array<{
    id: string
    date: string
    description: string
    cents: number
  }>
  observedAdvancePayments: Array<{
    occurrenceId: string
    transactionId: string
    name: string
    dueDate: string
    paidDate: string
    cents: number
  }>
  assumptions: {
    days: number
    startingCents: number | null
    estimatedIncomeCents: number
    estimatedRecurrenceCents: number
    closedCardCents: number
    scheduledCardCents: number
    estimatedCardCents: number
    historicalEstimateCents: number
  }
}

export interface CashProjectionFacts extends MonthlyCashFlowFacts {
  categories: ReadonlyArray<{ id: string; bucket: string | null }>
  cards: ReadonlyArray<{
    id: string
    name: string
    currency: string
    upcomingStatements: ReadonlyArray<{
      dueDate: string
      amountCents: number
      certainty?: 'closed' | 'installment_schedule' | 'open'
      /** Already settled by linked or identified bank debits. */
      paidCents?: number
      /** Settled in full, including a person's non-partial manual link. */
      paid?: boolean
    }>
  }>
  installmentPlans: ReadonlyArray<{ sourceTransactionId: string | null }>
  knowledgeReferences: ReadonlyArray<{
    recurrenceId: string | null
    description: string
  }>
  matches: ReadonlyArray<{
    occurrenceId: string
    transactionId: string
    status: string
  }>
}

type ForecastOccurrence = {
  id: string
  expectedDate: string
  expectedAmountCents: number
  currency: string
  direction: 'income' | 'expense'
  status: string
}

/** Completa o calendário sem criar ocorrências ou substituir pagamentos registrados. */
function forecastOccurrences(
  recurrence: CashRecurrence,
  recorded: ReadonlyArray<CashOccurrence>,
  horizon: string,
): Array<ForecastOccurrence> {
  const occurrences = new Map<string, ForecastOccurrence>(
    recorded.map((occurrence) => [
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
 * Projeta o caixa operacional: histórico reconstruído pelo mesmo `cashAt` do
 * resumo mensal, depois recorrências em conta, faturas conhecidas e a média
 * diária do consumo variável dos últimos 60 dias. Não grava vínculos.
 */
export function projectCash(
  input: CashProjectionFacts,
  options: { today: string; daysBack: number; daysAhead: number },
): CashProjection {
  const { today, daysBack, daysAhead } = options
  const horizon = shiftDays(today, daysAhead)
  const position = createCashPosition({ ...input, referenceDate: today })
  const { cashAccountIds, amountInBaseCurrency, convertToBaseCurrency } =
    position
  const bucketByCategory = new Map(
    input.categories.map((category) => [category.id, category.bucket]),
  )
  const cardById = new Map(input.cards.map((card) => [card.id, card]))
  const installmentIds = new Set(
    input.installmentPlans.flatMap((plan) =>
      plan.sourceTransactionId ? [plan.sourceTransactionId] : [],
    ),
  )
  const internalTransferIds = new Set(
    input.reconciliations
      .filter(
        (group) =>
          group.status === 'confirmed' && isInternalTransferType(group.type),
      )
      .flatMap((group) => group.transactionIds),
  )
  const occurrencesByRecurrence = new Map<string, CashOccurrence[]>()
  for (const occurrence of input.occurrences) {
    const rows = occurrencesByRecurrence.get(occurrence.recurrenceId) ?? []
    rows.push(occurrence)
    occurrencesByRecurrence.set(occurrence.recurrenceId, rows)
  }
  const acceptedMatchIds = new Set(
    input.matches
      .filter((match) => isAcceptedRecurrenceMatchStatus(match.status))
      .map((match) => match.transactionId),
  )
  const acceptedMatchesByOccurrence = new Map<string, string[]>()
  for (const match of input.matches) {
    if (!isAcceptedRecurrenceMatchStatus(match.status)) continue
    const rows = acceptedMatchesByOccurrence.get(match.occurrenceId) ?? []
    rows.push(match.transactionId)
    acceptedMatchesByOccurrence.set(match.occurrenceId, rows)
  }
  const accountRecurrences = input.recurrences.filter(
    (recurrence) => recurrence.active && !recurrence.creditCardId,
  )
  // Lançamentos vinculados a recorrências em conta saem da média; os do cartão
  // já entram pela fatura e continuam contando como consumo.
  const accountMatchedIds = new Set(
    accountRecurrences.flatMap((recurrence) =>
      (occurrencesByRecurrence.get(recurrence.id) ?? []).flatMap(
        (occurrence) => acceptedMatchesByOccurrence.get(occurrence.id) ?? [],
      ),
    ),
  )
  const patternsByRecurrence = new Map(
    accountRecurrences.map((recurrence) => [
      recurrence.id,
      new Set(
        input.knowledgeReferences
          .filter((entry) => entry.recurrenceId === recurrence.id)
          .flatMap((entry) => knowledgeExactPatterns(entry.description)),
      ),
    ]),
  )
  const calendar = accountRecurrences.map((recurrence) => ({
    recurrence,
    patterns: patternsByRecurrence.get(recurrence.id) ?? new Set<string>(),
    occurrences: forecastOccurrences(
      recurrence,
      occurrencesByRecurrence.get(recurrence.id) ?? [],
      horizon,
    ),
  }))

  // Pagamentos fixos inequívocos ajustam o cenário, sem confirmar ocorrências.
  const advanceCandidates = calendar.filter(
    ({ recurrence, patterns }) =>
      recurrence.direction === 'expense' &&
      recurrence.amountMode === 'fixed' &&
      patterns.size > 0,
  )
  const advancePayments: CashProjection['observedAdvancePayments'] = []
  if (advanceCandidates.length > 0) {
    for (const row of input.transactions) {
      if (
        !row.accountId ||
        row.status !== 'confirmed' ||
        row.amountCents >= 0 ||
        row.postedAt > today ||
        row.counterpartyAccountId ||
        internalTransferIds.has(row.id) ||
        acceptedMatchIds.has(row.id)
      )
        continue
      const patterns = knowledgeExactPatterns(row.description)
      const candidates = advanceCandidates.flatMap(
        ({ recurrence, patterns: approved, occurrences }) => {
          if (
            recurrence.currency !== row.currency ||
            !patterns.some((pattern) => approved.has(pattern)) ||
            (recurrence.destinationMode === 'fixed' &&
              recurrence.accountId &&
              recurrence.accountId !== row.accountId)
          )
            return []
          return occurrences
            .filter(
              (occurrence) =>
                occurrence.expectedAmountCents === -row.amountCents &&
                Math.abs(
                  daysBetween(row.postedAt, occurrence.expectedDate, {
                    inclusive: false,
                  }),
                ) <= recurrence.dateToleranceDays,
            )
            .map((occurrence) => ({ recurrence, occurrence }))
        },
      )
      if (candidates.length !== 1) continue
      const { recurrence, occurrence } = candidates[0]
      if (
        occurrence.status !== 'expected' ||
        occurrence.expectedDate <= today ||
        occurrence.expectedDate > horizon
      )
        continue
      advancePayments.push({
        occurrenceId: occurrence.id,
        transactionId: row.id,
        name: recurrence.name,
        dueDate: occurrence.expectedDate,
        paidDate: row.postedAt,
        cents: -row.amountCents,
      })
    }
  }
  const advanceCounts = new Map<string, number>()
  for (const payment of advancePayments)
    advanceCounts.set(
      payment.occurrenceId,
      (advanceCounts.get(payment.occurrenceId) ?? 0) + 1,
    )
  const observedAdvancePayments = advancePayments.filter(
    (payment) => advanceCounts.get(payment.occurrenceId) === 1,
  )
  const paidOccurrenceIds = new Set(
    observedAdvancePayments.map((payment) => payment.occurrenceId),
  )

  // Consumo variável: saídas em conta operacional ou cartão que não são
  // transferências, recorrências em conta, parcelas nem aportes.
  const variableWindowStart = shiftDays(today, -VARIABLE_WINDOW_DAYS)
  const recurringEstimateTransactionIds: string[] = []
  const historicalExpenses: CashProjection['largestHistoricalExpenses'] = []
  let variableTotal = 0
  for (const transaction of input.transactions) {
    if (transaction.status !== 'confirmed') continue
    const inCashAccount =
      transaction.accountId !== null &&
      cashAccountIds.has(transaction.accountId)
    const inCard =
      transaction.creditCardId !== null &&
      cardById.has(transaction.creditCardId)
    if (!inCashAccount && !inCard) continue
    if (
      transaction.amountCents >= 0 ||
      transaction.postedAt > today ||
      transaction.postedAt < variableWindowStart ||
      transaction.counterpartyAccountId ||
      internalTransferIds.has(transaction.id) ||
      accountMatchedIds.has(transaction.id) ||
      installmentIds.has(transaction.id)
    )
      continue
    const bucket = transaction.categoryId
      ? (bucketByCategory.get(transaction.categoryId) ?? null)
      : null
    if (bucket !== null && ALLOCATION_BUCKETS.has(bucket)) continue
    if (bucket === 'excluded' && transaction.categoryId !== 'uncategorized')
      continue
    const cents = amountInBaseCurrency(transaction)
    if (cents === null) continue
    const patterns = knowledgeExactPatterns(transaction.description)
    const covered = calendar.filter(
      ({ recurrence, patterns: approved }) =>
        recurrence.direction === 'expense' &&
        recurrence.currency === transaction.currency &&
        patterns.some(
          (pattern) => pattern.length > 2 && approved.has(pattern),
        ) &&
        (recurrence.amountMode === 'variable' ||
          Math.abs(
            Math.abs(transaction.amountCents) - recurrence.amountCents,
          ) <=
            Math.round(
              (recurrence.amountCents * recurrence.amountToleranceBps) / 10_000,
            )),
    )
    // Só uma recorrência compatível pode substituir a média; não confirma pagamento.
    if (covered.length === 1) {
      recurringEstimateTransactionIds.push(transaction.id)
      continue
    }
    variableTotal += -cents
    historicalExpenses.push({
      id: transaction.id,
      date: transaction.postedAt,
      description: transaction.description,
      cents: -cents,
    })
  }
  const dailyVariableCents = Math.round(variableTotal / VARIABLE_WINDOW_DAYS)

  // Compromissos datados dentro do horizonte.
  const scheduled: Array<CashEvent> = []
  for (const { recurrence, occurrences } of calendar) {
    // Receitas e despesas de contas fora do caixa operacional (reserva,
    // investimento, inativas) não movem o saldo projetado.
    if (recurrence.accountId && !cashAccountIds.has(recurrence.accountId))
      continue
    if (
      recurrence.direction === 'income' &&
      ['transfer', 'profit_distribution_income'].includes(
        recurrence.categoryId ?? '',
      )
    )
      continue
    for (const occurrence of occurrences) {
      if (
        occurrence.status !== 'expected' ||
        paidOccurrenceIds.has(occurrence.id) ||
        occurrence.expectedDate <= today ||
        occurrence.expectedDate > horizon
      )
        continue
      const cents = convertToBaseCurrency(
        occurrence.expectedAmountCents,
        occurrence.currency,
      )
      if (cents === null) continue
      scheduled.push({
        id: occurrence.id,
        date: occurrence.expectedDate,
        name: recurrence.name,
        amountCents: occurrence.direction === 'income' ? cents : -cents,
        kind: occurrence.direction,
        certainty: null,
      })
    }
  }
  for (const card of input.cards) {
    for (const statement of card.upcomingStatements) {
      if (statement.dueDate <= today || statement.dueDate > horizon) continue
      if (statement.amountCents === 0 || statement.paid) continue
      // Só o que ainda falta pagar sai do caixa na data de vencimento.
      const remainingCents = Math.max(
        0,
        Math.abs(statement.amountCents) - Math.max(0, statement.paidCents ?? 0),
      )
      if (remainingCents === 0) continue
      // Faturas sem cotação ficam fora em vez de entrar como se fossem reais.
      const cents = convertToBaseCurrency(remainingCents, card.currency)
      if (cents === null) continue
      const certainty = statement.certainty ?? 'open'
      scheduled.push({
        id: `${card.id}-${statement.dueDate}`,
        date: statement.dueDate,
        name: `${certainty === 'installment_schedule' ? 'Parcelas conhecidas' : 'Fatura'} ${card.name}`,
        amountCents: -cents,
        kind: 'statement',
        certainty,
      })
    }
  }
  scheduled.sort((a, b) => a.date.localeCompare(b.date))

  // Histórico: o mesmo caixa do resumo mensal, dia a dia, até onde for conhecido.
  const startingCents = position.cashAt(today)
  const points: Array<CashPoint> = []
  if (startingCents !== null) {
    for (let i = 1; i <= daysBack; i++) {
      const date = shiftDays(today, -i)
      const balanceCents = position.cashAt(date)
      if (balanceCents === null) break
      points.unshift({ date, balanceCents })
    }
    points.push({ date: today, balanceCents: startingCents })
  }
  const todayIndex = points.length - 1

  return trimCashProjection(
    {
      today,
      points,
      todayIndex,
      lowPoint: null,
      in30Cents: null,
      dailyVariableCents,
      scheduled,
      recurringEstimateTransactionIds,
      largestHistoricalExpenses: historicalExpenses
        .sort((a, b) => b.cents - a.cents)
        .slice(0, 5),
      observedAdvancePayments,
      assumptions: {
        days: daysAhead,
        startingCents,
        estimatedIncomeCents: 0,
        estimatedRecurrenceCents: 0,
        closedCardCents: 0,
        scheduledCardCents: 0,
        estimatedCardCents: 0,
        historicalEstimateCents: 0,
      },
    },
    daysAhead,
  )
}

/**
 * Recorta a projeção a um horizonte menor ou igual ao original: recalcula os
 * pontos futuros, o menor saldo e as premissas sem consultar os fatos.
 */
export function trimCashProjection(
  projection: CashProjection,
  daysAhead: number,
): CashProjection {
  const days = Math.min(daysAhead, projection.assumptions.days)
  const { today, dailyVariableCents } = projection
  const horizon = shiftDays(today, days)
  const scheduled = projection.scheduled.filter(
    (event) => event.date <= horizon,
  )
  const observedAdvancePayments = projection.observedAdvancePayments.filter(
    (payment) => payment.dueDate <= horizon,
  )
  const assumptions: CashProjection['assumptions'] = {
    days,
    startingCents: projection.assumptions.startingCents,
    estimatedIncomeCents: 0,
    estimatedRecurrenceCents: 0,
    closedCardCents: 0,
    scheduledCardCents: 0,
    estimatedCardCents: 0,
    historicalEstimateCents: dailyVariableCents * days,
  }
  const futureDelta = new Map<string, number>()
  for (const event of scheduled) {
    futureDelta.set(
      event.date,
      (futureDelta.get(event.date) ?? 0) + event.amountCents,
    )
    const cents = Math.abs(event.amountCents)
    if (event.kind === 'income') assumptions.estimatedIncomeCents += cents
    else if (event.kind === 'expense')
      assumptions.estimatedRecurrenceCents += cents
    else if (event.certainty === 'closed') assumptions.closedCardCents += cents
    else if (event.certainty === 'installment_schedule')
      assumptions.scheduledCardCents += cents
    else assumptions.estimatedCardCents += cents
  }

  const startingCents = assumptions.startingCents
  if (startingCents === null || projection.todayIndex < 0) {
    return {
      ...projection,
      points: [],
      todayIndex: -1,
      lowPoint: null,
      in30Cents: null,
      scheduled,
      observedAdvancePayments,
      assumptions,
    }
  }
  const points = projection.points.slice(0, projection.todayIndex + 1)
  let balance = startingCents
  for (let i = 1; i <= days; i++) {
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
  const todayIndex = projection.todayIndex
  const future = points.slice(todayIndex + 1)
  return {
    ...projection,
    points,
    todayIndex,
    lowPoint: future.length
      ? future.reduce((min, p) => (p.balanceCents < min.balanceCents ? p : min))
      : null,
    in30Cents:
      points[Math.min(todayIndex + 30, points.length - 1)].balanceCents,
    scheduled,
    observedAdvancePayments,
    assumptions,
  }
}
