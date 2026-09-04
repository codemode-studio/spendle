import { randomUUID } from 'node:crypto'
import { and, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm'

import { db, ensureDatabase } from '#/db/index.server'
import * as schema from '#/db/schema'
import { convertMinorUnitsAtRate } from '#/domain/currency'
import { statementValueSignature } from '#/domain/canonicalization'
import {
  classifyInstallmentCommitment,
  summarizeCardStatements,
} from '#/domain/credit-card'
import { buildFinancialSummary } from '#/domain/financial-summary'
import { isFamilyScope } from '#/domain/ledger'
import type { OwnershipScopeType } from '#/domain/ledger'
import {
  allocationAmount,
  calculateConservativeBase,
  normalizeDescription,
  resolveEffectiveAllocation,
  strategyAllocationSchema,
} from '#/domain/finance'
import { evaluateImportAudit } from '#/domain/import-audit'
import {
  buildCoverageView,
  countCoveredDaysAfter,
} from '#/domain/import-coverage'
import {
  describeRecurrence,
  isAcceptedRecurrenceMatchStatus,
  pendingTransactionCoversRecurrence,
} from '#/domain/recurrence-book'
import {
  categorizeTransactionsWithAi,
  filterConfidentAiSuggestions,
} from './ai.server'
import {
  invalidateCheckpointChain,
  recordManualBalanceCheckpoint,
  refreshStatementAnchor,
} from './checkpoint-chain.server'
import {
  linkCanonicalObservation,
  transactionFingerprint,
} from './canonicalization.server'
import {
  refreshReconciliationAfterCommit,
  refreshReconciliationSuggestions,
} from './reconciliation-refresh.server'
import {
  noteTransactionCategoryChanged,
  refreshRecurrences,
} from './recurrence.server'

export async function getFinanceSnapshot(selectedMonth?: string) {
  await ensureDatabase()

  const [
    scopes,
    institutions,
    accountRows,
    cardRows,
    categoryRows,
    transactionRows,
    strategyRows,
    monthlyBudgetRows,
    goalRows,
    contributionRows,
    cardInstrumentRows,
    importRows,
    stagedRows,
    reconciliationRows,
    reconciliationLinkRows,
    checkpointRows,
    coverageRows,
    correctionRows,
    cardStatementCycleRows,
    recurrenceGroupRows,
    recurrenceRows,
    recurrenceOccurrenceRows,
    recurrenceMatchRows,
    transactionSplitRows,
    exchangeRateRows,
    installmentRows,
    settingsRows,
  ] = await Promise.all([
    db
      .select()
      .from(schema.ownershipScopes)
      .orderBy(schema.ownershipScopes.name),
    db.select().from(schema.institutions).orderBy(schema.institutions.name),
    db.select().from(schema.accounts).orderBy(schema.accounts.name),
    db.select().from(schema.creditCards).orderBy(schema.creditCards.name),
    db.select().from(schema.categories).orderBy(schema.categories.name),
    db
      .select()
      .from(schema.transactions)
      .orderBy(desc(schema.transactions.postedAt)),
    db
      .select()
      .from(schema.budgetStrategies)
      .orderBy(schema.budgetStrategies.name),
    db
      .select()
      .from(schema.monthlyBudgets)
      .orderBy(desc(schema.monthlyBudgets.month)),
    db
      .select()
      .from(schema.investmentGoals)
      .orderBy(schema.investmentGoals.priority),
    db
      .select()
      .from(schema.goalContributions)
      .orderBy(desc(schema.goalContributions.contributedAt)),
    db.select().from(schema.creditCardInstruments),
    db.select().from(schema.imports).orderBy(desc(schema.imports.createdAt)),
    db
      .select()
      .from(schema.stagedTransactions)
      .orderBy(schema.stagedTransactions.postedAt),
    db
      .select()
      .from(schema.reconciliationGroups)
      .orderBy(desc(schema.reconciliationGroups.createdAt)),
    db.select().from(schema.reconciliationLinks),
    db
      .select()
      .from(schema.balanceCheckpoints)
      .orderBy(desc(schema.balanceCheckpoints.asOf)),
    db.select().from(schema.coverageIntervals),
    db
      .select()
      .from(schema.transactionCorrections)
      .orderBy(desc(schema.transactionCorrections.createdAt)),
    db
      .select()
      .from(schema.cardStatementCycles)
      .orderBy(desc(schema.cardStatementCycles.periodEnd)),
    db
      .select()
      .from(schema.recurrenceGroups)
      .orderBy(schema.recurrenceGroups.name),
    db.select().from(schema.recurrences).orderBy(schema.recurrences.nextDate),
    db
      .select()
      .from(schema.recurrenceOccurrences)
      .orderBy(desc(schema.recurrenceOccurrences.expectedDate)),
    db.select().from(schema.recurrenceMatches),
    db.select().from(schema.transactionSplits),
    db
      .select()
      .from(schema.exchangeRates)
      .orderBy(desc(schema.exchangeRates.date)),
    db
      .select()
      .from(schema.installmentPlans)
      .orderBy(schema.installmentPlans.firstChargeDate),
    db.select().from(schema.appSettings).limit(1),
  ])

  const settings = settingsRows[0]
  const categoriesById = new Map(
    categoryRows.map((category) => [category.id, category]),
  )
  const scopeById = new Map(scopes.map((scope) => [scope.id, scope]))
  const institutionById = new Map(
    institutions.map((institution) => [institution.id, institution]),
  )
  const accountById = new Map(
    accountRows.map((account) => [account.id, account]),
  )
  const cardById = new Map(cardRows.map((card) => [card.id, card]))
  const importById = new Map(
    importRows.map((importRow) => [importRow.id, importRow]),
  )

  const transactions = transactionRows.map((transaction) => ({
    ...transaction,
    category: transaction.categoryId
      ? (categoriesById.get(transaction.categoryId) ?? null)
      : null,
    account: transaction.accountId
      ? (accountById.get(transaction.accountId) ?? null)
      : null,
    creditCard: transaction.creditCardId
      ? (cardById.get(transaction.creditCardId) ?? null)
      : null,
    counterpartyAccount: transaction.counterpartyAccountId
      ? (accountById.get(transaction.counterpartyAccountId) ?? null)
      : null,
  }))

  const referenceDate = new Date().toISOString().slice(0, 10)
  const buildCoverage = (targetId: string, targetType: 'account' | 'card') => {
    return buildCoverageView(
      coverageRows
        .filter((interval) =>
          targetType === 'account'
            ? interval.accountId === targetId
            : interval.creditCardId === targetId,
        )
        .map((interval) => ({
          start: interval.start,
          end: interval.end,
          importStatus:
            importById.get(interval.importId)?.status ?? ('failed' as const),
        })),
      referenceDate,
    )
  }
  const countUnverifiedDays = (
    coverage: ReturnType<typeof buildCoverage>,
    checkpointAsOf: string | null,
  ) => {
    return countCoveredDaysAfter(coverage.intervals, checkpointAsOf)
  }

  const accounts = accountRows.map((account) => {
    const confirmedMovement = transactionRows
      .filter(
        (transaction) =>
          transaction.accountId === account.id &&
          transaction.status === 'confirmed' &&
          (!account.statementBalanceAt ||
            transaction.postedAt > account.statementBalanceAt),
      )
      .reduce((sum, transaction) => sum + transaction.amountCents, 0)
    const pendingMovement = transactionRows
      .filter(
        (transaction) =>
          transaction.accountId === account.id &&
          transaction.status === 'pending' &&
          (!account.statementBalanceAt ||
            transaction.postedAt > account.statementBalanceAt),
      )
      .reduce((sum, transaction) => sum + transaction.amountCents, 0)
    const balanceCents =
      (account.statementBalanceCents ?? account.initialBalanceCents) +
      confirmedMovement
    const checkpoints = checkpointRows.filter(
      (checkpoint) =>
        checkpoint.accountId === account.id &&
        checkpoint.reviewState !== 'invalidated',
    )
    const latestVerifiedCheckpoint =
      checkpoints.find((checkpoint) => checkpoint.reviewState === 'verified') ??
      null
    const coverage = buildCoverage(account.id, 'account')
    return {
      ...account,
      balanceCents,
      projectedBalanceCents: balanceCents + pendingMovement,
      latestCheckpoint: checkpoints.at(0) ?? null,
      latestVerifiedCheckpoint,
      coverage,
      unverifiedDays: countUnverifiedDays(
        coverage,
        latestVerifiedCheckpoint?.asOf ?? null,
      ),
      scope: scopeById.get(account.ownershipScopeId) ?? null,
      institution: account.institutionId
        ? (institutionById.get(account.institutionId) ?? null)
        : null,
    }
  })

  const cards = cardRows.map((card) => {
    const effectiveDueDay =
      card.dueDay ?? Math.min(28, Math.max(1, card.closingDay + 7))
    const statementSummary = summarizeCardStatements({
      transactions: transactionRows.filter(
        (transaction) =>
          transaction.creditCardId === card.id &&
          transaction.status !== 'excluded',
      ),
      installmentPlans: installmentRows.filter(
        (plan) => plan.creditCardId === card.id,
      ),
      closingDay: card.closingDay,
      dueDay: effectiveDueDay,
      referenceDate,
    })
    const latestCheckpoint =
      checkpointRows.find(
        (checkpoint) =>
          checkpoint.creditCardId === card.id &&
          checkpoint.reviewState !== 'invalidated',
      ) ?? null
    const latestVerifiedCheckpoint =
      checkpointRows.find(
        (checkpoint) =>
          checkpoint.creditCardId === card.id &&
          checkpoint.reviewState === 'verified',
      ) ?? null
    const coverage = buildCoverage(card.id, 'card')
    return {
      ...card,
      dueDayEstimated: card.dueDay === null,
      instruments: cardInstrumentRows.filter(
        (instrument) => instrument.creditCardId === card.id,
      ),
      statementCents: statementSummary.current.amountCents,
      currentStatement: statementSummary.current,
      nextStatement: statementSummary.next,
      upcomingStatements: statementSummary.statements.filter(
        (statement) => statement.dueDate >= referenceDate,
      ),
      outstandingCents: statementSummary.outstandingCents,
      availableLimitCents: Math.max(
        0,
        card.limitCents - statementSummary.outstandingCents,
      ),
      latestCheckpoint,
      latestVerifiedCheckpoint,
      coverage,
      unverifiedDays: countUnverifiedDays(
        coverage,
        latestVerifiedCheckpoint?.asOf ?? null,
      ),
      statementCycles: cardStatementCycleRows.filter(
        (cycle) => cycle.creditCardId === card.id,
      ),
      scope: scopeById.get(card.ownershipScopeId) ?? null,
      institution: card.institutionId
        ? (institutionById.get(card.institutionId) ?? null)
        : null,
    }
  })

  const currentMonth = selectedMonth ?? referenceDate.slice(0, 7)
  const amountInBaseCurrency = (transaction: (typeof transactions)[number]) => {
    if (transaction.currency === settings.baseCurrency) {
      return transaction.amountCents
    }
    if (
      transaction.baseCurrency === settings.baseCurrency &&
      transaction.baseAmountCents !== null
    ) {
      return transaction.baseAmountCents
    }
    return null
  }
  const closedIncomes = monthlyBudgetRows
    .filter(
      (budget) =>
        budget.closed &&
        budget.month < currentMonth &&
        budget.eligibleIncomeCents !== null,
    )
    .sort((left, right) => right.month.localeCompare(left.month))
    .slice(0, 3)
    .map((budget) => budget.eligibleIncomeCents!)

  const calculatedBaseIncomeCents = calculateConservativeBase(
    settings.monthlyIncomeTargetCents,
    closedIncomes,
  )
  const selectedBudget = monthlyBudgetRows.find(
    (budget) => budget.month === currentMonth,
  )
  const activeStrategy =
    (selectedBudget
      ? strategyRows.find(
          (strategy) => strategy.id === selectedBudget.strategyId,
        )
      : undefined) ??
    strategyRows.find((strategy) => strategy.isDefault) ??
    strategyRows[0]
  const baseIncomeCents =
    selectedBudget?.baseIncomeCents ?? calculatedBaseIncomeCents
  const originalAllocation = selectedBudget
    ? {
        essential: selectedBudget.essentialBps,
        lifestyle: selectedBudget.lifestyleBps,
        investment: selectedBudget.investmentBps,
        reserve: selectedBudget.reserveBps,
      }
    : {
        essential: activeStrategy.essentialBps,
        lifestyle: activeStrategy.lifestyleBps,
        investment: activeStrategy.investmentBps,
        reserve: activeStrategy.reserveBps,
      }

  const emergencyGoal = goalRows.find(
    (goal) => goal.type === 'emergency_reserve',
  )
  const derivedReserveTarget =
    emergencyGoal?.targetCents ||
    allocationAmount(baseIncomeCents, originalAllocation.essential) *
      settings.reserveMonths
  const reserveCurrentCents = emergencyGoal?.currentCents ?? 0
  const reserveComplete =
    derivedReserveTarget > 0 && reserveCurrentCents >= derivedReserveTarget
  const effectiveAllocation = selectedBudget
    ? {
        essential: selectedBudget.essentialBps,
        lifestyle: selectedBudget.lifestyleBps,
        investment: selectedBudget.effectiveInvestmentBps,
        reserve: selectedBudget.effectiveReserveBps,
      }
    : resolveEffectiveAllocation(
        originalAllocation,
        reserveComplete,
        settings.keepReserveContributions,
      )

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
  let netWorthCents = 0
  let missingBalanceConversionCount = 0
  for (const account of accounts) {
    if (!isFamilyScope(account.scope?.type)) {
      continue
    }
    const converted = convertToBaseCurrency(
      account.balanceCents,
      account.currency,
    )
    if (converted === null) {
      if (account.balanceCents !== 0) missingBalanceConversionCount += 1
    } else {
      netWorthCents += converted
    }
  }
  for (const card of cards) {
    if (!isFamilyScope(card.scope?.type)) {
      continue
    }
    const converted = convertToBaseCurrency(
      card.outstandingCents,
      card.currency,
    )
    if (converted === null) {
      if (card.outstandingCents !== 0) missingBalanceConversionCount += 1
    } else {
      netWorthCents -= converted
    }
  }

  const acceptedRecurrenceMatches = recurrenceMatchRows.filter((match) =>
    isAcceptedRecurrenceMatchStatus(match.status),
  )
  let missingRecurrenceConversionCount = 0
  const recurrenceActuals = acceptedRecurrenceMatches.flatMap((match) => {
    const occurrence = recurrenceOccurrenceRows.find(
      (item) => item.id === match.occurrenceId,
    )
    const transaction = transactions.find(
      (item) => item.id === match.transactionId,
    )
    const category = occurrence
      ? categoriesById.get(occurrence.categoryId)
      : undefined
    const amountCents = transaction ? amountInBaseCurrency(transaction) : null
    const ownershipScopeId =
      transaction?.account?.ownershipScopeId ??
      transaction?.creditCard?.ownershipScopeId
    const scopeType = ownershipScopeId
      ? scopeById.get(ownershipScopeId)?.type
      : null
    const companyTransaction = !isFamilyScope(scopeType)
    if (
      transaction?.postedAt.startsWith(currentMonth) &&
      companyTransaction &&
      amountCents === null &&
      (category?.bucket === 'essential' || category?.bucket === 'lifestyle')
    ) {
      missingRecurrenceConversionCount += 1
    }
    if (
      !transaction ||
      amountCents === null ||
      (category?.bucket !== 'essential' && category?.bucket !== 'lifestyle')
    ) {
      return []
    }
    return [
      {
        transactionId: transaction.id,
        amountCents: Math.abs(amountCents),
        bucket: category.bucket,
        categoryConflict: match.categoryConflict,
      },
    ]
  })
  const reconciliationsForSummary = reconciliationRows.map((group) => ({
    type: group.type,
    status: group.status,
    transactionIds: reconciliationLinkRows
      .filter((link) => link.groupId === group.id)
      .map((link) => link.transactionId),
  }))
  const projectedPendingTransactionIds = new Set<string>()
  const projectedPendingByOccurrenceId = new Map<
    string,
    (typeof transactions)[number]
  >()
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
    const recurrence = recurrenceRows.find(
      (item) => item.id === occurrence.recurrenceId,
    )
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
  const projectedRecurrenceAmountByOccurrenceId = new Map<string, number>()
  let missingRecurrenceProjectionConversionCount = 0
  for (const occurrence of recurrenceOccurrenceRows) {
    const recurrence = recurrenceRows.find(
      (item) => item.id === occurrence.recurrenceId,
    )
    const category = categoriesById.get(occurrence.categoryId)
    if (
      !recurrence?.active ||
      occurrence.status !== 'expected' ||
      !occurrence.expectedDate.startsWith(currentMonth) ||
      (category?.bucket !== 'essential' && category?.bucket !== 'lifestyle')
    ) {
      continue
    }
    const pendingTransaction = projectedPendingByOccurrenceId.get(occurrence.id)
    const converted = convertToBaseCurrency(
      pendingTransaction
        ? Math.abs(pendingTransaction.amountCents)
        : occurrence.expectedAmountCents,
      occurrence.currency,
    )
    if (converted === null) {
      // Projeções usam a cotação mais recente. O valor-base persistido continua
      // autoritativo para o realizado, mas não substitui uma cotação projetiva.
      const genericSummaryCountsMissingConversion = Boolean(
        pendingTransaction?.postedAt.startsWith(currentMonth) &&
        amountInBaseCurrency(pendingTransaction) === null,
      )
      if (!genericSummaryCountsMissingConversion) {
        missingRecurrenceProjectionConversionCount += 1
      }
      continue
    }
    projectedRecurrenceAmountByOccurrenceId.set(occurrence.id, converted)
  }
  const financialSummary = buildFinancialSummary({
    month: currentMonth,
    transactions: transactions.map((transaction) => {
      const ownershipScopeId =
        transaction.account?.ownershipScopeId ??
        transaction.creditCard?.ownershipScopeId
      return {
        id: transaction.id,
        postedAt: transaction.postedAt,
        amountCents: amountInBaseCurrency(transaction),
        status: transaction.status,
        categoryId: transaction.categoryId,
        bucket: transaction.category?.bucket ?? null,
        incomeBaseEligible: transaction.category?.incomeBaseEligible ?? false,
        scopeType: ownershipScopeId
          ? (scopeById.get(ownershipScopeId)?.type ?? null)
          : null,
        accountPurpose: transaction.account?.purpose ?? null,
      }
    }),
    splits: transactionSplitRows.flatMap((split) => {
      const transaction = transactions.find(
        (item) => item.id === split.transactionId,
      )
      const category = categoriesById.get(split.categoryId)
      if (!transaction || !category) return []
      const baseAmount = amountInBaseCurrency(transaction)
      if (baseAmount === null) return []
      const ratio =
        transaction.amountCents === 0 ? 1 : baseAmount / transaction.amountCents
      return [
        {
          transactionId: split.transactionId,
          amountCents: Math.round(split.amountCents * ratio),
          bucket: category.bucket,
        },
      ]
    }),
    reconciliations: reconciliationsForSummary,
    recurrenceActuals,
    recurrenceCandidateTransactionIds: [
      ...recurrenceMatchRows
        .filter((match) => match.status === 'suggested')
        .map((match) => match.transactionId),
      ...projectedPendingTransactionIds,
    ],
    netWorthCents,
    missingBalanceConversionCount,
    missingRecurrenceConversionCount:
      missingRecurrenceConversionCount +
      missingRecurrenceProjectionConversionCount,
    reviewImportCount: importRows.filter((item) => item.status === 'review')
      .length,
    overdueRecurrenceCount: recurrenceRows.reduce(
      (count, recurrence) =>
        count +
        describeRecurrence(
          {
            active: recurrence.active,
            matchMode: recurrence.matchMode,
            frequency: recurrence.frequency,
            scheduleAnchor: recurrence.scheduleAnchor,
            occurrences: recurrenceOccurrenceRows
              .filter((occurrence) => occurrence.recurrenceId === recurrence.id)
              .map((occurrence) => ({
                ...occurrence,
                matches: recurrenceMatchRows.filter(
                  (match) => match.occurrenceId === occurrence.id,
                ),
              })),
          },
          { today: referenceDate },
        ).overdueOccurrences.length,
      0,
    ),
    unverifiedBalanceCount:
      accounts.filter(
        (account) =>
          isFamilyScope(account.scope?.type) && account.unverifiedDays > 0,
      ).length +
      cards.filter(
        (card) => isFamilyScope(card.scope?.type) && card.unverifiedDays > 0,
      ).length,
  })

  const budgetActual = financialSummary.budgetActual

  const budgetTargets = {
    essential: allocationAmount(baseIncomeCents, effectiveAllocation.essential),
    lifestyle: allocationAmount(baseIncomeCents, effectiveAllocation.lifestyle),
    investment: allocationAmount(
      baseIncomeCents,
      effectiveAllocation.investment,
    ),
    reserve: allocationAmount(baseIncomeCents, effectiveAllocation.reserve),
  }

  const budgetProjected = recurrenceOccurrenceRows.reduce(
    (result, occurrence) => {
      const category = categoriesById.get(occurrence.categoryId)
      const recurrence = recurrenceRows.find(
        (item) => item.id === occurrence.recurrenceId,
      )
      if (
        recurrence?.active &&
        occurrence.status === 'expected' &&
        occurrence.expectedDate.startsWith(currentMonth) &&
        (category?.bucket === 'essential' || category?.bucket === 'lifestyle')
      ) {
        result[category.bucket] +=
          projectedRecurrenceAmountByOccurrenceId.get(occurrence.id) ?? 0
      }
      return result
    },
    { essential: 0, lifestyle: 0, investment: 0, reserve: 0 },
  )
  budgetProjected.essential += financialSummary.budgetPending.essential
  budgetProjected.lifestyle += financialSummary.budgetPending.lifestyle

  return {
    scopes,
    institutions,
    accounts,
    cards,
    categories: categoryRows,
    transactions,
    strategies: strategyRows,
    monthlyBudgets: monthlyBudgetRows,
    goals: goalRows,
    contributions: contributionRows,
    reconciliations: reconciliationRows.map((group) => ({
      ...group,
      links: reconciliationLinkRows
        .filter((link) => link.groupId === group.id)
        .map((link) => ({
          ...link,
          transaction:
            transactions.find(
              (transaction) => transaction.id === link.transactionId,
            ) ?? null,
        })),
    })),
    checkpoints: checkpointRows,
    corrections: correctionRows.map((correction) => ({
      ...correction,
      observation:
        stagedRows.find(
          (staged) => staged.id === correction.stagedTransactionId,
        ) ?? null,
      transaction:
        transactions.find(
          (transaction) => transaction.id === correction.transactionId,
        ) ?? null,
    })),
    recurrenceGroups: recurrenceGroupRows,
    recurrences: recurrenceRows.map((recurrence) => ({
      ...recurrence,
      baseAmountCents: convertToBaseCurrency(
        recurrence.amountCents,
        recurrence.currency,
      ),
      occurrences: recurrenceOccurrenceRows
        .filter((occurrence) => occurrence.recurrenceId === recurrence.id)
        .map((occurrence) => ({
          ...occurrence,
          matches: recurrenceMatchRows
            .filter((match) => match.occurrenceId === occurrence.id)
            .map((match) => ({
              ...match,
              transaction:
                transactions.find(
                  (transaction) => transaction.id === match.transactionId,
                ) ?? null,
            })),
        })),
    })),
    installmentPlans: installmentRows.map((plan) => ({
      ...plan,
      commitmentType: classifyInstallmentCommitment(plan.totalInstallments),
    })),
    settings,
    dashboard: {
      currentMonth,
      netWorthCents: financialSummary.netWorthCents,
      currentIncomeCents: financialSummary.currentIncomeCents,
      currentExpenseCents: financialSummary.currentExpenseCents,
      reviewTransactionCount: stagedRows.filter(
        (staged) =>
          importRows.find((item) => item.id === staged.importId)?.status ===
          'review',
      ).length,
      reviewImportCount: importRows.filter((item) => item.status === 'review')
        .length,
      reconciliationCount: reconciliationRows.filter(
        (item) => item.status === 'suggested',
      ).length,
      baseIncomeCents,
      activeStrategy,
      originalAllocation,
      effectiveAllocation,
      budgetActual,
      budgetProjected,
      budgetTargets,
      integrity: financialSummary.integrity,
      reserve: {
        currentCents: reserveCurrentCents,
        targetCents: derivedReserveTarget,
        months: settings.reserveMonths,
        complete: reserveComplete,
        redirected:
          selectedBudget?.reserveRedirected ??
          (reserveComplete && originalAllocation.reserve > 0),
      },
    },
  }
}

export async function createOwnershipScope(input: {
  name: string
  type: Exclude<OwnershipScopeType, 'company_us'>
}) {
  await ensureDatabase()
  const row = { id: randomUUID(), ...input }
  await db.insert(schema.ownershipScopes).values(row)
  return row
}

async function findOrCreateInstitution(name: string) {
  const normalized = name.trim()
  const existing = await db
    .select()
    .from(schema.institutions)
    .where(sql`lower(${schema.institutions.name}) = lower(${normalized})`)
    .limit(1)
  if (existing[0]) return existing[0].id
  const id = randomUUID()
  await db.insert(schema.institutions).values({ id, name: normalized })
  return id
}

export async function createAccount(input: {
  name: string
  institutionName: string
  ownershipScopeId: string
  kind: 'checking' | 'savings' | 'cash' | 'investment'
  purpose: 'operating' | 'reserve' | 'investment'
  currency: string
  initialBalanceCents: number
}) {
  await ensureDatabase()
  const institutionId = await findOrCreateInstitution(input.institutionName)
  const row = {
    id: randomUUID(),
    name: input.name,
    institutionId,
    ownershipScopeId: input.ownershipScopeId,
    kind: input.kind,
    purpose: input.purpose,
    currency: input.currency,
    initialBalanceCents: input.initialBalanceCents,
  }
  await db.insert(schema.accounts).values(row)
  return row
}

export async function createManualBalanceCheckpoint(
  input: Parameters<typeof recordManualBalanceCheckpoint>[0],
) {
  const result = await recordManualBalanceCheckpoint(input)
  const reconciliationRefresh = await refreshReconciliationAfterCommit()
  return { ...result, reconciliationRefresh }
}

export async function createManualTransaction(input: {
  targetType: 'account' | 'card'
  targetId: string
  postedAt: string
  description: string
  direction: 'inflow' | 'outflow'
  amountCents: number
  categoryId?: string
  counterpartyAccountId?: string
  notes?: string
}) {
  await ensureDatabase()
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
    throw new Error('Informe um valor maior que zero.')
  }

  const description = input.description.trim()
  if (description.length < 2 || description.length > 200) {
    throw new Error('Informe uma descrição entre 2 e 200 caracteres.')
  }

  const targetRows =
    input.targetType === 'account'
      ? await db
          .select({
            currency: schema.accounts.currency,
            active: schema.accounts.active,
          })
          .from(schema.accounts)
          .where(eq(schema.accounts.id, input.targetId))
          .limit(1)
      : await db
          .select({
            currency: schema.creditCards.currency,
            active: schema.creditCards.active,
          })
          .from(schema.creditCards)
          .where(eq(schema.creditCards.id, input.targetId))
          .limit(1)
  const target = targetRows.at(0)
  if (!target?.active) throw new Error('Conta ou cartão não encontrado.')

  const categoryId = input.categoryId ?? 'uncategorized'
  const category = (
    await db
      .select({ active: schema.categories.active })
      .from(schema.categories)
      .where(eq(schema.categories.id, categoryId))
      .limit(1)
  ).at(0)
  if (!category?.active) throw new Error('Categoria não encontrada.')

  let counterpartyAccountId: string | null = null
  if (categoryId === 'transfer') {
    if (input.targetType !== 'account') {
      throw new Error('Transferências manuais precisam partir de uma conta.')
    }
    if (!input.counterpartyAccountId) {
      throw new Error('Selecione a outra conta da transferência.')
    }
    if (input.counterpartyAccountId === input.targetId) {
      throw new Error('A outra ponta deve usar uma conta diferente.')
    }
    const counterparty = (
      await db
        .select({ active: schema.accounts.active })
        .from(schema.accounts)
        .where(eq(schema.accounts.id, input.counterpartyAccountId))
        .limit(1)
    ).at(0)
    if (!counterparty?.active) {
      throw new Error('A outra conta da transferência não foi encontrada.')
    }
    counterpartyAccountId = input.counterpartyAccountId
  } else if (input.counterpartyAccountId) {
    throw new Error(
      'A outra conta só pode ser informada em uma transferência interna.',
    )
  }

  const amountCents =
    input.direction === 'inflow' ? input.amountCents : -input.amountCents
  const id = randomUUID()
  const normalizedDescription = normalizeDescription(description)
  const notes = input.notes?.trim() || null
  const inBaseCurrency = target.currency === 'BRL'
  const transactionResult = db.transaction((transaction) => {
    transaction
      .insert(schema.transactions)
      .values({
        id,
        importId: null,
        accountId: input.targetType === 'account' ? input.targetId : null,
        creditCardId: input.targetType === 'card' ? input.targetId : null,
        categoryId,
        counterpartyAccountId,
        externalId: null,
        sourceKey: `manual:${id}`,
        fingerprint: transactionFingerprint({
          postedAt: input.postedAt,
          amountCents,
          description,
          currency: target.currency,
        }),
        postedAt: input.postedAt,
        description,
        normalizedDescription,
        amountCents,
        currency: target.currency,
        baseAmountCents: inBaseCurrency ? amountCents : null,
        baseCurrency: 'BRL',
        exchangeRateMicros: inBaseCurrency ? 1_000_000 : null,
        status: 'confirmed',
        notes,
      })
      .run()

    const checkpointUpdate = invalidateCheckpointChain(transaction, {
      targetType: input.targetType,
      targetId: input.targetId,
      from: input.postedAt,
      reason: `Reaberto pelo lançamento manual ${id}.`,
    })
    refreshStatementAnchor(transaction, {
      targetType: input.targetType,
      targetId: input.targetId,
      balanceType: input.targetType === 'account' ? 'posted' : 'card_statement',
    })
    if (input.targetType === 'card') {
      transaction
        .update(schema.cardStatementCycles)
        .set({ status: 'closed' })
        .where(
          and(
            eq(schema.cardStatementCycles.creditCardId, input.targetId),
            gte(schema.cardStatementCycles.periodEnd, input.postedAt),
          ),
        )
        .run()
    }
    return { reopenedCheckpoints: checkpointUpdate.changes }
  })

  const reconciliationRefresh = await refreshReconciliationAfterCommit()
  return {
    id,
    amountCents,
    currency: target.currency,
    ...transactionResult,
    reconciliationRefresh,
  }
}

