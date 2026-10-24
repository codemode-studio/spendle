import * as Schema from 'effect/Schema'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import * as HttpApiSchema from 'effect/http-api/HttpApiSchema'

import { EndpointErrors } from './Errors.ts'
import { Converted, Exchange } from './Rates.ts'

const LocalDate = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/))
const Month = Schema.String.check(Schema.isPattern(/^\d{4}-(0[1-9]|1[0-2])$/))
const Bps = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 }))

/** Basis points per envelope (10 000 = 100%). */
export const Allocation = Schema.Struct({
  essential: Bps,
  lifestyle: Bps,
  investment: Bps,
  reserve: Bps,
})
/** Centavos per envelope. */
export const BucketAmounts = Schema.Struct({
  essential: Schema.Int,
  lifestyle: Schema.Int,
  investment: Schema.Int,
  reserve: Schema.Int,
})

export const PlanSettings = Schema.Struct({
  monthlyIncomeTargetCents: Schema.Int,
  reserveMonths: Schema.Int,
  keepReserveContributions: Schema.Boolean,
})

export const Strategy = Schema.Struct({
  id: Schema.String,
  template: Schema.Literals([
    'balanced',
    'wealth',
    'aggressive',
    'independence',
  ]),
  name: Schema.String,
  allocation: Allocation,
  isDefault: Schema.Boolean,
})

/** A closed month: its plan as it was when closed. */
export const ClosedMonth = Schema.Struct({
  month: Schema.String,
  strategyId: Schema.String,
  strategyName: Schema.String,
  baseIncomeCents: Schema.Int,
  eligibleIncomeCents: Schema.Int,
  allocation: Allocation,
  effectiveAllocation: Allocation,
  reserveRedirected: Schema.Boolean,
  closedAt: Schema.String,
})

export const GoalType = Schema.Literals([
  'emergency_reserve',
  'medium_term',
  'retirement',
  'other',
])
export const Goal = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  type: GoalType,
  targetCents: Schema.Int,
  currentCents: Schema.Int,
  targetDate: Schema.NullOr(Schema.String),
})

/** A spending cap the person set for a category from `fromMonth` on; null removes it. */
export const CategoryCap = Schema.Struct({
  categoryId: Schema.String,
  fromMonth: Month,
  cents: Schema.NullOr(Schema.Int),
})

export const PlanningState = Schema.Struct({
  settings: PlanSettings,
  strategies: Schema.Array(Strategy),
  /** Every cap set, by category and month; a month uses the latest from it or before. */
  caps: Schema.Array(CategoryCap),
  budgets: Schema.Array(ClosedMonth),
  goals: Schema.Array(Goal),
})
export type PlanningState = typeof PlanningState.Type

export const IntegrityIssue = Schema.Struct({
  code: Schema.Literals([
    'uncategorized',
    'category_review',
    'pending_entry',
    'suggested_reconciliation',
    'overdue_recurrence',
    'recurrence_category_conflict',
    'missing_balance',
    'other_currency',
  ]),
  count: Schema.Int,
  blocksClosing: Schema.Boolean,
})
export type IntegrityIssue = typeof IntegrityIssue.Type

export const MonthLine = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  date: Schema.String,
  cents: Schema.Int,
  knownCents: Schema.Int,
  estimatedCents: Schema.Int,
  paidCents: Schema.Int,
  categoryId: Schema.NullOr(Schema.String),
  bucket: Schema.Literals(['essential', 'lifestyle', 'other']),
  entryId: Schema.NullOr(Schema.String),
  certainty: Schema.Literals(['documented', 'scheduled', 'estimated']),
  /** `history` estimates a variable category from its trailing months. */
  origin: Schema.Literals([
    'account',
    'card',
    'recurrence',
    'envelope',
    'history',
  ]),
  converted: Schema.NullOr(Converted),
})

