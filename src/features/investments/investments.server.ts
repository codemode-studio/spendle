import { randomUUID } from 'node:crypto'

import { desc, eq } from 'drizzle-orm'

import { db, ensureDatabase } from '#/db/index.server'
import * as schema from '#/db/schema'
import { convertMinorUnitsAtRate } from '#/domain/currency'
import { allocationAmount, calculateConservativeBase } from '#/domain/finance'
import {
  hasOwnValuation,
  positionCurrentAmountMinor,
  reserveProgressCents,
} from '#/domain/investment-position'

type FxQuote = { rateMicros: number; date: string; source: string }

let publicQuoteCache:
  { expiresAt: number; quotes: Partial<Record<string, FxQuote>> } | undefined

async function publicBrlQuotes() {
  if (publicQuoteCache && publicQuoteCache.expiresAt > Date.now()) {
    return publicQuoteCache.quotes
  }
  const quotes: Partial<Record<string, FxQuote>> = {}
  await Promise.all(
    ['USD', 'BTC'].map(async (currency) => {
      try {
        const response = await fetch(
          `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${currency.toLowerCase()}.json`,
          { signal: AbortSignal.timeout(2_000) },
        )
        if (!response.ok) return
        const payload = (await response.json()) as {
          date?: string
          [key: string]: unknown
        }
        const rates = payload[currency.toLowerCase()] as
          Record<string, number> | undefined
        const rate = rates?.brl
        if (typeof rate !== 'number' || !Number.isFinite(rate) || !payload.date)
          return
        quotes[currency] = {
          rateMicros: Math.round(rate * 1_000_000),
          date: payload.date,
          source: 'Currency API',
        }
      } catch {
        // A leitura local continua disponível quando a cotação pública falha.
      }
    }),
  )
  publicQuoteCache = { expiresAt: Date.now() + 15 * 60_000, quotes }
  return quotes
}