async function refreshStatementResolutionState(importId: string) {
  const importRows = await db
    .select()
    .from(schema.imports)
    .where(eq(schema.imports.id, importId))
    .limit(1)
  const importRow = importRows.at(0)
  if (
    !importRow ||
    importRow.status !== 'review' ||
    importRow.parser !== 'pdf_inspector' ||
    !importRow.creditCardId ||
    !importRow.periodStart ||
    !importRow.periodEnd
  ) {
    return null
  }

  const [observations, transactions] = await Promise.all([
    db
      .select({
        postedAt: schema.stagedTransactions.postedAt,
        amountCents: schema.stagedTransactions.amountCents,
        currency: schema.stagedTransactions.currency,
      })
      .from(schema.stagedTransactions)
      .where(eq(schema.stagedTransactions.importId, importId)),
    db
      .select({
        postedAt: schema.transactions.postedAt,
        amountCents: schema.transactions.amountCents,
        currency: schema.transactions.currency,
        status: schema.transactions.status,
      })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.creditCardId, importRow.creditCardId),
          gte(schema.transactions.postedAt, importRow.periodStart),
          lte(schema.transactions.postedAt, importRow.periodEnd),
        ),
      ),
  ])

  const observationCounts = new Map<string, number>()
  for (const observation of observations) {
    const signature = statementValueSignature(observation)
    observationCounts.set(
      signature,
      (observationCounts.get(signature) ?? 0) + 1,
    )
  }

  let unresolvedCount = 0
  for (const transaction of transactions.filter(
    (item) => item.status !== 'excluded',
  )) {
    const signature = statementValueSignature(transaction)
    const available = observationCounts.get(signature) ?? 0
    if (available > 0) observationCounts.set(signature, available - 1)
    else unresolvedCount += 1
  }

  const audit = evaluateImportAudit({
    targetType: 'card',
    sourceTransactionCount: importRow.sourceTransactionCount,
    parsedTransactionCount: importRow.parsedTransactionCount,
    invalidTransactionCount: importRow.invalidTransactionCount,
    openingBalanceCents: importRow.openingBalanceCents,
    openingBalanceAt: importRow.openingBalanceAt,
    closingBalanceCents: importRow.closingBalanceCents,
    balanceAsOf: importRow.balanceAsOf,
    statementPeriodStart: importRow.periodStart,
    anchorBalanceCents: null,
    anchorBalanceAt: null,
    existingMovementCents: 0,
    newMovementCents: observations.reduce(
      (total, observation) => total + observation.amountCents,
      0,
    ),
  })
  const auditResolved = audit.status === 'reconciled'

  await db
    .update(schema.imports)
    .set(
      unresolvedCount > 0 || !auditResolved
        ? {
            validationStatus: 'divergent',
            validationMessage:
              unresolvedCount > 0
                ? `${unresolvedCount} lançamento(s) anterior(es) ainda não correspondem à fatura definitiva. Resolva todas as diferenças antes de consolidar.`
                : `${audit.message} Confira no PDF o total da fatura e se todas as linhas foram lidas; rejeite o arquivo se os valores continuarem diferentes.`,
          }
        : {
            validationStatus: 'reconciled',
            validationMessage:
              'Todas as diferenças da fatura foram resolvidas. Revise as categorias e consolide para concluir o fechamento.',
          },
    )
    .where(eq(schema.imports.id, importId))

  return { unresolvedCount, auditResolved }
}

