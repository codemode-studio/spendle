import * as Context from 'effect/Context'
import * as Crypto from 'effect/Crypto'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'

import { today } from '../domain/LocalDate.ts'
import { EventLog } from '../events/EventLog.ts'
import { isValidAllocation, strategyTemplates } from './Budget.ts'
import type { Allocation } from './Budget.ts'
import type { ClosedBudget, PlanGoal, PlanStrategy } from './Month.ts'

export const planningChanged = 'PlanningChanged'

export class PlanningError extends Schema.TaggedError<PlanningError>()(
  'PlanningError',
  {
    reason: Schema.Literals([
      'strategy_not_found',
      /** The shares do not add up to 100%. */
      'invalid_allocation',
      /** The month is closed; its plan is frozen. */
      'month_closed',
      'goal_not_found',
      /** Closing waits for the listed pending items. */
      'closing_blocked',
      'invalid_input',
    ]),
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return this.detail ? `${this.reason}: ${this.detail}` : this.reason
  }
}

export class Settings extends Schema.Class<Settings>('Settings')({
  monthlyIncomeTargetCents: Schema.Int,
  reserveMonths: Schema.Int,
  keepReserveContributions: Schema.Boolean,
}) {}

export const SettingsChanges = Schema.Struct({
  monthlyIncomeTargetCents: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
  reserveMonths: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 36 })),
  ),
  keepReserveContributions: Schema.optional(Schema.Boolean),
})
export type SettingsChanges = typeof SettingsChanges.Type

export const GoalType = Schema.Literals([
  'emergency_reserve',
  'medium_term',
  'retirement',
  'other',
])

export class Goal extends Schema.Class<Goal>('Goal')({
  id: Schema.String,
  name: Schema.String,
  type: GoalType,
  targetCents: Schema.Int,
  /** What was saved before the goal plus every contribution since. */
  currentCents: Schema.Int,
  targetDate: Schema.NullOr(Schema.String),
}) {}

export interface GoalInput {
  readonly id?: string | undefined
  readonly name: string
  readonly type: typeof GoalType.Type
  readonly targetCents: number
  readonly currentCents: number
  readonly targetDate?: string | null | undefined
}

const SettingsRow = Schema.Struct({
  monthlyIncomeTargetCents: Schema.Int,
  reserveMonths: Schema.Int,
  keepReserveContributions: Schema.BooleanFromBit,
})

const StrategyRow = Schema.Struct({
  id: Schema.String,
  template: Schema.Literals(strategyTemplates),
  name: Schema.String,
  essential: Schema.Int,
  lifestyle: Schema.Int,
  investment: Schema.Int,
  reserve: Schema.Int,
  isDefault: Schema.BooleanFromBit,
})

const BudgetRow = Schema.Struct({
  month: Schema.String,
  strategyId: Schema.String,
  strategyName: Schema.String,
  baseIncomeCents: Schema.Int,
  eligibleIncomeCents: Schema.Int,
  essential: Schema.Int,
  lifestyle: Schema.Int,
  investment: Schema.Int,
  reserve: Schema.Int,
  effectiveInvestment: Schema.Int,
  effectiveReserve: Schema.Int,
  reserveRedirected: Schema.BooleanFromBit,
  closedAt: Schema.String,
})

const GoalRow = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  type: GoalType,
  targetCents: Schema.Int,
  initialCents: Schema.Int,
  contributedCents: Schema.Int,
  targetDate: Schema.NullOr(Schema.String),
})

export interface Strategy extends PlanStrategy {
  readonly template: (typeof strategyTemplates)[number]
}

export interface Budget extends ClosedBudget {
  readonly closedAt: string
}

const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value)