/** The family's month: plan, spending per envelope, savings, cash and what blocks closing. */
export const MonthView = Schema.Struct({
  month: Schema.String,
  referenceMonth: Schema.String,
  closed: Schema.Boolean,
  /** Open and not in the past: estimates fill what has not happened yet. */
  forecasting: Schema.Boolean,
  strategy: Schema.Struct({ id: Schema.String, name: Schema.String }),
  baseIncomeCents: Schema.Int,
  allocation: Allocation,
  effectiveAllocation: Allocation,
  targets: BucketAmounts,
  reserve: Schema.Struct({
    currentCents: Schema.Int,
    targetCents: Schema.Int,
    months: Schema.Int,
    complete: Schema.Boolean,
    redirected: Schema.Boolean,
  }),
  /** Income received: inflows categorised as income. */
  incomeCents: Schema.Int,
  /** Spending per envelope (with estimates while forecasting) and savings. */
  actual: BucketAmounts,
  family: Schema.Struct({
    plannedIncomeCents: Schema.Int,
    knownExpenseCents: Schema.Int,
    estimatedExpenseCents: Schema.Int,
    expenseCents: Schema.Int,
    savedCents: Schema.Int,
    savingsTargetCents: Schema.Int,
    savingsRemainingCents: Schema.Int,
    plannedBalanceCents: Schema.Int,
    /** The part of the estimate that comes from category history, not from schedules. */
    historyEstimateCents: Schema.Int,
    expenses: Schema.Array(
      Schema.Struct({
        bucket: Schema.Literals(['essential', 'lifestyle', 'other']),
        cents: Schema.Int,
        knownCents: Schema.Int,
        estimatedCents: Schema.Int,
        targetCents: Schema.NullOr(Schema.Int),
      }),
    ),
    lines: Schema.Array(MonthLine),
    needsCategoryCount: Schema.Int,
    warnings: Schema.Array(Schema.String),
    hasData: Schema.Boolean,
  }),
  cashFlow: Schema.Struct({
    forecasting: Schema.Boolean,
    openingCashCents: Schema.NullOr(Schema.Int),
    cashCents: Schema.NullOr(Schema.Int),
    receivedCents: Schema.Int,
    paidCents: Schema.Int,
    expectedIncomeCents: Schema.Int,
    remainingExpenseCents: Schema.Int,
    closingCashCents: Schema.NullOr(Schema.Int),
    afterGoalsCents: Schema.NullOr(Schema.Int),
  }),
  integrity: Schema.Struct({
    partial: Schema.Boolean,
    issues: Schema.Array(IntegrityIssue),
    closingBlockerCount: Schema.Int,
  }),
  exchange: Exchange,
})
export type MonthView = typeof MonthView.Type

/** Spending per category over a period, against the caps. Positive centavos in reais. */
export const SpendingView = Schema.Struct({
  from: LocalDate,
  to: LocalDate,
  /** The accounts counted. */
  accountIds: Schema.Array(Schema.String),
  categories: Schema.Array(
    Schema.Struct({
      categoryId: Schema.String,
      name: Schema.String,
      bucket: Schema.String,
      /** Outflows less refunds, by purchase date. */
      spentCents: Schema.Int,
      entryCount: Schema.Int,
      /** Each month's cap prorated to the days of the period; null without one. */
      capCents: Schema.NullOr(Schema.Int),
    }),
  ),
  spentCents: Schema.Int,
  /** Outflows still without a category: possibly spending. */
  unclassifiedCents: Schema.Int,
  /** Movements in another currency left out for want of a rate. */
  unconvertedCount: Schema.Int,
})

/** What a later card bill will carry from instalments of purchases already made. */
export const InstalmentBill = Schema.Struct({
  accountId: Schema.String,
  dueOn: LocalDate,
  /** Positive centavos in the card's currency. */
  cents: Schema.Int,
  items: Schema.Array(
    Schema.Struct({
      description: Schema.String,
      number: Schema.Int,
      total: Schema.Int,
      cents: Schema.Int,
    }),
  ),
})