export async function resolveStatementExclusion(input: {
  importId: string
  transactionId: string
  action: 'exclude' | 'restore'
}) {
  await ensureDatabase()
  const rows = await db
    .select({ import: schema.imports, transaction: schema.transactions })
    .from(schema.imports)
    .innerJoin(
      schema.transactions,
      eq(schema.transactions.id, input.transactionId),
    )
    .where(eq(schema.imports.id, input.importId))
    .limit(1)
  const row = rows.at(0)
  if (
    !row ||
    row.import.parser !== 'pdf_inspector' ||
    !row.import.creditCardId ||
    row.transaction.creditCardId !== row.import.creditCardId ||
    !row.import.periodStart ||
    !row.import.periodEnd ||
    row.transaction.postedAt < row.import.periodStart ||
    row.transaction.postedAt > row.import.periodEnd
  ) {
    throw new Error('Este lançamento não pertence ao ciclo desta fatura.')
  }
  const exclusions = await db
    .select()
    .from(schema.statementExclusions)
    .where(
      and(
        eq(schema.statementExclusions.importId, input.importId),
        eq(schema.statementExclusions.transactionId, input.transactionId),
      ),
    )
    .limit(1)
  const exclusion = exclusions.at(0)
  if (input.action === 'exclude') {
    if (
      row.import.status !== 'review' ||
      row.transaction.status !== 'pending'
    ) {
      throw new Error(
        'Somente um lançamento pendente de uma fatura em revisão pode ser marcado como ausente.',
      )
    }
    const [statementRows, pendingRows] = await Promise.all([
      db
        .select({
          postedAt: schema.stagedTransactions.postedAt,
          amountCents: schema.stagedTransactions.amountCents,
          currency: schema.stagedTransactions.currency,
        })
        .from(schema.stagedTransactions)
        .where(eq(schema.stagedTransactions.importId, input.importId)),
      db
        .select({
          id: schema.transactions.id,
          postedAt: schema.transactions.postedAt,
          amountCents: schema.transactions.amountCents,
          currency: schema.transactions.currency,
        })
        .from(schema.transactions)
        .where(
          and(
            eq(schema.transactions.creditCardId, row.import.creditCardId),
            eq(schema.transactions.status, 'pending'),
            gte(schema.transactions.postedAt, row.import.periodStart),
            lte(schema.transactions.postedAt, row.import.periodEnd),
          ),
        )
        .orderBy(schema.transactions.id),
    ])
    const statementCounts = new Map<string, number>()
    for (const item of statementRows) {
      const signature = statementValueSignature(item)
      statementCounts.set(signature, (statementCounts.get(signature) ?? 0) + 1)
    }
    const missingIds: string[] = []
    for (const item of pendingRows) {
      const signature = statementValueSignature(item)
      const available = statementCounts.get(signature) ?? 0
      if (available > 0) statementCounts.set(signature, available - 1)
      else missingIds.push(item.id)
    }
    if (!missingIds.includes(input.transactionId)) {
      throw new Error(
        'Este lançamento consta na fatura e não pode ser marcado como ausente.',
      )
    }
    db.transaction((transaction) => {
      transaction
        .insert(schema.statementExclusions)
        .values({
          id: exclusion?.id ?? randomUUID(),
          importId: input.importId,
          transactionId: input.transactionId,
          previousStatus: 'pending',
          reason:
            'O usuário confirmou que a autorização pendente não consta na fatura definitiva.',
          reversedAt: null,
        })
        .onConflictDoUpdate({
          target: [
            schema.statementExclusions.importId,
            schema.statementExclusions.transactionId,
          ],
          set: { reversedAt: null },
        })
        .run()
      transaction
        .update(schema.transactions)
        .set({ status: 'excluded' })
        .where(eq(schema.transactions.id, input.transactionId))
        .run()
      transaction
        .update(schema.imports)
        .set({
          validationStatus: 'imported',
          validationMessage:
            'Autorização ausente da fatura marcada como cancelada. Consolide para conferir novamente o ciclo.',
        })
        .where(eq(schema.imports.id, input.importId))
        .run()
    })
    await refreshStatementResolutionState(input.importId)
    return { success: true }
  }

  if (!exclusion || exclusion.reversedAt) return { success: true }
  db.transaction((transaction) => {
    transaction
      .update(schema.statementExclusions)
      .set({ reversedAt: new Date() })
      .where(eq(schema.statementExclusions.id, exclusion.id))
      .run()
    transaction
      .update(schema.transactions)
      .set({ status: 'pending' })
      .where(eq(schema.transactions.id, input.transactionId))
      .run()
    transaction
      .update(schema.imports)
      .set({
        status: 'review',
        validationStatus: 'divergent',
        validationMessage:
          'A exclusão foi desfeita. Resolva novamente a diferença antes de consolidar.',
      })
      .where(eq(schema.imports.id, input.importId))
      .run()
    if (row.import.batchId) {
      transaction
        .update(schema.importBatches)
        .set({ status: 'review' })
        .where(eq(schema.importBatches.id, row.import.batchId))
        .run()
    }
    transaction
      .update(schema.cardStatementCycles)
      .set({ status: 'closed' })
      .where(
        and(
          eq(schema.cardStatementCycles.creditCardId, row.import.creditCardId!),
          lte(schema.cardStatementCycles.periodStart, row.transaction.postedAt),
          gte(schema.cardStatementCycles.periodEnd, row.transaction.postedAt),
        ),
      )
      .run()
    invalidateCheckpointChain(transaction, {
      targetType: 'card',
      targetId: row.import.creditCardId!,
      from: row.transaction.postedAt,
      reason:
        'A exclusão de uma autorização ausente foi desfeita pelo usuário.',
    })
    refreshStatementAnchor(transaction, {
      targetType: 'card',
      targetId: row.import.creditCardId!,
      balanceType: 'card_statement',
    })
  })
  await refreshStatementResolutionState(input.importId)
  return { success: true }
}

