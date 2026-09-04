import {
  isBudgetSpendingBucket,
  isFamilyScope,
  isInternalTransferType,
} from './ledger'
import type { BudgetSpendingBucket, OwnershipScopeType } from './ledger'

export type StrategyBucket =
  'essential' | 'lifestyle' | 'investment' | 'reserve'

export type SummaryTransaction = {
  id: string
  postedAt: string
  amountCents: number | null
  status: 'pending' | 'confirmed' | 'excluded'
  categoryId: string | null
  bucket: string | null
  incomeBaseEligible: boolean
  scopeType: OwnershipScopeType | null
  accountPurpose: 'operating' | 'reserve' | 'investment' | null
}

export type SummarySplit = {
  transactionId: string
  amountCents: number
  bucket: string
}

export type SummaryReconciliation = {
  type:
    | 'transfer'
    | 'fx_transfer'
    | 'card_payment'
    | 'refund'
    | 'profit_distribution'
  status: 'suggested' | 'confirmed' | 'rejected'
  transactionIds: string[]
}

export type RecurrenceActual = {
  transactionId: string
  amountCents: number
  bucket: BudgetSpendingBucket
  categoryConflict: boolean
}

export type IntegrityIssue = {
  code:
    | 'uncategorized_confirmed'
    | 'pending_transaction'
    | 'missing_base_conversion'
    | 'missing_balance_conversion'
    | 'review_import'
    | 'suggested_reconciliation'
    | 'overdue_recurrence'
    | 'recurrence_category_conflict'
    | 'unverified_balance'
  count: number
  blocksClosing: boolean
}