/**
 * The person's plan: income target, reserve rule, strategy, goals and
 * closed months. Every write is a decision only the
 * person makes; closed months never change.
 */
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const log = yield* EventLog
  const crypto = yield* Crypto.Crypto
  const now = Effect.map(DateTime.now, DateTime.formatIso)

  const findSettings = SqlSchema.findOne({
    Request: Schema.Void,
    Result: SettingsRow,
    execute: () => sql`
      SELECT monthly_income_target_cents AS monthlyIncomeTargetCents,
        reserve_months AS reserveMonths, keep_reserve_contributions AS keepReserveContributions
      FROM planning_settings WHERE id = 1
    `,
  })
  const findStrategies = SqlSchema.findAll({
    Request: Schema.Void,
    Result: StrategyRow,
    execute: () => sql`
      SELECT id, template, name, essential_bps AS essential, lifestyle_bps AS lifestyle,
        investment_bps AS investment, reserve_bps AS reserve, is_default AS isDefault
      FROM budget_strategies ORDER BY rowid
    `,
  })
  const findBudgets = SqlSchema.findAll({
    Request: Schema.Void,
    Result: BudgetRow,
    execute: () => sql`
      SELECT month, strategy_id AS strategyId, strategy_name AS strategyName,
        base_income_cents AS baseIncomeCents, eligible_income_cents AS eligibleIncomeCents,
        essential_bps AS essential, lifestyle_bps AS lifestyle, investment_bps AS investment,
        reserve_bps AS reserve, effective_investment_bps AS effectiveInvestment,
        effective_reserve_bps AS effectiveReserve, reserve_redirected AS reserveRedirected,
        closed_at AS closedAt
      FROM monthly_budgets ORDER BY month DESC
    `,
  })
  const findGoals = SqlSchema.findAll({
    Request: Schema.Void,
    Result: GoalRow,
    execute: () => sql`
      SELECT g.id, g.name, g.type, g.target_cents AS targetCents, g.initial_cents AS initialCents,
        coalesce((SELECT sum(c.amount_cents) FROM goal_contributions c WHERE c.goal_id = g.id), 0)
          AS contributedCents,
        g.target_date AS targetDate
      -- Creation order; goals created in the same instant keep insertion
      -- order (their ids are random within it).
      FROM goals g ORDER BY g.created_at, g.rowid
    `,
  })

  const settings = Effect.map(
    findSettings(undefined),
    (row) => new Settings(row),
  )

  const strategies = Effect.map(findStrategies(undefined), (rows) =>
    rows.map((row): Strategy => ({
      id: row.id,
      template: row.template,
      name: row.name,
      isDefault: row.isDefault,
      allocation: {
        essential: row.essential,
        lifestyle: row.lifestyle,
        investment: row.investment,
        reserve: row.reserve,
      },
    })),
  )

  const budgets = Effect.map(findBudgets(undefined), (rows) =>
    rows.map((row): Budget => ({
      month: row.month,
      strategyId: row.strategyId,
      strategyName: row.strategyName,
      baseIncomeCents: row.baseIncomeCents,
      eligibleIncomeCents: row.eligibleIncomeCents,
      allocation: {
        essential: row.essential,
        lifestyle: row.lifestyle,
        investment: row.investment,
        reserve: row.reserve,
      },
      effectiveAllocation: {
        essential: row.essential,
        lifestyle: row.lifestyle,
        investment: row.effectiveInvestment,
        reserve: row.effectiveReserve,
      },
      reserveRedirected: row.reserveRedirected,
      closedAt: row.closedAt,
    })),
  )

  const goals = Effect.map(findGoals(undefined), (rows) =>
    rows.map(
      (row) =>
        new Goal({
          id: row.id,
          name: row.name,
          type: row.type,
          targetCents: row.targetCents,
          currentCents: row.initialCents + row.contributedCents,
          targetDate: row.targetDate,
        }),
    ),
  )

  const changed = (what: string, payload: Record<string, unknown>) =>
    log.append([
      {
        type: planningChanged,
        streamId: 'planning',
        payload: { what, ...payload },
      },
    ])

  const updateSettings = Effect.fn('Planning.updateSettings')(function* (
    changes: SettingsChanges,
  ) {
    const current = yield* settings
    const next = { ...current, ...changes }
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          UPDATE planning_settings SET
            monthly_income_target_cents = ${next.monthlyIncomeTargetCents},
            reserve_months = ${next.reserveMonths},
            keep_reserve_contributions = ${next.keepReserveContributions ? 1 : 0},
            updated_at = ${yield* now}
          WHERE id = 1
        `
        yield* changed('settings', { ...changes })
      }),
    )
    return yield* settings
  })

  const isClosed = (month: string) =>
    Effect.map(budgets, (rows) => rows.some((budget) => budget.month === month))

  /** Makes the strategy the default with the person's shares; refused once this month is closed. */
  const activateStrategy = Effect.fn('Planning.activateStrategy')(
    function* (input: {
      readonly strategyId: string
      readonly allocation: Allocation
    }) {
      if (!isValidAllocation(input.allocation))
        return yield* new PlanningError({ reason: 'invalid_allocation' })
      const month = (yield* today).slice(0, 7)
      if (yield* isClosed(month))
        return yield* new PlanningError({
          reason: 'month_closed',
          detail: month,
        })
      if (
        !(yield* strategies).some(
          (strategy) => strategy.id === input.strategyId,
        )
      )
        return yield* new PlanningError({
          reason: 'strategy_not_found',
          detail: input.strategyId,
        })
      const { essential, lifestyle, investment, reserve } = input.allocation
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE budget_strategies SET is_default = 0`
          yield* sql`
          UPDATE budget_strategies SET is_default = 1, essential_bps = ${essential},
            lifestyle_bps = ${lifestyle}, investment_bps = ${investment}, reserve_bps = ${reserve}
          WHERE id = ${input.strategyId}
        `
          yield* changed('strategy', { strategyId: input.strategyId })
        }),
      )
      return yield* strategies
    },
  )

  const saveGoal = Effect.fn('Planning.saveGoal')(function* (input: GoalInput) {
    const name = input.name.trim()
    if (name.length < 2)
      return yield* new PlanningError({
        reason: 'invalid_input',
        detail: 'name',
      })
    if (input.targetDate && !isDate(input.targetDate))
      return yield* new PlanningError({
        reason: 'invalid_input',
        detail: 'targetDate',
      })
    const id = input.id ?? (yield* crypto.randomUUIDv7.pipe(Effect.orDie))
    const existing = (yield* findGoals(undefined)).find(
      (goal) => goal.id === id,
    )
    if (input.id !== undefined && existing === undefined)
      return yield* new PlanningError({
        reason: 'goal_not_found',
        detail: input.id,
      })
    // What was saved before contributions, so the current amount is the one typed.
    const initial = Math.max(
      0,
      input.currentCents - (existing?.contributedCents ?? 0),
    )
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          INSERT INTO goals (id, name, type, target_cents, initial_cents, target_date, created_at)
          VALUES (${id}, ${name}, ${input.type}, ${input.targetCents}, ${initial},
            ${input.targetDate || null}, ${yield* now})
          ON CONFLICT (id) DO UPDATE SET name = excluded.name, type = excluded.type,
            target_cents = excluded.target_cents, initial_cents = excluded.initial_cents,
            target_date = excluded.target_date
        `
        yield* changed('goal', { goalId: id })
      }),
    )
    return (yield* goals).find((goal) => goal.id === id)!
  })

  const addContribution = Effect.fn('Planning.addContribution')(
    function* (input: {
      readonly goalId: string
      readonly amountCents: number
      readonly contributedOn: string
      readonly notes?: string | undefined
    }) {
      if (!isDate(input.contributedOn) || input.amountCents <= 0)
        return yield* new PlanningError({ reason: 'invalid_input' })
      if (!(yield* goals).some((goal) => goal.id === input.goalId))
        return yield* new PlanningError({
          reason: 'goal_not_found',
          detail: input.goalId,
        })
      const id = yield* crypto.randomUUIDv7.pipe(Effect.orDie)
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
          INSERT INTO goal_contributions (id, goal_id, amount_cents, contributed_on, notes, created_at)
          VALUES (${id}, ${input.goalId}, ${input.amountCents}, ${input.contributedOn},
            ${input.notes?.trim() || null}, ${yield* now})
        `
          yield* changed('contribution', { goalId: input.goalId })
        }),
      )
      return (yield* goals).find((goal) => goal.id === input.goalId)!
    },
  )

  /** Freezes a month's plan; a month closes once. */
  const freeze = Effect.fn('Planning.freeze')(function* (
    budget: ClosedBudget,
    origin: 'closing' | 'v1_import' = 'closing',
  ) {
    if (yield* isClosed(budget.month))
      return yield* new PlanningError({
        reason: 'month_closed',
        detail: budget.month,
      })
    const closedAt = yield* now
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          INSERT INTO monthly_budgets (month, strategy_id, strategy_name, base_income_cents,
            eligible_income_cents, essential_bps, lifestyle_bps, investment_bps, reserve_bps,
            effective_investment_bps, effective_reserve_bps, reserve_redirected, origin, closed_at)
          VALUES (${budget.month}, ${budget.strategyId}, ${budget.strategyName},
            ${budget.baseIncomeCents}, ${budget.eligibleIncomeCents}, ${budget.allocation.essential},
            ${budget.allocation.lifestyle}, ${budget.allocation.investment}, ${budget.allocation.reserve},
            ${budget.effectiveAllocation.investment}, ${budget.effectiveAllocation.reserve},
            ${budget.reserveRedirected ? 1 : 0}, ${origin}, ${closedAt})
        `
        yield* changed('closing', { month: budget.month })
      }),
    )
    return (yield* budgets).find((row) => row.month === budget.month)!
  })

  const goalsForPlan = Effect.map(goals, (rows) =>
    rows.map((goal): PlanGoal => ({
      id: goal.id,
      type: goal.type,
      targetCents: goal.targetCents,
      currentCents: goal.currentCents,
    })),
  )

  return {
    settings,
    updateSettings,
    strategies,
    activateStrategy,
    budgets,
    budget: (month: string) =>
      Effect.map(budgets, (rows) =>
        Option.fromNullishOr(rows.find((row) => row.month === month)),
      ),
    freeze,
    goals,
    goalsForPlan,
    saveGoal,
    addContribution,
  }
})

export class Planning extends Context.Service<
  Planning,
  Effect.Success<typeof make>
>()('@spendle/server/planning/Planning') {
  static readonly layer = Layer.effect(Planning, make)
}