export async function linkStatementObservation(input: {
  stagedTransactionId: string
  transactionId: string
}) {
  await ensureDatabase()
  const rows = await db
    .select({
      staged: schema.stagedTransactions,
      import: schema.imports,
      transaction: schema.transactions,
    })
    .from(schema.stagedTransactions)
    .innerJoin(
      schema.imports,
      eq(schema.imports.id, schema.stagedTransactions.importId),
    )
    .innerJoin(
      schema.transactions,
      eq(schema.transactions.id, input.transactionId),
    )
    .where(eq(schema.stagedTransactions.id, input.stagedTransactionId))
    .limit(1)
  const row = rows.at(0)
  if (
    !row ||
    row.import.status !== 'review' ||
    row.import.parser !== 'pdf_inspector' ||
    !row.import.creditCardId ||
    row.transaction.creditCardId !== row.import.creditCardId ||
    row.transaction.status === 'excluded' ||
    row.transaction.importId === row.import.id
  ) {
    throw new Error('Este vínculo não é válido para a fatura em revisão.')
  }
  if (row.transaction.currency !== row.staged.currency) {
    throw new Error('Vincule apenas lançamentos na mesma moeda.')
  }
  if (
    !row.import.periodStart ||
    !row.import.periodEnd ||
    row.transaction.postedAt < row.import.periodStart ||
    row.transaction.postedAt > row.import.periodEnd
  ) {
    throw new Error(
      'O lançamento escolhido está fora do período confirmado da fatura.',
    )
  }
  const reservations = await db
    .select({
      correction: schema.transactionCorrections,
      staged: schema.stagedTransactions,
    })
    .from(schema.transactionCorrections)
    .innerJoin(
      schema.stagedTransactions,
      eq(
        schema.stagedTransactions.id,
        schema.transactionCorrections.stagedTransactionId,
      ),
    )
    .where(eq(schema.transactionCorrections.transactionId, row.transaction.id))
  const evidenceReservations = await db
    .select({ staged: schema.stagedTransactions })
    .from(schema.transactionEvidence)
    .innerJoin(
      schema.stagedTransactions,
      eq(
        schema.stagedTransactions.id,
        schema.transactionEvidence.stagedTransactionId,
      ),
    )
    .where(eq(schema.transactionEvidence.transactionId, row.transaction.id))
  if (
    reservations.some(
      (reservation) =>
        reservation.staged.importId === row.import.id &&
        reservation.staged.id !== row.staged.id &&
        reservation.correction.status !== 'rejected',
    ) ||
    evidenceReservations.some(
      (reservation) =>
        reservation.staged.importId === row.import.id &&
        reservation.staged.id !== row.staged.id,
    )
  ) {
    throw new Error(
      'Este lançamento já foi vinculado a outra linha desta fatura.',
    )
  }
  const existing = await db
    .select()
    .from(schema.transactionCorrections)
    .where(
      eq(
        schema.transactionCorrections.stagedTransactionId,
        input.stagedTransactionId,
      ),
    )
    .limit(1)
  if (existing[0]?.status === 'accepted') return { success: true }

  const correctionId = existing[0]?.id ?? randomUUID()
  const values = {
    transactionId: row.transaction.id,
    previousJson: JSON.stringify({
      postedAt: row.transaction.postedAt,
      description: row.transaction.description,
      amountCents: row.transaction.amountCents,
      currency: row.transaction.currency,
      fingerprint: row.transaction.fingerprint,
    }),
    proposedJson: JSON.stringify({
      postedAt: row.staged.postedAt,
      description: row.staged.description,
      amountCents: row.staged.amountCents,
      currency: row.staged.currency,
      fingerprint: row.staged.fingerprint,
    }),
    status: 'pending' as const,
    resolvedAt: null,
  }
  if (existing[0]) {
    await db
      .update(schema.transactionCorrections)
      .set(values)
      .where(eq(schema.transactionCorrections.id, correctionId))
  } else {
    await db.insert(schema.transactionCorrections).values({
      id: correctionId,
      stagedTransactionId: input.stagedTransactionId,
      ...values,
    })
  }
  await resolveTransactionCorrection({
    correctionId,
    action: 'accept',
  })
  return { success: true }
}

