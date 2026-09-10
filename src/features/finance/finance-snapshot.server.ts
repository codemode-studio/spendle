import { buildFamilyMonth } from '#/domain/family-month'
import { confirmedAccountIncome } from '#/domain/account-income'
import {
  buildMonthlyCashFlow,
  pendingRecurrencePayments,
} from '#/domain/monthly-cash-flow'
import { shiftDays } from '#/domain/period'
import { cardBudgetLines } from '#/domain/card-budget'
import {
  buildCommitmentBudget,
  commitmentBucket,
} from '#/domain/commitment-budget'
import type { CommitmentRecurrence } from '#/domain/commitment-budget'
import { addRecurrencePeriod } from '#/domain/recurrence-schedule'
import { knowledgeExactPatterns } from '#/domain/knowledge-pattern'
import { readInterFutureControl } from './pdf-parsers/inter-future-control'
import { readNubankFutureControl } from './pdf-parsers/nubank-future-control'
import { desc, eq } from 'drizzle-orm'

import { db, ensureDatabase } from '#/db/index.server'
import * as schema from '#/db/schema'
import { convertMinorUnitsAtRate } from '#/domain/currency'
import {
  addMonths,
  classifyInstallmentCommitment,
  summarizeCardStatements,
  resolveCardCycle,
} from '#/domain/credit-card'
import { buildFinancialSummary } from '#/domain/financial-summary'
import { isFamilyScope } from '#/domain/ledger'
import {
  allocationAmount,
  calculateConservativeBase,
  resolveEffectiveAllocation,
} from '#/domain/finance'
import {
  buildCoverageView,
  countCoveredDaysAfter,
} from '#/domain/import-coverage'
import {
  describeRecurrence,
  isAcceptedRecurrenceMatchStatus,
} from '#/domain/recurrence-book'

function groupRows<T>(rows: T[], key: (row: T) => string) {
  const groups = new Map<string, T[]>()
  for (const row of rows) {
    const id = key(row)
    const group = groups.get(id) ?? []
    group.push(row)
    groups.set(id, group)
  }
  return groups
}

