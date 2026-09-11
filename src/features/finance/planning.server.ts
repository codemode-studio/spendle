import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'

import { db, ensureDatabase } from '#/db/index.server'
import * as schema from '#/db/schema'
import { strategyAllocationSchema } from '#/domain/finance'
import { getFinanceSnapshot } from './finance-snapshot.server'
import { refreshReconciliationAfterCommit } from './reconciliation-refresh.server'

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
  // Falha da IA não desfaz o fechamento; a tela permite tentar novamente.
  const { getAssistantStatus, generateMonthlyAnalysis } =
    await import('../home/analysis.server')
  let analysisError = false
  if ((await getAssistantStatus()).configured) {
    try {
      await generateMonthlyAnalysis(month)
    } catch {
      analysisError = true
    }
  }
  return { month, alreadyClosed: false, analysisError }
}