export async function resolveTransactionCorrection(input: {
  correctionId: string
  action: 'accept' | 'reject'
}) {
  await ensureDatabase()
  const rows = await db
    .select({
      correction: schema.transactionCorrections,
      staged: schema.stagedTransactions,
      transaction: schema.transactions,
    })
    .from(schema.transactionCorrections)
    .innerJoin(
      schema.stagedTransactions,
      eq(
        schema.stagedTransactions.id,
        schema.transactionCorrections.stagedTransactionId,
      ),
    )
    .innerJoin(
      schema.transactions,
      eq(schema.transactions.id, schema.transactionCorrections.transactionId),
    )
    .where(eq(schema.transactionCorrections.id, input.correctionId))
    .limit(1)
  const row = rows.at(0)
  if (!row) throw new Error('Correção não encontrada.')
  if (row.correction.status !== 'pending') return { success: true }

  const affectedFrom =
    row.staged.postedAt < row.transaction.postedAt
      ? row.staged.postedAt
      : row.transaction.postedAt
  const cachedRates =
    input.action === 'accept' && row.staged.currency !== 'BRL'
      ? await db
          .select({ rateMicros: schema.exchangeRates.rateMicros })
          .from(schema.exchangeRates)
          .where(
            and(
              eq(schema.exchangeRates.date, row.staged.postedAt.slice(0, 10)),
              eq(schema.exchangeRates.fromCurrency, row.staged.currency),
              eq(schema.exchangeRates.toCurrency, 'BRL'),
            ),
          )
          .limit(1)
      : []
  const exchangeRateMicros =
    row.staged.currency === 'BRL'
      ? 1_000_000
      : (cachedRates[0]?.rateMicros ?? null)
  const baseAmountCents = exchangeRateMicros
    ? convertMinorUnitsAtRate(
        row.staged.amountCents,
        row.staged.currency,
        'BRL',
        exchangeRateMicros,
      )
    : null
  const affectedGroups = await db
    .select({ groupId: schema.reconciliationLinks.groupId })
    .from(schema.reconciliationLinks)
    .where(eq(schema.reconciliationLinks.transactionId, row.transaction.id))
  const linkedGroups = affectedGroups.length
    ? await db
        .select({
          groupId: schema.reconciliationLinks.groupId,
          transactionId: schema.reconciliationLinks.transactionId,
          previousCategoryId: schema.reconciliationLinks.previousCategoryId,
          status: schema.reconciliationGroups.status,
        })
        .from(schema.reconciliationLinks)
        .innerJoin(
          schema.reconciliationGroups,
          eq(
            schema.reconciliationGroups.id,
            schema.reconciliationLinks.groupId,
          ),
        )
        .where(
          inArray(
            schema.reconciliationLinks.groupId,
            affectedGroups.map((item) => item.groupId),
          ),
        )
    : []

  db.transaction((transaction) => {
    if (input.action === 'accept') {
      transaction
        .update(schema.transactions)
        .set({
          externalId: row.staged.externalId ?? row.transaction.externalId,
          fingerprint: row.staged.fingerprint,
          postedAt: row.staged.postedAt,
          description: row.staged.description,
          normalizedDescription: row.staged.normalizedDescription,
          amountCents: row.staged.amountCents,
          currency: row.staged.currency,
          baseAmountCents,
          exchangeRateMicros,
        })
        .where(eq(schema.transactions.id, row.transaction.id))
        .run()
      if (linkedGroups.length) {
        for (const link of linkedGroups) {
          if (link.status !== 'confirmed') continue
          transaction
            .update(schema.transactions)
            .set({ categoryId: link.previousCategoryId })
            .where(eq(schema.transactions.id, link.transactionId))
            .run()
        }
        transaction
          .update(schema.reconciliationGroups)
          .set({
            status: 'suggested',
            aiValidation: null,
            aiConfidence: null,
            aiReason: null,
            aiValidatedAt: null,
            reason: 'Reaberta porque uma movimentação vinculada foi corrigida.',
          })
          .where(
            inArray(
              schema.reconciliationGroups.id,
              linkedGroups.map((item) => item.groupId),
            ),
          )
          .run()
      }
      if (row.transaction.creditCardId) {
        transaction
          .update(schema.cardStatementCycles)
          .set({ status: 'closed' })
          .where(
            and(
              eq(
                schema.cardStatementCycles.creditCardId,
                row.transaction.creditCardId,
              ),
              gte(schema.cardStatementCycles.periodEnd, affectedFrom),
            ),
          )
          .run()
      }
      invalidateCheckpointChain(transaction, {
        targetType: row.transaction.accountId ? 'account' : 'card',
        targetId: row.transaction.accountId ?? row.transaction.creditCardId!,
        from: affectedFrom,
        reason:
          'Uma correção aceita alterou uma movimentação anterior a este ponto de controle.',
      })
      refreshStatementAnchor(transaction, {
        targetType: row.transaction.accountId ? 'account' : 'card',
        targetId: row.transaction.accountId ?? row.transaction.creditCardId!,
        balanceType: row.transaction.accountId ? 'posted' : 'card_statement',
      })
      transaction
        .update(schema.imports)
        .set({
          validationStatus: 'imported',
          validationMessage:
            'Correção aplicada e checkpoints posteriores reabertos para conferência.',
        })
        .where(eq(schema.imports.id, row.staged.importId))
        .run()
      linkCanonicalObservation(transaction, {
        stagedTransactionId: row.staged.id,
        transactionId: row.transaction.id,
        matchKind: 'manual_correction',
      })
    } else {
      transaction
        .update(schema.imports)
        .set({
          status: 'review',
          validationStatus: 'imported',
          validationMessage:
            'A correção proposta foi rejeitada. O lançamento original foi preservado e a nova observação ficou na auditoria.',
        })
        .where(eq(schema.imports.id, row.staged.importId))
        .run()
      linkCanonicalObservation(transaction, {
        stagedTransactionId: row.staged.id,
        transactionId: row.transaction.id,
        matchKind: 'rejected_correction',
      })
    }
    transaction
      .update(schema.transactionCorrections)
      .set({
        status: input.action === 'accept' ? 'accepted' : 'rejected',
        resolvedAt: new Date(),
      })
      .where(eq(schema.transactionCorrections.id, input.correctionId))
      .run()
  })
  if (input.action === 'accept') {
    await refreshStatementResolutionState(row.staged.importId)
  }
  return { success: true }
}