export const CashProjection = Schema.Struct({
  today: Schema.String,
  days: Schema.Int,
  exchange: Exchange,
  startingCents: Schema.NullOr(Schema.Int),
  points: Schema.Array(
    Schema.Struct({ date: Schema.String, balanceCents: Schema.Int }),
  ),
  todayIndex: Schema.Int,
  dailyVariableCents: Schema.Int,
  scheduled: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      date: Schema.String,
      name: Schema.String,
      amountCents: Schema.Int,
      kind: Schema.Literals(['income', 'expense', 'statement']),
      certainty: Schema.NullOr(
        Schema.Literals(['closed', 'installment_schedule', 'open']),
      ),
      converted: Schema.NullOr(Converted),
    }),
  ),
  recurringEstimateEntryIds: Schema.Array(Schema.String),
  largestHistoricalExpenses: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      date: Schema.String,
      description: Schema.String,
      cents: Schema.Int,
    }),
  ),
})
export type CashProjection = typeof CashProjection.Type

export const EntrySummary = Schema.Struct({
  id: Schema.String,
  accountId: Schema.String,
  accountName: Schema.String,
  bookedOn: Schema.String,
  description: Schema.String,
  amountCents: Schema.Int,
  currency: Schema.String,
  categoryId: Schema.NullOr(Schema.String),
})

export const RecurrenceView = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  groupId: Schema.NullOr(Schema.String),
  participantLabel: Schema.NullOr(Schema.String),
  accountId: Schema.NullOr(Schema.String),
  categoryId: Schema.String,
  amountCents: Schema.Int,
  currency: Schema.String,
  direction: Schema.Literals(['income', 'expense']),
  amountMode: Schema.Literals(['fixed', 'variable']),
  matchMode: Schema.Literals(['single', 'aggregate']),
  destinationMode: Schema.Literals(['automatic', 'fixed']),
  frequency: Schema.Literals(['monthly', 'yearly']),
  startsOn: Schema.String,
  scheduleAnchor: Schema.String,
  nextDate: Schema.String,
  active: Schema.Boolean,
  /** The amount in reais at the latest rate; null in reais or without a rate. */
  converted: Schema.NullOr(Converted),
  learnedDescriptions: Schema.Array(Schema.String),
  occurrences: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      expectedDate: Schema.String,
      expectedAmountCents: Schema.Int,
      currency: Schema.String,
      status: Schema.Literals(['expected', 'matched', 'skipped']),
      overdue: Schema.Boolean,
      matches: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          occurrenceId: Schema.String,
          entryId: Schema.String,
          status: Schema.Literals(['suggested', 'confirmed', 'auto_confirmed']),
          score: Schema.Int,
          reason: Schema.String,
          categoryConflict: Schema.Boolean,
          entry: EntrySummary,
        }),
      ),
    }),
  ),
})
export type RecurrenceView = typeof RecurrenceView.Type

export const RecurrenceBook = Schema.Struct({
  groups: Schema.Array(
    Schema.Struct({ id: Schema.String, name: Schema.String }),
  ),
  recurrences: Schema.Array(RecurrenceView),
})
export type RecurrenceBook = typeof RecurrenceBook.Type

export const RecurrenceInput = Schema.Struct({
  name: Schema.String,
  groupName: Schema.optional(Schema.NullOr(Schema.String)),
  participantLabel: Schema.optional(Schema.NullOr(Schema.String)),
  accountId: Schema.NullOr(Schema.String),
  categoryId: Schema.String,
  amountCents: Schema.Int.check(Schema.isGreaterThan(0)),
  currency: Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/)),
  direction: Schema.Literals(['income', 'expense']),
  amountMode: Schema.Literals(['fixed', 'variable']),
  matchMode: Schema.Literals(['single', 'aggregate']),
  destinationMode: Schema.Literals(['automatic', 'fixed']),
  frequency: Schema.Literals(['monthly', 'yearly']),
  nextDate: LocalDate,
})