async function createFinanceReader(view: 'full' | 'configuration' = 'full') {
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
    recurrenceKnowledgeRows,
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
    view === 'configuration'
      ? []
      : db
          .select()
          .from(schema.budgetStrategies)
          .orderBy(schema.budgetStrategies.name),
    view === 'configuration'
      ? []
      : db
          .select()
          .from(schema.monthlyBudgets)
          .orderBy(desc(schema.monthlyBudgets.month)),
    view === 'configuration'
      ? []
      : db
          .select()
          .from(schema.investmentGoals)
          .orderBy(schema.investmentGoals.priority),
    view === 'configuration'
      ? []
      : db
          .select()
          .from(schema.goalContributions)
          .orderBy(desc(schema.goalContributions.contributedAt)),
    db.select().from(schema.creditCardInstruments),
    db.select().from(schema.imports).orderBy(desc(schema.imports.createdAt)),
    view === 'configuration'
      ? []
      : db
          .select()
          .from(schema.stagedTransactions)
          .orderBy(schema.stagedTransactions.postedAt),
    view === 'configuration'
      ? []
      : db
          .select()
          .from(schema.reconciliationGroups)
          .orderBy(desc(schema.reconciliationGroups.createdAt)),
    view === 'configuration'
      ? []
      : db.select().from(schema.reconciliationLinks),
    db
      .select()
      .from(schema.balanceCheckpoints)
      .orderBy(desc(schema.balanceCheckpoints.asOf)),
    db.select().from(schema.coverageIntervals),
    view === 'configuration'
      ? []
      : db
          .select()
          .from(schema.transactionCorrections)
          .orderBy(desc(schema.transactionCorrections.createdAt)),
    db
      .select()
      .from(schema.cardStatementCycles)
      .orderBy(desc(schema.cardStatementCycles.periodEnd)),
    view === 'configuration'
      ? []
      : db
          .select()
          .from(schema.recurrenceGroups)
          .orderBy(schema.recurrenceGroups.name),
    view === 'configuration'
      ? []
      : db
          .select()
          .from(schema.recurrences)
          .orderBy(schema.recurrences.nextDate),
    view === 'configuration'
      ? []
      : db
          .select()
          .from(schema.recurrenceOccurrences)
          .orderBy(desc(schema.recurrenceOccurrences.expectedDate)),
    view === 'configuration' ? [] : db.select().from(schema.recurrenceMatches),
    view === 'configuration' ? [] : db.select().from(schema.transactionSplits),
    view === 'configuration'
      ? []
      : db
          .select()
          .from(schema.exchangeRates)
          .orderBy(desc(schema.exchangeRates.date)),
    db
      .select()
      .from(schema.installmentPlans)
      .orderBy(schema.installmentPlans.firstChargeDate),
    db.select().from(schema.appSettings).limit(1),
    view === 'configuration'
      ? []
      : db
          .select({
            id: schema.knowledgeBase.id,
            recurrenceId: schema.knowledgeBase.recurrenceId,
            description: schema.knowledgeBase.sampleDescription,
          })
          .from(schema.knowledgeBase)
          .where(eq(schema.knowledgeBase.kind, 'recurrence')),
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

  const transactionById = new Map(transactions.map((row) => [row.id, row]))
  const stagedById = new Map(stagedRows.map((row) => [row.id, row]))
  const recurrenceById = new Map(recurrenceRows.map((row) => [row.id, row]))
  const occurrenceById = new Map(
    recurrenceOccurrenceRows.map((row) => [row.id, row]),
  )
  const linksByGroup = groupRows(reconciliationLinkRows, (row) => row.groupId)
  const occurrencesByRecurrence = groupRows(
    recurrenceOccurrenceRows,
    (row) => row.recurrenceId,
  )
  const matchesByOccurrence = groupRows(
    recurrenceMatchRows,
    (row) => row.occurrenceId,
  )

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
    const latestImport = importRows
      .filter(
        (row) => row.creditCardId === card.id && row.status === 'committed',
      )
      .sort((a, b) => (b.balanceAsOf ?? '').localeCompare(a.balanceAsOf ?? ''))
      .at(0)
    const latestInstallments = installmentRows.filter(
      (plan) =>
        plan.sourceTransactionId &&
        transactionById.get(plan.sourceTransactionId)?.importId ===
          latestImport?.id,
    )
    const futureControl =
      readInterFutureControl(
        latestImport?.markdown ?? null,
        latestInstallments,
      ) ??
      readNubankFutureControl(
        latestImport?.markdown ?? null,
        latestInstallments,
      )
    const latestDueDate = cardStatementCycleRows.find(
      (cycle) => cycle.importId === latestImport?.id,
    )?.dueDate
    const scheduledStatements =
      futureControl && latestImport && latestDueDate
        ? (futureControl.monthlyCents ?? [futureControl.nextCents]).map(
            (amount, index) => ({
              closingDate: addMonths(futureControl.closingDate, index),
              dueDate: addMonths(latestDueDate, index + 1),
              totalCents: amount,
              certainty: 'installment_schedule' as const,
              sourceImportId: latestImport.id,
            }),
          )
        : []
    // A reliable open CSV observes this cycle; the previous PDF only forecasts it.
    // Keep closed controls authoritative and leave partial CSV windows as provisional evidence.
    const observedStatements = new Map<
      string,
      {
        closingDate: string
        dueDate: string
        totalCents: number
        certainty: 'open'
        sourceImportId: string
        transactionIds: string[]
      }
    >()
    for (const source of importRows
      .filter(
        (row) =>
          row.creditCardId === card.id &&
          row.status === 'committed' &&
          row.parser === 'csv' &&
          row.closingBalanceCents === null &&
          row.periodStart &&
          row.periodEnd &&
          (row.periodSource === 'user' ||
            row.periodSource === 'metadata' ||
            row.periodSource === 'filename'),
      )
      .sort((a, b) => (a.periodEnd ?? '').localeCompare(b.periodEnd ?? ''))) {
      const cycle = resolveCardCycle(
        source.periodEnd!,
        card.closingDay,
        effectiveDueDay,
      )
      const previousClosing = cardStatementCycleRows
        .filter(
          (c) =>
            c.creditCardId === card.id &&
            c.closingDate &&
            c.closingDate < source.periodStart!,
        )
        .map((c) => c.closingDate!)
        .sort()
        .at(-1)
      const expectedStart = shiftDays(
        previousClosing ?? addMonths(cycle.closingDate, -1),
        1,
      )
      if (source.periodStart !== expectedStart) continue
      const observed = transactionRows.filter(
        (t) =>
          t.creditCardId === card.id &&
          t.status !== 'excluded' &&
          t.postedAt >= source.periodStart! &&
          t.postedAt <= source.periodEnd! &&
          !['card_payment', 'transfer'].includes(t.categoryId ?? '') &&
          !/pagamento\s+(?:de\s+)?(?:fatura|recebido)/i.test(t.description),
      )
      if (!observed.length) continue
      observedStatements.set(cycle.dueDate, {
        ...cycle,
        totalCents: Math.max(
          0,
          -observed.reduce((sum, row) => sum + row.amountCents, 0),
        ),
        certainty: 'open',
        sourceImportId: source.id,
        transactionIds: observed.map((row) => row.id),
      })
    }
    const statementSummary = summarizeCardStatements({
      documentedStatements: [
        ...scheduledStatements,
        ...observedStatements.values(),
        ...cardStatementCycleRows.flatMap((cycle) =>
          cycle.creditCardId === card.id &&
          cycle.status !== 'open' &&
          cycle.closingDate &&
          cycle.dueDate &&
          cycle.totalCents !== null
            ? [
                {
                  closingDate: cycle.closingDate,
                  dueDate: cycle.dueDate,
                  totalCents: cycle.totalCents,
                },
              ]
            : [],
        ),
      ],
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
    const budgetStatements = statementSummary.statements.map((statement) => {
      const cycle = cardStatementCycleRows.find(
        (c) => c.creditCardId === card.id && c.dueDate === statement.dueDate,
      )
      const sourceImportId = statement.sourceImportId ?? cycle?.importId ?? null
      const sourceDue = cardStatementCycleRows.find(
        (c) => c.importId === sourceImportId,
      )?.dueDate
      const monthIndex = (date: string) =>
        Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7))
      const futureOffset =
        statement.certainty === 'installment_schedule' && sourceDue
          ? monthIndex(statement.dueDate) - monthIndex(sourceDue)
          : 0
      const plans = installmentRows.filter(
        (p) =>
          p.creditCardId === card.id &&
          p.sourceTransactionId &&
          transactionById.get(p.sourceTransactionId)?.importId ===
            sourceImportId,
      )
      const purchases = transactions
        .filter((t) => t.creditCardId === card.id && t.status !== 'excluded')
        .map((t) => ({ ...t, bucket: t.category?.bucket ?? null }))
      const details = sourceImportId
        ? cardBudgetLines({
            id: card.id + ':' + statement.dueDate,
            dueDate: statement.dueDate,
            totalCents: statement.amountCents,
            importId: sourceImportId,
            futureOffset,
            purchases,
            includedTransactionIds:
              statement.certainty === 'open'
                ? observedStatements.get(statement.dueDate)?.transactionIds
                : undefined,
            plans,
            explicitInstallments:
              futureControl && 'installments' in futureControl
                ? futureControl.installments
                : undefined,
          })
        : []
      const lines = details.flatMap((line) => {
        const splits = line.transactionId
          ? transactionSplitRows.filter(
              (split) => split.transactionId === line.transactionId,
            )
          : []
        return splits.length
          ? splits.map((split) => ({
              ...line,
              id: line.id + ':' + split.id,
              cents: -split.amountCents,
              categoryId: split.categoryId,
              bucket: commitmentBucket(
                categoriesById.get(split.categoryId)?.bucket ?? null,
              ),
            }))
          : [line]
      })
      const paymentIds = reconciliationRows
        .filter((g) => g.status === 'confirmed' && g.type === 'card_payment')
        .flatMap((g) => {
          const links = linksByGroup.get(g.id) ?? []
          return links.some((l) =>
            purchases.some(
              (t) => t.id === l.transactionId && t.importId === sourceImportId,
            ),
          )
            ? links.map((l) => l.transactionId)
            : []
        })
      return {
        id: card.id + ':' + statement.dueDate,
        cardId: card.id,
        name: card.name,
        dueDate: statement.dueDate,
        cents: statement.amountCents,
        closed: statement.certainty === 'closed',
        lines,
        paymentIds,
      }
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
      budgetStatements,
      dueDayEstimated: card.dueDay === null,
      instruments: cardInstrumentRows.filter(
        (instrument) => instrument.creditCardId === card.id,
      ),
      unexplainedNextStatementCents:
        futureControl && 'unexplainedNextCents' in futureControl
          ? Math.max(0, futureControl.unexplainedNextCents)
          : 0,
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

  const cashFacts = {
    accounts: accountRows,
    transactions,
    scopes,
    recurrences: recurrenceRows,
    occurrences: recurrenceOccurrenceRows,
    checkpoints: checkpointRows,
    exchangeRates: exchangeRateRows,
    baseCurrency: settings.baseCurrency,
  }

  function dashboard(selectedMonth?: string) {
    const currentMonth = selectedMonth ?? referenceDate.slice(0, 7)
    const amountInBaseCurrency = (
      transaction: Pick<
        (typeof transactions)[number],
        'currency' | 'amountCents' | 'baseCurrency' | 'baseAmountCents'
      >,
    ) => {
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
      const occurrence = occurrenceById.get(match.occurrenceId)
      const transaction = transactionById.get(match.transactionId)
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
      transactionIds: (linksByGroup.get(group.id) ?? []).map(
        (link) => link.transactionId,
      ),
    }))
    const projectedPendingByOccurrenceId = pendingRecurrencePayments({
      ...cashFacts,
      month: currentMonth,
    })
    const projectedPendingTransactionIds = new Set(
      [...projectedPendingByOccurrenceId.values()].map(
        (transaction) => transaction.id,
      ),
    )
    const projectedRecurrenceAmountByOccurrenceId = new Map<string, number>()
    let missingRecurrenceProjectionConversionCount = 0
    for (const occurrence of recurrenceOccurrenceRows) {
      const recurrence = recurrenceById.get(occurrence.recurrenceId)
      const category = categoriesById.get(occurrence.categoryId)
      if (
        !recurrence?.active ||
        occurrence.status !== 'expected' ||
        !occurrence.expectedDate.startsWith(currentMonth) ||
        (category?.bucket !== 'essential' && category?.bucket !== 'lifestyle')
      ) {
        continue
      }
      const pendingTransaction = projectedPendingByOccurrenceId.get(
        occurrence.id,
      )
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
    const confirmedIncome = confirmedAccountIncome({
      month: currentMonth,
      transactions: transactions.map((transaction) => ({
        ...transaction,
        baseAmountCents: amountInBaseCurrency(transaction),
        bucket: transaction.category?.bucket ?? null,
      })),
      reconciliations: reconciliationsForSummary,
    })
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
        const transaction = transactionById.get(split.transactionId)
        const category = categoriesById.get(split.categoryId)
        if (!transaction || !category) return []
        const baseAmount = amountInBaseCurrency(transaction)
        if (baseAmount === null) return []
        const ratio =
          transaction.amountCents === 0
            ? 1
            : baseAmount / transaction.amountCents
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
              occurrences: (
                occurrencesByRecurrence.get(recurrence.id) ?? []
              ).map((occurrence) => ({
                ...occurrence,
                matches: matchesByOccurrence.get(occurrence.id) ?? [],
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
      essential: allocationAmount(
        baseIncomeCents,
        effectiveAllocation.essential,
      ),
      lifestyle: allocationAmount(
        baseIncomeCents,
        effectiveAllocation.lifestyle,
      ),
      investment: allocationAmount(
        baseIncomeCents,
        effectiveAllocation.investment,
      ),
      reserve: allocationAmount(baseIncomeCents, effectiveAllocation.reserve),
    }

    const budgetProjected = recurrenceOccurrenceRows.reduce(
      (result, occurrence) => {
        const category = categoriesById.get(occurrence.categoryId)
        const recurrence = recurrenceById.get(occurrence.recurrenceId)
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

    const internalIds = new Set(
      reconciliationRows
        .filter(
          (g) =>
            g.status === 'confirmed' &&
            ['transfer', 'fx_transfer', 'profit_distribution'].includes(g.type),
        )
        .flatMap((g) =>
          (linksByGroup.get(g.id) ?? []).map((l) => l.transactionId),
        ),
    )
    const commitmentRecurrences: CommitmentRecurrence[] = []
    const commitmentDataWarnings: string[] = []
    const horizon = addMonths(currentMonth + '-01', 1)
    for (const recurrence of recurrenceRows) {
      if (!recurrence.active || recurrence.direction !== 'expense') continue
      const instances = new Map(
        (occurrencesByRecurrence.get(recurrence.id) ?? []).map((o) => [
          o.expectedDate,
          {
            id: o.id,
            date: o.expectedDate,
            cents: o.expectedAmountCents,
            status: o.status,
            categoryId: o.categoryId,
          },
        ]),
      )
      for (
        let date = recurrence.nextDate;
        date < horizon;
        date = addRecurrencePeriod(
          date,
          recurrence.frequency,
          recurrence.scheduleAnchor,
        )
      ) {
        if (
          (date.startsWith(currentMonth) ||
            (recurrence.creditCardId &&
              date >= addMonths(currentMonth + '-01', -1))) &&
          !instances.has(date)
        )
          instances.set(date, {
            id: 'projected:' + recurrence.id + ':' + date,
            date,
            cents: recurrence.amountCents,
            status: 'expected',
            categoryId: recurrence.categoryId ?? 'uncategorized',
          })
      }
      for (const o of instances.values()) {
        const recurringCard = recurrence.creditCardId
          ? cardRows.find((c) => c.id === recurrence.creditCardId)
          : undefined
        const dueDate = recurringCard
          ? resolveCardCycle(
              o.date,
              recurringCard.closingDay,
              recurringCard.dueDay ??
                Math.min(28, recurringCard.closingDay + 7),
            ).dueDate
          : o.date
        if (!dueDate.startsWith(currentMonth)) continue
        const currentCategory = recurrence.categoryId ?? o.categoryId
        if (currentCategory !== o.categoryId)
          commitmentDataWarnings.push(
            'A categoria da ocorrência de ' +
              recurrence.name +
              ' difere do cadastro atual. A estimativa usa o cadastro atual; o histórico foi preservado.',
          )
        commitmentRecurrences.push({
          id: o.id,
          name: recurrence.name,
          date: dueDate,
          chargeDate: recurringCard ? o.date : undefined,
          cents: convertToBaseCurrency(o.cents, recurrence.currency),
          nativeCents: o.cents,
          currency: recurrence.currency,
          categoryId: currentCategory,
          bucket: categoriesById.get(currentCategory)?.bucket ?? null,
          variable: recurrence.amountMode === 'variable',
          categoryWide: ['groceries', 'delivery', 'restaurants'].includes(
            currentCategory,
          ),
          status: o.status,
          cardId: recurrence.creditCardId,
          toleranceDays: recurrence.dateToleranceDays,
          transactionIds: (matchesByOccurrence.get(o.id) ?? [])
            .filter((m) => isAcceptedRecurrenceMatchStatus(m.status))
            .map((m) => m.transactionId),
          patterns: recurrenceKnowledgeRows
            .filter((k) => k.recurrenceId === recurrence.id)
            .flatMap((k) => knowledgeExactPatterns(k.description)),
        })
      }
    }
    const missingVariableEstimates: string[] = []
    for (const categoryId of ['groceries', 'delivery']) {
      if (
        commitmentRecurrences.some(
          (r) => r.categoryId === categoryId && r.variable,
        )
      )
        continue
      const category = categoriesById.get(categoryId)
      if (!category) continue
      const sources = [
        ...accountRows
          .filter(
            (a) =>
              a.currency === 'BRL' &&
              a.purpose === 'operating' &&
              transactionRows.some((t) => t.accountId === a.id),
          )
          .map((a) => ({ accountId: a.id, creditCardId: null })),
        ...cardRows
          .filter((c) => c.currency === 'BRL')
          .map((c) => ({ accountId: null, creditCardId: c.id })),
      ]
      const comparable: Array<{ month: string; cents: number }> = []
      for (let offset = 1; offset <= 6 && comparable.length < 2; offset++) {
        const start = addMonths(currentMonth + '-01', -offset),
          end = shiftDays(addMonths(start, 1), -1)
        const covered =
          sources.length > 0 &&
          sources.every((source) => {
            const intervals = coverageRows
              .filter(
                (row) =>
                  row.accountId === source.accountId &&
                  row.creditCardId === source.creditCardId &&
                  importById.get(row.importId)?.status === 'committed',
              )
              .sort((a, b) => a.start.localeCompare(b.start))
            let cursor = start
            for (const interval of intervals) {
              if (interval.end < cursor) continue
              if (interval.start > cursor) return false
              cursor = shiftDays(interval.end, 1)
              if (cursor > end) return true
            }
            return false
          })
        if (!covered) continue
        const cents = transactions
          .filter(
            (t) =>
              t.categoryId === categoryId &&
              t.status === 'confirmed' &&
              t.currency === 'BRL' &&
              t.postedAt >= start &&
              t.postedAt <= end &&
              !internalIds.has(t.id),
          )
          .reduce((n, t) => n - t.amountCents, 0)
        comparable.push({ month: start.slice(0, 7), cents: Math.max(0, cents) })
      }
      if (comparable.length < 2) {
        missingVariableEstimates.push(category.name)
        continue
      }
      const cents = Math.round(
        comparable.reduce((n, r) => n + r.cents, 0) / comparable.length,
      )
      commitmentRecurrences.push({
        id: 'history:' + categoryId,
        name:
          category.name +
          ' · média de ' +
          comparable.map((r) => r.month).join(' e '),
        date: currentMonth + '-01',
        cents,
        nativeCents: cents,
        currency: 'BRL',
        categoryId,
        bucket: category.bucket,
        variable: true,
        categoryWide: true,
        patterns: [],
        transactionIds: [],
        status: 'expected',
        cardId: null,
        toleranceDays: 0,
      })
    }
    const monthlyCommitments = buildCommitmentBudget({
      month: currentMonth,
      today: referenceDate,
      incomeCents: baseIncomeCents,
      targets: budgetTargets,
      transactions: transactions.map((t) => ({
        id: t.id,
        description: t.description,
        date: t.postedAt,
        cents: amountInBaseCurrency(t),
        nativeCents: t.amountCents,
        currency: t.currency,
        categoryId: t.categoryId,
        bucket: t.category?.bucket ?? null,
        cardId: t.creditCardId,
        importId: t.importId,
        status: t.status,
        excluded:
          internalIds.has(t.id) ||
          Boolean(t.counterpartyAccountId) ||
          ['transfer', 'profit_distribution_income'].includes(
            t.categoryId ?? '',
          ) ||
          (t.category?.bucket === 'excluded' &&
            !['uncategorized', 'card_payment'].includes(t.categoryId ?? '')),
      })),
      statements: cards
        .filter((c) => isFamilyScope(c.scope?.type))
        .flatMap((c) =>
          c.budgetStatements.flatMap((statement) => {
            const cents = convertToBaseCurrency(statement.cents, c.currency)
            if (cents === null) {
              commitmentDataWarnings.push(
                'Fatura sem conversão para a moeda-base; seu valor não entrou na margem.',
              )
              return []
            }
            return [
              {
                ...statement,
                cents,
                lines: statement.lines.map((line) => ({
                  ...line,
                  cents: convertToBaseCurrency(line.cents, c.currency) ?? 0,
                })),
              },
            ]
          }),
        ),
      recurrences: commitmentRecurrences,
      coveragePartial: financialSummary.integrity.issues.length > 0,
    })

    monthlyCommitments.warnings.push(...new Set(commitmentDataWarnings))
    if (confirmedIncome.missingConversionCount > 0)
      monthlyCommitments.warnings.push(
        `${confirmedIncome.missingConversionCount} recebimento(s) sem conversão de moeda; a renda confirmada está incompleta.`,
      )
    if (missingVariableEstimates.length)
      monthlyCommitments.warnings.push(
        'Sem estimativa adicional para ' +
          missingVariableEstimates.join(', ') +
          ': faltam dois meses com cobertura completa ou uma recorrência variável cadastrada.',
      )

    const familyMonth = buildFamilyMonth({
      month: currentMonth,
      referenceMonth: referenceDate.slice(0, 7),
      closed: selectedBudget?.closed ?? false,
      incomeCents: confirmedIncome.cents,
      plannedIncomeCents: baseIncomeCents,
      targets: budgetTargets,
      saved: financialSummary.budgetActual,
      budget: monthlyCommitments,
    })
    const cashFlow = buildMonthlyCashFlow({
      ...cashFacts,
      month: currentMonth,
      referenceDate,
      commitments: familyMonth,
      reconciliations: reconciliationsForSummary,
    })
    return {
      currentMonth,
      netWorthCents: financialSummary.netWorthCents,
      currentIncomeCents: financialSummary.currentIncomeCents,
      confirmedIncomeCents: confirmedIncome.cents,
      familyMonth: {
        ...familyMonth,
        cashFlow,
        hasData:
          familyMonth.hasData ||
          (cashFlow.cashCents !== null && cashFlow.cashCents !== 0),
      },
      currentExpenseCents: financialSummary.currentExpenseCents,
      reviewTransactionCount: stagedRows.filter(
        (staged) => importById.get(staged.importId)?.status === 'review',
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
      monthlyCommitments,
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
    }
  }

  return {
    dashboard,
    monthlyBudgets: monthlyBudgetRows,
    configuration() {
      return {
        scopes,
        institutions,
        accounts,
        cards,
        categories: categoryRows,
        settings,
        installmentPlans: installmentRows.map((plan) => ({
          ...plan,
          commitmentType: classifyInstallmentCommitment(
            plan.totalInstallments,
            plan.installmentAmountCents,
          ),
        })),
      }
    },
    snapshot(selectedMonth?: string) {
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
          links: (linksByGroup.get(group.id) ?? []).map((link) => ({
            ...link,
            transaction: transactionById.get(link.transactionId) ?? null,
          })),
        })),
        checkpoints: checkpointRows,
        corrections: correctionRows.map((correction) => ({
          ...correction,
          observation: stagedById.get(correction.stagedTransactionId) ?? null,
          transaction: transactionById.get(correction.transactionId) ?? null,
        })),
        recurrenceGroups: recurrenceGroupRows,
        recurrences: recurrenceRows.map((recurrence) => ({
          ...recurrence,
          knowledgeReferences: recurrenceKnowledgeRows.filter(
            (entry) => entry.recurrenceId === recurrence.id,
          ),
          baseAmountCents: convertToBaseCurrency(
            recurrence.amountCents,
            recurrence.currency,
          ),
          occurrences: (occurrencesByRecurrence.get(recurrence.id) ?? []).map(
            (occurrence) => ({
              ...occurrence,
              matches: (matchesByOccurrence.get(occurrence.id) ?? []).map(
                (match) => ({
                  ...match,
                  transaction: transactionById.get(match.transactionId) ?? null,
                }),
              ),
            }),
          ),
        })),
        installmentPlans: installmentRows.map((plan) => ({
          ...plan,
          commitmentType: classifyInstallmentCommitment(
            plan.totalInstallments,
            plan.installmentAmountCents,
          ),
        })),
        settings,
        dashboard: dashboard(selectedMonth),
      }
    },
  }
}

export async function getFinanceSnapshot(selectedMonth?: string) {
  const reader = await createFinanceReader()
  return reader.snapshot(selectedMonth)
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
  const reader = await createFinanceReader()
  const result = []
  for (let offset = 1; offset <= input.months; offset += 1) {
    const month = shiftMonth(current, -offset)
    const dashboard = reader.dashboard(month)
    const actual = dashboard.budgetActual
    result.push({
      month,
      strategyName: dashboard.activeStrategy.name,
      familyMonth: { ...dashboard.familyMonth, lines: [] },
      baseIncomeCents: dashboard.baseIncomeCents,
      incomeCents: dashboard.currentIncomeCents,
      targets: dashboard.budgetTargets,
      actual,
      closed: reader.monthlyBudgets.some(
        (budget) => budget.month === month && budget.closed,
      ),
      hasData:
        dashboard.currentIncomeCents > 0 ||
        Object.values(actual).some((value) => value !== 0),
    })
  }
  return result
}

export async function getConfigurationSnapshot() {
  const reader = await createFinanceReader('configuration')
  return reader.configuration()
}

export async function getPlanningSnapshot() {
  const reader = await createFinanceReader()
  const snapshot = reader.snapshot()
  return {
    ...reader.configuration(),
    dashboard: snapshot.dashboard,
    strategies: snapshot.strategies,
    monthlyBudgets: snapshot.monthlyBudgets,
    goals: snapshot.goals,
    contributions: snapshot.contributions,
    recurrences: snapshot.recurrences,
    recurrenceGroups: snapshot.recurrenceGroups,
  }
}

export { getCategoryTransactions } from './category-ledger.server'