export async function updateAccount(input: {
  id: string
  name: string
  institutionName: string
  ownershipScopeId: string
  kind: 'checking' | 'savings' | 'cash' | 'investment'
  purpose: 'operating' | 'reserve' | 'investment'
  currency: string
}) {
  await ensureDatabase()
  const institutionId = await findOrCreateInstitution(input.institutionName)
  const { id, institutionName: _institutionName, ...values } = input
  const updated = await db
    .update(schema.accounts)
    .set({ ...values, institutionId })
    .where(eq(schema.accounts.id, id))
    .returning({ id: schema.accounts.id })

  if (!updated[0]) throw new Error('Conta não encontrada.')
  return { id }
}

export async function createCreditCard(input: {
  name: string
  institutionName: string
  ownershipScopeId: string
  currency: string
  lastFour?: string
  limitCents: number
  closingDay: number
  dueDay?: number
}) {
  await ensureDatabase()
  const institutionId = await findOrCreateInstitution(input.institutionName)
  const row = {
    id: randomUUID(),
    ...input,
    lastFour: input.lastFour || null,
    dueDay: input.dueDay ?? null,
    institutionId,
  }
  await db.insert(schema.creditCards).values(row)
  return row
}

export async function updateCreditCard(input: {
  id: string
  name: string
  institutionName: string
  ownershipScopeId: string
  currency: string
  lastFour?: string
  limitCents: number
  closingDay: number
  dueDay?: number
}) {
  await ensureDatabase()
  const institutionId = await findOrCreateInstitution(input.institutionName)
  const { id, institutionName: _institutionName, ...values } = input
  const updated = await db
    .update(schema.creditCards)
    .set({
      ...values,
      lastFour: values.lastFour || null,
      dueDay: values.dueDay ?? null,
      institutionId,
    })
    .where(eq(schema.creditCards.id, id))
    .returning({ id: schema.creditCards.id })

  if (!updated[0]) throw new Error('Cartão não encontrado.')
  return { id }
}