export const DetectedRecurrence = Schema.Struct({
  key: Schema.String,
  signature: Schema.String,
  name: Schema.String,
  direction: Schema.Literals(['income', 'expense']),
  currency: Schema.String,
  frequency: Schema.Literals(['monthly', 'yearly']),
  amountMode: Schema.Literals(['fixed', 'variable']),
  typicalAmountCents: Schema.Int,
  minAmountCents: Schema.Int,
  maxAmountCents: Schema.Int,
  accountId: Schema.NullOr(Schema.String),
  categoryId: Schema.NullOr(Schema.String),
  nextExpectedDate: Schema.String,
  confidence: Schema.Number,
  entries: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      bookedOn: Schema.String,
      amountCents: Schema.Int,
    }),
  ),
})
export type DetectedRecurrence = typeof DetectedRecurrence.Type

export const LinkCandidate = Schema.Struct({
  entryId: Schema.String,
  sameCategory: Schema.Boolean,
  amountDifferenceCents: Schema.Int,
  daysApart: Schema.Int,
  rank: Schema.Number,
  entry: EntrySummary,
})
export type LinkCandidate = typeof LinkCandidate.Type

const OccurrenceRef = Schema.Struct({
  recurrenceId: Schema.String,
  expectedDate: LocalDate,
})
const MatchRef = Schema.Struct({
  ...OccurrenceRef.fields,
  entryId: Schema.String,
})

const recurrenceParams = { recurrenceId: Schema.String }

export class PlanningApi extends HttpApiGroup.make('planning')
  .add(
    HttpApiEndpoint.get('state', '/', {
      success: PlanningState,
      error: EndpointErrors,
    }),
    HttpApiEndpoint.put('settings', '/settings', {
      payload: Schema.Struct({
        monthlyIncomeTargetCents: Schema.optional(
          Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
        ),
        reserveMonths: Schema.optional(
          Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 36 })),
        ),
        keepReserveContributions: Schema.optional(Schema.Boolean),
      }),
      success: PlanSettings,
      error: EndpointErrors,
    }),
    HttpApiEndpoint.put('strategy', '/strategy', {
      payload: Schema.Struct({
        strategyId: Schema.String,
        allocation: Allocation,
      }),
      success: Schema.Array(Strategy),
      error: EndpointErrors,
    }),
    HttpApiEndpoint.put('setCap', '/caps/:categoryId', {
      params: { categoryId: Schema.String },
      /** Caps a spending category from `month` on; null removes the cap from it. */
      payload: Schema.Struct({
        month: Month,
        cents: Schema.NullOr(
          Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
        ),
      }),
      success: CategoryCap,
      error: EndpointErrors,
    }),
    HttpApiEndpoint.post('saveGoal', '/goals', {
      payload: Schema.Struct({
        id: Schema.optional(Schema.String),
        name: Schema.String,
        type: GoalType,
        targetCents: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
        currentCents: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
        targetDate: Schema.optional(Schema.NullOr(LocalDate)),
      }),
      success: Goal,
      error: EndpointErrors,
    }),
    HttpApiEndpoint.post('contribute', '/goals/:goalId/contributions', {
      params: { goalId: Schema.String },
      payload: Schema.Struct({
        amountCents: Schema.Int.check(Schema.isGreaterThan(0)),
        contributedOn: LocalDate,
        notes: Schema.optional(Schema.String),
      }),
      success: Goal,
      error: EndpointErrors,
    }),
    HttpApiEndpoint.post('close', '/close', {
      success: Schema.Struct({
        month: Schema.String,
        alreadyClosed: Schema.Boolean,
        /** The assistant could not write the month's analysis; retry from the assistant. */
        analysisError: Schema.Boolean,
      }),
      error: EndpointErrors,
    }),
  )
  .prefix('/api/planning') {}