export async function getInvestmentsSnapshot(
  quoteOverrides?: Partial<Record<string, FxQuote>>,
) {
  await ensureDatabase()
  const [
    positions,
    classes,
    categories,
    accounts,
    institutions,
    goals,
    movements,
    transactions,
    exchangeRates,
    strategies,
    monthlyBudgets,
    settingsRows,
  ] = await Promise.all([
    db.select().from(schema.investmentPositions),
    db
      .select()
      .from(schema.investmentAssetClasses)
      .orderBy(schema.investmentAssetClasses.sortOrder),
    db.select().from(schema.categories).orderBy(schema.categories.name),
    db.select().from(schema.accounts),
    db.select().from(schema.institutions),
    db
      .select()
      .from(schema.investmentGoals)
      .orderBy(schema.investmentGoals.priority),
    db.select().from(schema.investmentPositionMovements),
    db
      .select()
      .from(schema.transactions)
      .orderBy(desc(schema.transactions.postedAt)),
    db
      .select()
      .from(schema.exchangeRates)
      .orderBy(desc(schema.exchangeRates.date)),
    db.select().from(schema.budgetStrategies),
    db.select().from(schema.monthlyBudgets),
    db.select().from(schema.appSettings),
  ])

  const publicQuotes = quoteOverrides ?? (await publicBrlQuotes())
  const quotes: Partial<Record<string, FxQuote>> = {
    BRL: {
      rateMicros: 1_000_000,
      date: new Date().toISOString().slice(0, 10),
      source: 'BRL',
    },
  }
  for (const currency of ['USD', 'BTC']) {
    const stored = exchangeRates.find(
      (rate) => rate.fromCurrency === currency && rate.toCurrency === 'BRL',
    )
    const quote =
      publicQuotes[currency] ??
      (stored
        ? {
            rateMicros: stored.rateMicros,
            date: stored.date,
            source: stored.source,
          }
        : undefined)
    if (quote) quotes[currency] = quote
  }

  const accountById = new Map(accounts.map((account) => [account.id, account]))
  const institutionById = new Map(
    institutions.map((institution) => [institution.id, institution]),
  )
  const classById = new Map(
    classes.map((assetClass) => [assetClass.id, assetClass]),
  )
  const goalById = new Map(goals.map((goal) => [goal.id, goal]))
  const transactionById = new Map(
    transactions.map((transaction) => [transaction.id, transaction]),
  )

  const items = positions
    .filter((position) => position.active)
    .map((position) => {
      const positionMovements = movements.filter(
        (movement) => movement.positionId === position.id,
      )
      const netMovementMinor = positionMovements.reduce(
        (sum, movement) =>
          sum +
          (movement.kind === 'contribution'
            ? movement.amountMinor
            : -movement.amountMinor),
        0,
      )
      const currentAmountMinor = positionCurrentAmountMinor(
        position,
        positionMovements.map((movement) => ({
          ...movement,
          postedAt:
            transactionById.get(movement.transactionId)?.postedAt ?? null,
        })),
      )
      const contributionAmountMinor =
        position.initialAmountMinor + netMovementMinor
      const contributedBaseCents = positionMovements.reduce<number | null>(
        (sum, movement) => {
          if (sum === null || movement.baseAmountCents === null) return null
          return (
            sum +
            (movement.kind === 'contribution'
              ? movement.baseAmountCents
              : -movement.baseAmountCents)
          )
        },
        position.initialBaseCents,
      )
      const quote = quotes[position.currency]
      const currentBaseCents = quote
        ? convertMinorUnitsAtRate(
            currentAmountMinor,
            position.currency,
            'BRL',
            quote.rateMicros,
          )
        : null
      const account = accountById.get(position.accountId)!
      const assetClass = classById.get(position.assetClassId)!
      const goal = position.goalId
        ? (goalById.get(position.goalId) ?? null)
        : null
      return {
        id: position.id,
        name: position.name,
        symbol: position.symbol,
        currency: position.currency,
        accountId: position.accountId,
        accountName: account.name,
        institutionName: account.institutionId
          ? (institutionById.get(account.institutionId)?.name ?? null)
          : null,
        assetClassId: position.assetClassId,
        assetClassName: assetClass.name,
        color: assetClass.color,
        goalId: position.goalId,
        goalName: goal?.name ?? null,
        currentAmountMinor,
        contributionAmountMinor,
        currentBaseCents,
        contributedBaseCents,
        resultBaseCents:
          currentBaseCents !== null && contributedBaseCents !== null
            ? currentBaseCents - contributedBaseCents
            : null,
        valueKind:
          position.manualCurrentAmountMinor === null
            ? ('estimated' as const)
            : ('manual' as const),
        currentAt: position.manualCurrentAt,
        ownValuation: hasOwnValuation(position),
        quote: quote ?? null,
        movements: positionMovements
          .map((movement) => ({
            ...movement,
            transaction: transactionById.get(movement.transactionId)!,
          }))
          .sort((left, right) =>
            right.transaction.postedAt.localeCompare(left.transaction.postedAt),
          ),
      }
    })
    .sort(
      (left, right) =>
        (right.currentBaseCents ?? -1) - (left.currentBaseCents ?? -1),
    )

  const linkedTransactionIds = new Set(
    movements.map((movement) => movement.transactionId),
  )
  const brokerageAccountIds = new Set(
    accounts
      .filter(
        (account) =>
          account.active &&
          (account.kind === 'investment' || account.purpose === 'investment'),
      )
      .map((account) => account.id),
  )
  const availableTransactions = transactions
    .filter(
      (transaction) =>
        transaction.accountId &&
        brokerageAccountIds.has(transaction.accountId) &&
        transaction.status === 'confirmed' &&
        transaction.amountCents !== 0 &&
        !linkedTransactionIds.has(transaction.id),
    )
    .slice(0, 100)
    .map((transaction) => ({
      id: transaction.id,
      accountId: transaction.accountId!,
      accountName: accountById.get(transaction.accountId!)?.name ?? 'Conta',
      postedAt: transaction.postedAt,
      description: transaction.description,
      amountMinor: Math.abs(transaction.amountCents),
      currency: transaction.currency,
      kind:
        transaction.amountCents > 0
          ? ('contribution' as const)
          : ('withdrawal' as const),
    }))

  const emergencyGoal =
    goals.find((goal) => goal.type === 'emergency_reserve') ?? null
  const settings = settingsRows[0]
  const currentMonth = new Date().toISOString().slice(0, 7)
  const selectedBudget = monthlyBudgets.find(
    (budget) => budget.month === currentMonth,
  )
  const activeStrategy =
    (selectedBudget
      ? strategies.find((strategy) => strategy.id === selectedBudget.strategyId)
      : undefined) ??
    strategies.find((strategy) => strategy.isDefault) ??
    strategies[0]
  const closedIncomes = monthlyBudgets
    .filter(
      (budget) =>
        budget.closed &&
        budget.month < currentMonth &&
        budget.eligibleIncomeCents !== null,
    )
    .sort((left, right) => right.month.localeCompare(left.month))
    .slice(0, 3)
    .map((budget) => budget.eligibleIncomeCents!)
  const baseIncomeCents =
    selectedBudget?.baseIncomeCents ??
    calculateConservativeBase(settings.monthlyIncomeTargetCents, closedIncomes)
  const reserveTargetCents =
    emergencyGoal?.targetCents ||
    allocationAmount(
      baseIncomeCents,
      selectedBudget?.essentialBps ?? activeStrategy.essentialBps,
    ) * settings.reserveMonths
  const reserveCurrentCents = reserveProgressCents({
    recordedCents: emergencyGoal?.currentCents ?? 0,
    linkedPositions: emergencyGoal
      ? items
          .filter((item) => item.goalId === emergencyGoal.id)
          .map((item) => ({
            cents: item.currentBaseCents ?? 0,
            ownValuation: item.ownValuation,
          }))
      : [],
  })
  const totalCents = items.reduce(
    (sum, item) => sum + (item.currentBaseCents ?? 0),
    0,
  )

  return {
    positions: items,
    classes: classes.filter((assetClass) => assetClass.active),
    categories: categories.filter((category) => category.active),
    goals: goals.filter((goal) => goal.active),
    brokerageAccounts: accounts
      .filter((account) => brokerageAccountIds.has(account.id))
      .map((account) => ({
        id: account.id,
        name: account.name,
        currency: account.currency,
        purpose: account.purpose,
      })),
    availableTransactions,
    summary: {
      totalCents,
      positionCount: items.length,
      accountCount: new Set(items.map((item) => item.accountId)).size,
      reserveCurrentCents,
      reserveTargetCents,
      missingQuoteCount: items.filter((item) => item.currentBaseCents === null)
        .length,
    },
  }
}