export async function updateSettings(input: {
  monthlyIncomeTargetCents: number
  reserveMonths: number
  keepReserveContributions: boolean
  aiClassificationConsent: boolean
}) {
  await ensureDatabase()
  await db
    .update(schema.appSettings)
    .set(input)
    .where(eq(schema.appSettings.id, 'default'))
  if (input.aiClassificationConsent) {
    await refreshReconciliationAfterCommit()
  }
  return input
}

export async function activateStrategy(input: {
  strategyId: string
  essentialBps: number
  lifestyleBps: number
  investmentBps: number
  reserveBps: number
}) {
  await ensureDatabase()
  strategyAllocationSchema.parse({
    essential: input.essentialBps,
    lifestyle: input.lifestyleBps,
    investment: input.investmentBps,
    reserve: input.reserveBps,
  })

  const currentMonth = new Date().toISOString().slice(0, 7)
  const closed = await db
    .select()
    .from(schema.monthlyBudgets)
    .where(
      and(
        eq(schema.monthlyBudgets.month, currentMonth),
        eq(schema.monthlyBudgets.closed, true),
      ),
    )
    .limit(1)
  if (closed.length) throw new Error('O orçamento deste mês já está fechado.')

  db.transaction((transaction) => {
    transaction.update(schema.budgetStrategies).set({ isDefault: false }).run()
    transaction
      .update(schema.budgetStrategies)
      .set({
        isDefault: true,
        essentialBps: input.essentialBps,
        lifestyleBps: input.lifestyleBps,
        investmentBps: input.investmentBps,
        reserveBps: input.reserveBps,
      })
      .where(eq(schema.budgetStrategies.id, input.strategyId))
      .run()
  })
  return input
}

export async function saveGoal(input: {
  id?: string
  name: string
  type: 'emergency_reserve' | 'medium_term' | 'retirement' | 'other'
  targetCents: number
  currentCents: number
  targetDate?: string
}) {
  await ensureDatabase()
  const id = input.id || randomUUID()
  await db
    .insert(schema.investmentGoals)
    .values({
      id,
      name: input.name,
      type: input.type,
      targetCents: input.targetCents,
      currentCents: input.currentCents,
      targetDate: input.targetDate || null,
    })
    .onConflictDoUpdate({
      target: schema.investmentGoals.id,
      set: {
        name: input.name,
        type: input.type,
        targetCents: input.targetCents,
        currentCents: input.currentCents,
        targetDate: input.targetDate || null,
      },
    })
  return { id }
}

export async function addGoalContribution(input: {
  goalId: string
  amountCents: number
  contributedAt: string
  notes?: string
}) {
  await ensureDatabase()
  db.transaction((transaction) => {
    transaction
      .insert(schema.goalContributions)
      .values({
        id: randomUUID(),
        goalId: input.goalId,
        amountCents: input.amountCents,
        contributedAt: input.contributedAt,
        notes: input.notes || null,
      })
      .run()
    transaction
      .update(schema.investmentGoals)
      .set({
        currentCents: sql`${schema.investmentGoals.currentCents} + ${input.amountCents}`,
      })
      .where(eq(schema.investmentGoals.id, input.goalId))
      .run()
  })
  return { success: true }
}

export async function updateTransactionCategory(input: {
  transactionId: string
  categoryId: string
  saveRule: boolean
  counterpartyAccountId?: string | null
}) {
  await ensureDatabase()
  const transaction = await db
    .select()
    .from(schema.transactions)
    .where(eq(schema.transactions.id, input.transactionId))
    .limit(1)
  if (!transaction[0]) throw new Error('Transação não encontrada.')
  const source = transaction[0]
  const counterpartyAccountId =
    input.categoryId === 'transfer'
      ? (input.counterpartyAccountId ?? null)
      : null
  if (counterpartyAccountId) {
    if (!source.accountId) {
      throw new Error('Somente lançamentos de conta podem ser transferências.')
    }
    if (counterpartyAccountId === source.accountId) {
      throw new Error('Escolha uma conta diferente da conta de origem.')
    }
    const counterparty = await db
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, counterpartyAccountId))
      .limit(1)
    if (!counterparty[0]) throw new Error('Conta relacionada inválida.')
  }

  db.transaction((tx) => {
    tx.update(schema.transactions)
      .set({ categoryId: input.categoryId, counterpartyAccountId })
      .where(eq(schema.transactions.id, input.transactionId))
      .run()
    noteTransactionCategoryChanged(tx, {
      transactionId: input.transactionId,
      categoryId: input.categoryId,
    })
    if (counterpartyAccountId && source.accountId) {
      const direction = source.amountCents < 0 ? 'outgoing' : 'incoming'
      tx.insert(schema.categorizationRules)
        .values({
          id: randomUUID(),
          pattern: source.normalizedDescription,
          accountId: source.accountId,
          counterpartyAccountId,
          direction,
          categoryId: 'transfer',
          priority: 5,
        })
        .onConflictDoUpdate({
          target: [
            schema.categorizationRules.pattern,
            schema.categorizationRules.accountId,
            schema.categorizationRules.direction,
          ],
          set: {
            counterpartyAccountId,
            categoryId: 'transfer',
            priority: 5,
            active: true,
          },
        })
        .run()
    }
    if (input.saveRule) {
      tx.insert(schema.categorizationRules)
        .values({
          id: randomUUID(),
          pattern: transaction[0].normalizedDescription,
          accountId: transaction[0].accountId,
          categoryId: input.categoryId,
          priority: 10,
        })
        .run()
    }
  })
  if (counterpartyAccountId) await refreshReconciliationAfterCommit()
  return { success: true }
}

export async function categorizeUncategorizedTransactionsWithAi() {
  await ensureDatabase()
  const settings = await db.select().from(schema.appSettings).limit(1)
  if (!settings[0]?.aiClassificationConsent) {
    throw new Error(
      'Ative “Permitir sugestões de categoria por IA” em Configurações.',
    )
  }
  if (!process.env.OPENROUTER_API_KEY || !process.env.OPENROUTER_MODEL) {
    throw new Error('O OpenRouter não está configurado no servidor.')
  }

  const uncategorizedFilter = and(
    eq(schema.transactions.status, 'confirmed'),
    or(
      isNull(schema.transactions.categoryId),
      eq(schema.transactions.categoryId, 'uncategorized'),
    ),
  )
  const [candidates, categories, totalRows] = await Promise.all([
    db
      .select({
        id: schema.transactions.id,
        accountId: schema.transactions.accountId,
        creditCardId: schema.transactions.creditCardId,
        description: schema.transactions.description,
        amountCents: schema.transactions.amountCents,
        currency: schema.transactions.currency,
      })
      .from(schema.transactions)
      .where(uncategorizedFilter)
      .orderBy(desc(schema.transactions.postedAt))
      .limit(500),
    db
      .select({
        id: schema.categories.id,
        name: schema.categories.name,
        bucket: schema.categories.bucket,
      })
      .from(schema.categories)
      .where(eq(schema.categories.active, true)),
    db
      .select({ count: sql<number>`count(*)` })
      .from(schema.transactions)
      .where(uncategorizedFilter),
  ])
  const total = Number(totalRows[0]?.count ?? 0)
  if (!candidates.length) {
    return { processed: 0, categorized: 0, remaining: 0 }
  }

  const allowedCategories = categories.filter(
    (category) => category.bucket !== 'excluded',
  )
  let suggestions
  try {
    suggestions = await categorizeTransactionsWithAi(
      candidates.map((transaction) => ({
        id: transaction.id,
        description: transaction.description,
        amountCents: transaction.amountCents,
        currency: transaction.currency,
        targetType: transaction.creditCardId
          ? ('card' as const)
          : ('account' as const),
      })),
      allowedCategories,
    )
  } catch (error) {
    if (
      error instanceof Error &&
      (/unauthorized|api key|authentication|401/i.test(error.message) ||
        (error as { statusCode?: number }).statusCode === 401)
    ) {
      throw new Error(
        'O OpenRouter recusou a credencial. Verifique OPENROUTER_API_KEY.',
      )
    }
    throw new Error('Não foi possível categorizar as transações com IA.')
  }

  const confidentSuggestions = filterConfidentAiSuggestions(suggestions)
  let categorized = 0
  db.transaction((transaction) => {
    for (const suggestion of confidentSuggestions) {
      const result = transaction
        .update(schema.transactions)
        .set({ categoryId: suggestion.categoryId })
        .where(
          and(
            eq(schema.transactions.id, suggestion.transactionId),
            or(
              isNull(schema.transactions.categoryId),
              eq(schema.transactions.categoryId, 'uncategorized'),
            ),
          ),
        )
        .run()
      categorized += result.changes
    }
  })

  return {
    processed: candidates.length,
    categorized,
    remaining: Math.max(0, total - categorized),
  }
}