export class DashboardApi extends HttpApiGroup.make('dashboard')
  .add(
    HttpApiEndpoint.get('month', '/', {
      query: { month: Schema.optional(Month) },
      success: MonthView,
      error: EndpointErrors,
    }),
    HttpApiEndpoint.get('history', '/history', {
      query: {
        months: Schema.optional(
          Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 12 })),
        ),
      },
      success: Schema.Array(MonthView),
      error: EndpointErrors,
    }),
    HttpApiEndpoint.get('spending', '/spending', {
      query: {
        /** The current month by default. */
        month: Schema.optional(Month),
        /** Instead of a month, these days, both inclusive. */
        from: Schema.optional(LocalDate),
        to: Schema.optional(LocalDate),
        /**
         * Comma-separated account ids; every account of a person or the
         * household by default (company accounts only when named).
         */
        accountIds: Schema.optional(Schema.String),
      },
      success: SpendingView,
      error: EndpointErrors,
    }),
    HttpApiEndpoint.get('instalments', '/instalments', {
      /** Every card's later bills, by due date. */
      success: Schema.Array(InstalmentBill),
      error: EndpointErrors,
    }),
    HttpApiEndpoint.get('forecast', '/forecast', {
      query: {
        days: Schema.optional(
          Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 120 })),
        ),
      },
      success: CashProjection,
      error: EndpointErrors,
    }),
  )
  .prefix('/api/dashboard') {}

export class RecurrencesApi extends HttpApiGroup.make('recurrences')
  .add(
    HttpApiEndpoint.get('book', '/', {
      success: RecurrenceBook,
      error: EndpointErrors,
    }),
    HttpApiEndpoint.post('create', '/', {
      payload: RecurrenceInput,
      success: Schema.Struct({ id: Schema.String }),
      error: EndpointErrors,
    }),
    HttpApiEndpoint.put('update', '/:recurrenceId', {
      params: recurrenceParams,
      payload: RecurrenceInput,
      success: Schema.Struct({ id: Schema.String }),
      error: EndpointErrors,
    }),
    HttpApiEndpoint.put('active', '/:recurrenceId/active', {
      params: recurrenceParams,
      payload: Schema.Struct({ active: Schema.Boolean }),
      success: Schema.Struct({ id: Schema.String }),
      error: EndpointErrors,
    }),
    HttpApiEndpoint.delete('remove', '/:recurrenceId', {
      params: recurrenceParams,
      success: HttpApiSchema.NoContent,
      error: EndpointErrors,
    }),
    HttpApiEndpoint.get('detected', '/detected', {
      success: Schema.Array(DetectedRecurrence),
      error: EndpointErrors,
    }),
    HttpApiEndpoint.post('approve', '/detected/approve', {
      payload: Schema.Struct({
        name: Schema.String,
        categoryId: Schema.String,
        amountCents: Schema.Int.check(Schema.isGreaterThan(0)),
        currency: Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/)),
        direction: Schema.Literals(['income', 'expense']),
        amountMode: Schema.Literals(['fixed', 'variable']),
        frequency: Schema.Literals(['monthly', 'yearly']),
        nextDate: LocalDate,
        accountId: Schema.NullOr(Schema.String),
        entryIds: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
      }),
      success: Schema.Struct({ id: Schema.String, linked: Schema.Int }),
      error: EndpointErrors,
    }),
    HttpApiEndpoint.post('ignore', '/detected/ignore', {
      payload: Schema.Struct({
        signature: Schema.String,
        direction: Schema.Literals(['income', 'expense']),
      }),
      success: HttpApiSchema.NoContent,
      error: EndpointErrors,
    }),
    HttpApiEndpoint.get('candidates', '/candidates', {
      query: OccurrenceRef,
      success: Schema.Array(LinkCandidate),
      error: EndpointErrors,
    }),
    HttpApiEndpoint.post('link', '/links', {
      payload: Schema.Struct({
        ...OccurrenceRef.fields,
        entryIds: Schema.Array(Schema.String).check(
          Schema.isMinLength(1),
          Schema.isMaxLength(100),
        ),
      }),
      success: Schema.Struct({ linked: Schema.Int }),
      error: EndpointErrors,
    }),
    HttpApiEndpoint.post('confirm', '/matches/confirm', {
      payload: MatchRef,
      success: HttpApiSchema.NoContent,
      error: EndpointErrors,
    }),
    HttpApiEndpoint.post('reject', '/matches/reject', {
      payload: MatchRef,
      success: HttpApiSchema.NoContent,
      error: EndpointErrors,
    }),
    HttpApiEndpoint.post('unlink', '/matches/unlink', {
      payload: MatchRef,
      success: HttpApiSchema.NoContent,
      error: EndpointErrors,
    }),
    HttpApiEndpoint.post('skip', '/occurrences/skip', {
      payload: OccurrenceRef,
      success: HttpApiSchema.NoContent,
      error: EndpointErrors,
    }),
    HttpApiEndpoint.post('complete', '/occurrences/complete', {
      payload: OccurrenceRef,
      success: HttpApiSchema.NoContent,
      error: EndpointErrors,
    }),
  )
  .prefix('/api/recurrences') {}