export async function classifyInvestmentTransaction(input: {
  transactionId: string
  positionId?: string
  newPosition?: { name: string; assetClassId: string; goalId?: string }
}) {
  await ensureDatabase()
  const transaction = (
    await db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, input.transactionId))
      .limit(1)
  ).at(0)
  if (!transaction?.accountId || transaction.status !== 'confirmed')
    throw new Error('Transação não encontrada.')
  const account = (
    await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, transaction.accountId))
      .limit(1)
  ).at(0)
  if (
    !account ||
    (account.kind !== 'investment' && account.purpose !== 'investment')
  ) {
    throw new Error('A transação precisa pertencer a uma corretora.')
  }

  let positionId = input.positionId
  if (!positionId && input.newPosition) {
    positionId = randomUUID()
    await db.insert(schema.investmentPositions).values({
      id: positionId,
      accountId: account.id,
      assetClassId: input.newPosition.assetClassId,
      goalId: input.newPosition.goalId || null,
      name: input.newPosition.name,
      currency: transaction.currency,
    })
  }
  if (!positionId) throw new Error('Selecione ou crie uma posição.')
  const position = (
    await db
      .select()
      .from(schema.investmentPositions)
      .where(eq(schema.investmentPositions.id, positionId))
      .limit(1)
  ).at(0)
  if (
    !position ||
    position.accountId !== account.id ||
    position.currency !== transaction.currency
  ) {
    throw new Error('A posição deve usar a mesma conta e moeda da transação.')
  }
  await db.insert(schema.investmentPositionMovements).values({
    id: randomUUID(),
    positionId,
    transactionId: transaction.id,
    kind: transaction.amountCents > 0 ? 'contribution' : 'withdrawal',
    amountMinor: Math.abs(transaction.amountCents),
    baseAmountCents:
      transaction.baseAmountCents === null
        ? null
        : Math.abs(transaction.baseAmountCents),
  })
  return { positionId }
}

export async function deleteInvestmentMovement(input: { movementId: string }) {
  await ensureDatabase()
  return db.transaction((tx) => {
    const movement = tx
      .select()
      .from(schema.investmentPositionMovements)
      .where(eq(schema.investmentPositionMovements.id, input.movementId))
      .limit(1)
      .get()
    if (!movement) throw new Error('Lançamento não encontrado.')

    const position = tx
      .select()
      .from(schema.investmentPositions)
      .where(eq(schema.investmentPositions.id, movement.positionId))
      .limit(1)
      .get()
    if (!position) throw new Error('Posição não encontrada.')

    tx.delete(schema.investmentPositionMovements)
      .where(eq(schema.investmentPositionMovements.id, input.movementId))
      .run()

    const remainingMovement = tx
      .select({ id: schema.investmentPositionMovements.id })
      .from(schema.investmentPositionMovements)
      .where(
        eq(schema.investmentPositionMovements.positionId, movement.positionId),
      )
      .limit(1)
      .get()
    const positionDeleted =
      !remainingMovement && position.initialAmountMinor === 0
    if (positionDeleted) {
      tx.delete(schema.investmentPositions)
        .where(eq(schema.investmentPositions.id, movement.positionId))
        .run()
    }

    return {
      movementId: movement.id,
      transactionId: movement.transactionId,
      positionDeleted,
    }
  })
}

export async function updateInvestmentPositionValue(input: {
  positionId: string
  amountMinor: number
  asOf: string
}) {
  await ensureDatabase()
  const updated = await db
    .update(schema.investmentPositions)
    .set({
      manualCurrentAmountMinor: input.amountMinor,
      manualCurrentAt: input.asOf,
    })
    .where(eq(schema.investmentPositions.id, input.positionId))
    .returning({ id: schema.investmentPositions.id })
  if (!updated[0]) throw new Error('Posição não encontrada.')
  return updated[0]
}