export async function updateStagedTransactionCategory(input: {
  stagedTransactionId: string
  categoryId: string
  counterpartyAccountId?: string | null
}) {
  await ensureDatabase()
  const staged = await db
    .select({
      id: schema.stagedTransactions.id,
      importStatus: schema.imports.status,
      sourceAccountId: schema.imports.accountId,
    })
    .from(schema.stagedTransactions)
    .innerJoin(
      schema.imports,
      eq(schema.stagedTransactions.importId, schema.imports.id),
    )
    .where(eq(schema.stagedTransactions.id, input.stagedTransactionId))
    .limit(1)
  if (!staged[0]) throw new Error('Lançamento do lote não encontrado.')
  if (staged[0].importStatus !== 'review') {
    throw new Error('Este lote não está mais em revisão.')
  }
  const category = await db
    .select({ id: schema.categories.id })
    .from(schema.categories)
    .where(eq(schema.categories.id, input.categoryId))
    .limit(1)
  if (!category[0]) throw new Error('Categoria inválida.')
  const counterpartyAccountId =
    input.categoryId === 'transfer'
      ? (input.counterpartyAccountId ?? null)
      : null
  if (counterpartyAccountId) {
    if (!staged[0].sourceAccountId) {
      throw new Error('Somente lançamentos de conta podem ser transferências.')
    }
    if (counterpartyAccountId === staged[0].sourceAccountId) {
      throw new Error('Escolha uma conta diferente da conta de origem.')
    }
    const counterparty = await db
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, counterpartyAccountId))
      .limit(1)
    if (!counterparty[0]) throw new Error('Conta relacionada inválida.')
  }

  await db
    .update(schema.stagedTransactions)
    .set({
      suggestedCategoryId: input.categoryId,
      counterpartyAccountId,
      suggestionConfidence: 100,
      suggestionSource: 'manual',
    })
    .where(eq(schema.stagedTransactions.id, input.stagedTransactionId))
  return { success: true }
}

export async function setReconciliationStatus(input: {
  groupId: string
  status: 'suggested' | 'confirmed' | 'rejected'
}) {
  await ensureDatabase()
  const [groups, links] = await Promise.all([
    db
      .select()
      .from(schema.reconciliationGroups)
      .where(eq(schema.reconciliationGroups.id, input.groupId))
      .limit(1),
    db
      .select()
      .from(schema.reconciliationLinks)
      .where(eq(schema.reconciliationLinks.groupId, input.groupId)),
  ])
  const group = groups.at(0)
  if (!group) throw new Error('Reconciliação não encontrada.')
  const linkedTransactions = links.length
    ? await db
        .select()
        .from(schema.transactions)
        .where(
          inArray(
            schema.transactions.id,
            links.map((link) => link.transactionId),
          ),
        )
    : []

  db.transaction((transaction) => {
    if (input.status === 'confirmed' && group.status !== 'confirmed') {
      for (const link of links) {
        const linked = linkedTransactions.find(
          (candidate) => candidate.id === link.transactionId,
        )
        if (!linked) continue
        transaction
          .update(schema.reconciliationLinks)
          .set({ previousCategoryId: linked.categoryId })
          .where(eq(schema.reconciliationLinks.id, link.id))
          .run()
        const categoryId =
          group.type === 'card_payment'
            ? 'card_payment'
            : group.type === 'profit_distribution'
              ? 'profit_distribution_income'
              : group.type === 'refund'
                ? null
                : 'transfer'
        if (categoryId) {
          transaction
            .update(schema.transactions)
            .set({ categoryId })
            .where(eq(schema.transactions.id, link.transactionId))
            .run()
        }
      }
    }
    if (input.status !== 'confirmed' && group.status === 'confirmed') {
      for (const link of links) {
        transaction
          .update(schema.transactions)
          .set({ categoryId: link.previousCategoryId })
          .where(eq(schema.transactions.id, link.transactionId))
          .run()
      }
    }
    transaction
      .update(schema.reconciliationGroups)
      .set({ status: input.status })
      .where(eq(schema.reconciliationGroups.id, input.groupId))
      .run()
  })
  await refreshRecurrences()
  return { success: true }
}

export async function createInstallment(input: {
  creditCardId: string
  description: string
  categoryId?: string
  installmentAmountCents: number
  totalInstallments: number
  currentInstallment: number
  firstChargeDate: string
}) {
  await ensureDatabase()
  const row = {
    id: randomUUID(),
    ...input,
    categoryId: input.categoryId || null,
  }
  await db.insert(schema.installmentPlans).values(row)
  return row
}

export async function createReconciliationSuggestions() {
  return refreshReconciliationSuggestions()
}
export async function closeCurrentBudget() {
  await ensureDatabase()
  const snapshot = await getFinanceSnapshot()
  const month = snapshot.dashboard.currentMonth
  const pendingCount = snapshot.dashboard.integrity.closingBlockerCount
  if (pendingCount > 0) {
    throw new Error(
      `Revise as ${pendingCount} pendências antes de fechar o mês.`,
    )
  }
  if (
    snapshot.monthlyBudgets.some(
      (budget) => budget.month === month && budget.closed,
    )
  ) {
    return { month, alreadyClosed: true }
  }
  const strategy = snapshot.dashboard.activeStrategy
  const original = snapshot.dashboard.originalAllocation
  const effective = snapshot.dashboard.effectiveAllocation
  await db
    .insert(schema.monthlyBudgets)
    .values({
      id: randomUUID(),
      month,
      strategyId: strategy.id,
      baseIncomeCents: snapshot.dashboard.baseIncomeCents,
      eligibleIncomeCents: snapshot.dashboard.currentIncomeCents,
      essentialBps: original.essential,
      lifestyleBps: original.lifestyle,
      investmentBps: original.investment,
      reserveBps: original.reserve,
      effectiveInvestmentBps: effective.investment,
      effectiveReserveBps: effective.reserve,
      reserveRedirected: snapshot.dashboard.reserve.redirected,
      closed: true,
      closedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: schema.monthlyBudgets.month,
      set: {
        closed: true,
        closedAt: new Date(),
        eligibleIncomeCents: snapshot.dashboard.currentIncomeCents,
      },
    })
  return { month, alreadyClosed: false }
}

function shiftMonth(month: string, delta: number) {
  const [year, monthNumber] = month.split('-').map(Number)
  const date = new Date(Date.UTC(year, monthNumber - 1 + delta, 1))
  return date.toISOString().slice(0, 7)
}

/**
 * Metas e realizado por envelope dos meses anteriores, para mostrar se a
 * estratégia vem sendo seguida. Meses fechados usam a alocação congelada.
 */
export async function getStrategyHistory(input: { months: number }) {
  await ensureDatabase()
  const current = new Date().toISOString().slice(0, 7)
  const result = []
  for (let offset = 1; offset <= input.months; offset += 1) {
    const month = shiftMonth(current, -offset)
    const snapshot = await getFinanceSnapshot(month)
    const { dashboard } = snapshot
    const actual = dashboard.budgetActual
    result.push({
      month,
      strategyName: dashboard.activeStrategy.name,
      baseIncomeCents: dashboard.baseIncomeCents,
      incomeCents: dashboard.currentIncomeCents,
      targets: dashboard.budgetTargets,
      actual,
      closed: snapshot.monthlyBudgets.some(
        (budget) => budget.month === month && budget.closed,
      ),
      hasData:
        dashboard.currentIncomeCents > 0 ||
        Object.values(actual).some((value) => value !== 0),
    })
  }
  return result
}