const Action = Schema.Struct({
  title: Schema.String,
  detail: Schema.String,
  categoryId: Schema.NullOr(Schema.String),
  proposedLimitCents: Schema.NullOr(Schema.Int),
  baselineCents: Schema.NullOr(Schema.Int),
  estimatedMonthlySavingsReais: Schema.NullOr(Schema.Number),
})

export const MonthlyAnalysis = Schema.Struct({
  headline: Schema.String,
  healthScore: Schema.Int,
  healthLabel: Schema.String,
  summary: Schema.String,
  findings: Schema.Array(
    Schema.Struct({
      title: Schema.String,
      detail: Schema.String,
      severity: Schema.Literals(['alta', 'media', 'baixa']),
    }),
  ),
  actions: Schema.Array(Action),
})
export type MonthlyAnalysis = typeof MonthlyAnalysis.Type

const Metric = Schema.Struct({ label: Schema.String, valueCents: Schema.Int })
export const FinanceAnswer = Schema.Struct({
  summary: Schema.String,
  metrics: Schema.Array(Metric),
  comparison: Schema.NullOr(
    Schema.Struct({ title: Schema.String, items: Schema.Array(Metric) }),
  ),
  nextStep: Schema.NullOr(Schema.String),
  questionnaire: Schema.NullOr(
    Schema.Struct({
      items: Schema.Array(
        Schema.Struct({
          question: Schema.String,
          description: Schema.NullOr(Schema.String),
          multiple: Schema.Boolean,
          required: Schema.Boolean,
          choices: Schema.Array(
            Schema.Struct({
              label: Schema.String,
              description: Schema.NullOr(Schema.String),
            }),
          ),
          allowOther: Schema.Boolean,
        }),
      ),
    }),
  ),
})
export type FinanceAnswer = typeof FinanceAnswer.Type

export class AssistantApi extends HttpApiGroup.make('assistant')
  .add(
    HttpApiEndpoint.get('status', '/status', {
      success: Schema.Struct({ configured: Schema.Boolean }),
      error: EndpointErrors,
    }),
    HttpApiEndpoint.post('latest', '/analysis/latest', {
      payload: Schema.Struct({ refreshInitial: Schema.Boolean }),
      success: Schema.Struct({
        month: Schema.String,
        initial: Schema.Boolean,
        analysis: Schema.NullOr(MonthlyAnalysis),
      }),
      error: EndpointErrors,
    }),
    HttpApiEndpoint.post('monthly', '/analysis/:month', {
      params: { month: Month },
      success: Schema.NullOr(MonthlyAnalysis),
      error: EndpointErrors,
    }),
    HttpApiEndpoint.post('ask', '/questions', {
      payload: Schema.Struct({
        question: Schema.String.check(
          Schema.isMinLength(3),
          Schema.isMaxLength(500),
        ),
        history: Schema.Array(
          Schema.Struct({
            role: Schema.Literals(['user', 'assistant']),
            content: Schema.String.check(Schema.isMaxLength(10_000)),
          }),
        ).check(Schema.isMaxLength(20)),
      }),
      success: FinanceAnswer,
      error: EndpointErrors,
    }),
  )
  .prefix('/api/assistant') {}