export function buildFinancialSummary(input: {
  month: string
  transactions: SummaryTransaction[]
  splits: SummarySplit[]
  reconciliations: SummaryReconciliation[]
  recurrenceActuals: RecurrenceActual[]
  recurrenceCandidateTransactionIds: string[]
  netWorthCents: number
  missingBalanceConversionCount: number
  missingRecurrenceConversionCount: number
  reviewImportCount: number
  overdueRecurrenceCount: number
  unverifiedBalanceCount: number
}) {
  const monthTransactions = input.transactions.filter((transaction) =>
    transaction.postedAt.startsWith(input.month),
  )
  const splitByTransaction = new Map<string, SummarySplit[]>()
  for (const split of input.splits) {
    const current = splitByTransaction.get(split.transactionId) ?? []
    current.push(split)
    splitByTransaction.set(split.transactionId, current)
  }
  const confirmedGroups = input.reconciliations.filter(
    (group) => group.status === 'confirmed',
  )
  const excludedActualIds = new Set(
    confirmedGroups
      .filter((group) => isInternalTransferType(group.type))
      .flatMap((group) => group.transactionIds),
  )
  const transactionsById = new Map(
    input.transactions.map((transaction) => [transaction.id, transaction]),
  )
  const confirmedProfitDestinationIds = new Set(
    confirmedGroups
      .filter((group) => group.type === 'profit_distribution')
      .flatMap((group) => group.transactionIds)
      .filter((id) => (transactionsById.get(id)?.amountCents ?? 0) > 0),
  )
  const recurrenceCandidateIds = new Set(
    input.recurrenceCandidateTransactionIds,
  )
  const actual: Record<StrategyBucket, number> = {
    essential: 0,
    lifestyle: 0,
    investment: 0,
    reserve: 0,
  }
  const pending: Record<StrategyBucket, number> = {
    essential: 0,
    lifestyle: 0,
    investment: 0,
    reserve: 0,
  }

  for (const transaction of monthTransactions) {
    if (
      transaction.status !== 'confirmed' ||
      !isFamilyScope(transaction.scopeType) ||
      transaction.amountCents === null ||
      excludedActualIds.has(transaction.id)
    ) {
      continue
    }
    const splits = splitByTransaction.get(transaction.id)
    if (splits?.length) {
      for (const split of splits) {
        if (isBudgetSpendingBucket(split.bucket)) {
          actual[split.bucket] += -split.amountCents
        }
      }
    } else if (isBudgetSpendingBucket(transaction.bucket)) {
      actual[transaction.bucket] += -transaction.amountCents
    }
  }

  for (const transaction of monthTransactions) {
    if (
      transaction.status !== 'pending' ||
      !isFamilyScope(transaction.scopeType) ||
      transaction.amountCents === null ||
      recurrenceCandidateIds.has(transaction.id) ||
      excludedActualIds.has(transaction.id)
    ) {
      continue
    }
    if (isBudgetSpendingBucket(transaction.bucket)) {
      pending[transaction.bucket] += -transaction.amountCents
    }
  }

  for (const group of confirmedGroups) {
    if (group.type !== 'transfer' && group.type !== 'fx_transfer') continue
    const groupTransactions = group.transactionIds
      .map((id) => transactionsById.get(id))
      .filter((transaction): transaction is SummaryTransaction =>
        Boolean(
          transaction &&
          transaction.status === 'confirmed' &&
          transaction.amountCents !== null &&
          isFamilyScope(transaction.scopeType),
        ),
      )
    const source = groupTransactions.find(
      (transaction) => (transaction.amountCents ?? 0) < 0,
    )
    const destination = groupTransactions.find(
      (transaction) => (transaction.amountCents ?? 0) > 0,
    )
    if (
      !source ||
      !destination ||
      !destination.postedAt.startsWith(input.month)
    ) {
      continue
    }
    const value = Math.abs(destination.amountCents ?? source.amountCents ?? 0)
    if (source.accountPurpose === 'investment') actual.investment -= value
    if (source.accountPurpose === 'reserve') actual.reserve -= value
    if (destination.accountPurpose === 'investment') actual.investment += value
    if (destination.accountPurpose === 'reserve') actual.reserve += value
  }

  for (const recurrence of input.recurrenceActuals) {
    const transaction = transactionsById.get(recurrence.transactionId)
    if (
      !transaction ||
      isFamilyScope(transaction.scopeType) ||
      !transaction.postedAt.startsWith(input.month)
    ) {
      continue
    }
    actual[recurrence.bucket] += recurrence.amountCents
  }

  actual.essential = Math.max(0, actual.essential)
  actual.lifestyle = Math.max(0, actual.lifestyle)
  const currentExpenseCents = actual.essential + actual.lifestyle
  const currentIncomeCents = monthTransactions.reduce((sum, transaction) => {
    if (
      transaction.status !== 'confirmed' ||
      !isFamilyScope(transaction.scopeType) ||
      transaction.amountCents === null ||
      transaction.amountCents <= 0 ||
      !transaction.incomeBaseEligible ||
      excludedActualIds.has(transaction.id) ||
      (transaction.categoryId === 'profit_distribution_income' &&
        !confirmedProfitDestinationIds.has(transaction.id))
    ) {
      return sum
    }
    return sum + transaction.amountCents
  }, 0)

  const issues: IntegrityIssue[] = []
  const pushIssue = (
    code: IntegrityIssue['code'],
    count: number,
    blocksClosing: boolean,
  ) => {
    if (count > 0) issues.push({ code, count, blocksClosing })
  }
  pushIssue(
    'uncategorized_confirmed',
    monthTransactions.filter(
      (transaction) =>
        transaction.status === 'confirmed' &&
        isFamilyScope(transaction.scopeType) &&
        (!transaction.categoryId || transaction.categoryId === 'uncategorized'),
    ).length,
    true,
  )
  pushIssue(
    'pending_transaction',
    monthTransactions.filter(
      (transaction) =>
        transaction.status === 'pending' &&
        isFamilyScope(transaction.scopeType),
    ).length,
    true,
  )
  pushIssue(
    'missing_base_conversion',
    monthTransactions.filter(
      (transaction) =>
        transaction.status !== 'excluded' &&
        isFamilyScope(transaction.scopeType) &&
        transaction.amountCents === null,
    ).length + input.missingRecurrenceConversionCount,
    true,
  )
  pushIssue(
    'missing_balance_conversion',
    input.missingBalanceConversionCount,
    false,
  )
  pushIssue('review_import', input.reviewImportCount, true)
  pushIssue(
    'suggested_reconciliation',
    input.reconciliations.filter((group) => group.status === 'suggested')
      .length,
    true,
  )
  pushIssue('overdue_recurrence', input.overdueRecurrenceCount, true)
  pushIssue(
    'recurrence_category_conflict',
    input.recurrenceActuals.filter(
      (match) =>
        match.categoryConflict &&
        transactionsById
          .get(match.transactionId)
          ?.postedAt.startsWith(input.month),
    ).length,
    true,
  )
  pushIssue('unverified_balance', input.unverifiedBalanceCount, false)

  return {
    netWorthCents: input.netWorthCents,
    currentIncomeCents,
    currentExpenseCents,
    budgetActual: actual,
    budgetPending: pending,
    integrity: {
      partial: issues.length > 0,
      issues,
      totalCount: issues.reduce((sum, issue) => sum + issue.count, 0),
      closingBlockerCount: issues
        .filter((issue) => issue.blocksClosing)
        .reduce((sum, issue) => sum + issue.count, 0),
    },
  }
}
