import { convertMinorUnitsAtRate } from './currency'
import { addMonths } from './credit-card'
import { shiftDays } from './period'
import { isFamilyScope } from './ledger'
import type { OwnershipScopeType } from './ledger'
import { pendingTransactionCoversRecurrence } from './recurrence-book'
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

/** Calcula caixa realizado e previsto a partir dos fatos, sem alterar o ledger. */
export function buildMonthlyCashFlow(
  input: MonthlyCashFlowFacts & {
    month: string
    referenceDate: string
    commitments: MonthCommitments
  },
) {
  const {
    accounts,
    transactions,
    checkpoints: checkpointRows,
    recurrences: recurrenceRows,
    exchangeRates,
    referenceDate,
    month: currentMonth,
    commitments: familyMonth,
    reconciliations: reconciliationsForSummary,
  } = input
  const settings = { baseCurrency: input.baseCurrency }
  // A leitura não precisa conhecer a ordem das cotações.
  const exchangeRateRows = [...exchangeRates].sort((a, b) =>
    b.date.localeCompare(a.date),
  )
  const transactionRows = transactions
  const transactionById = new Map(transactions.map((row) => [row.id, row]))
  const occurrencesByRecurrence = new Map<string, CashOccurrence[]>()
  for (const occurrence of input.occurrences) {
    const rows = occurrencesByRecurrence.get(occurrence.recurrenceId) ?? []
    rows.push(occurrence)
    occurrencesByRecurrence.set(occurrence.recurrenceId, rows)
  }
  const projectedPendingByOccurrenceId = pendingRecurrencePayments(input)
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

  const monthStart = currentMonth + '-01'
  const monthEnd = shiftDays(addMonths(monthStart, 1), -1)
  const cashDate = monthEnd < referenceDate ? monthEnd : referenceDate
  const cashAccounts = accounts.filter(
    (a) => a.active && a.purpose === 'operating',
  )
  const cashAccountIds = new Set(cashAccounts.map((a) => a.id))
  const cashMovements = transactionRows.filter(
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
        date === referenceDate
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
