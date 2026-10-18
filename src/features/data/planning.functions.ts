import { createServerFn } from '@tanstack/react-start'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { Allocation, GoalType, RecurrenceInput } from '@spendle/server/api'

import { api } from '#/lib/api/client.server'

const input = Schema.toStandardSchemaV1

const LocalDate = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/))
const Month = Schema.String.check(Schema.isPattern(/^\d{4}-(0[1-9]|1[0-2])$/))
const OccurrenceRef = Schema.Struct({
  recurrenceId: Schema.String,
  expectedDate: LocalDate,
})
const MatchRef = Schema.Struct({
  ...OccurrenceRef.fields,
  entryId: Schema.String,
})

// ─── Plan ─────────────────────────────────────────────────────────────────

export const planningStateFn = createServerFn({ method: 'GET' }).handler(() =>
  api((client) => client.planning.state()),
)

/** Income, reserve rule and strategy are one decision, saved together. */
export const savePlanFn = createServerFn({ method: 'POST' })
  .validator(
    input(
      Schema.Struct({
        monthlyIncomeTargetCents: Schema.Int,
        reserveMonths: Schema.Int,
        keepReserveContributions: Schema.Boolean,
        strategyId: Schema.String,
        allocation: Allocation,
      }),
    ),
  )
  .handler(({ data }) =>
    api((client) =>
      // The strategy goes first: a closed month refuses it before anything changes.
      client.planning
        .strategy({
          payload: { strategyId: data.strategyId, allocation: data.allocation },
        })
        .pipe(
          Effect.andThen(
            client.planning.settings({
              payload: {
                monthlyIncomeTargetCents: data.monthlyIncomeTargetCents,
                reserveMonths: data.reserveMonths,
                keepReserveContributions: data.keepReserveContributions,
              },
            }),
          ),
        ),
    ),
  )

export const saveGoalFn = createServerFn({ method: 'POST' })
  .validator(
    input(
      Schema.Struct({
        id: Schema.optional(Schema.String),
        name: Schema.String,
        type: GoalType,
        targetCents: Schema.Int,
        currentCents: Schema.Int,
        targetDate: Schema.optional(Schema.NullOr(LocalDate)),
      }),
    ),
  )
  .handler(({ data }) =>
    api((client) => client.planning.saveGoal({ payload: data })),
  )

/** Closes the current month; its plan is frozen from then on. */
export const closeMonthFn = createServerFn({ method: 'POST' }).handler(() =>
  api((client) => client.planning.close()),
)

// ─── Dashboard ────────────────────────────────────────────────────────────

export const monthFn = createServerFn({ method: 'GET' })
  .validator(input(Schema.Struct({ month: Schema.optional(Month) })))
  .handler(({ data }) =>
    api((client) => client.dashboard.month({ query: data })),
  )

export const monthHistoryFn = createServerFn({ method: 'GET' })
  .validator(input(Schema.Struct({ months: Schema.Int })))
  .handler(({ data }) =>
    api((client) =>
      client.dashboard.history({ query: { months: data.months } }),
    ),
  )

export const forecastFn = createServerFn({ method: 'GET' }).handler(() =>
  api((client) => client.dashboard.forecast({ query: { days: 90 } })),
)

// ─── Recurrences ──────────────────────────────────────────────────────────

export const recurrenceBookFn = createServerFn({ method: 'GET' }).handler(() =>
  api((client) => client.recurrences.book()),
)

export const saveRecurrenceFn = createServerFn({ method: 'POST' })
  .validator(
    input(
      Schema.Struct({
        id: Schema.optional(Schema.String),
        recurrence: RecurrenceInput,
      }),
    ),
  )
  .handler(({ data }) =>
    api((client) =>
      data.id === undefined
        ? client.recurrences.create({ payload: data.recurrence })
        : client.recurrences.update({
            params: { recurrenceId: data.id },
            payload: data.recurrence,
          }),
    ),
  )

export const setRecurrenceActiveFn = createServerFn({ method: 'POST' })
  .validator(
    input(Schema.Struct({ id: Schema.String, active: Schema.Boolean })),
  )
  .handler(({ data }) =>
    api((client) =>
      client.recurrences.active({
        params: { recurrenceId: data.id },
        payload: { active: data.active },
      }),
    ),
  )

export const deleteRecurrenceFn = createServerFn({ method: 'POST' })
  .validator(input(Schema.Struct({ id: Schema.String })))
  .handler(async ({ data }) => {
    await api((client) =>
      client.recurrences.remove({ params: { recurrenceId: data.id } }),
    )
    return data
  })

export const detectedRecurrencesFn = createServerFn({ method: 'GET' }).handler(
  () => api((client) => client.recurrences.detected()),
)

export const approveDetectedFn = createServerFn({ method: 'POST' })
  .validator(
    input(
      Schema.Struct({
        name: Schema.String,
        categoryId: Schema.String,
        amountCents: Schema.Int,
        currency: Schema.String,
        direction: Schema.Literals(['income', 'expense']),
        amountMode: Schema.Literals(['fixed', 'variable']),
        frequency: Schema.Literals(['monthly', 'yearly']),
        nextDate: LocalDate,
        accountId: Schema.NullOr(Schema.String),
        entryIds: Schema.Array(Schema.String),
      }),
    ),
  )
  .handler(({ data }) =>
    api((client) => client.recurrences.approve({ payload: data })),
  )

export const ignoreDetectedFn = createServerFn({ method: 'POST' })
  .validator(
    input(
      Schema.Struct({
        signature: Schema.String,
        direction: Schema.Literals(['income', 'expense']),
      }),
    ),
  )
  .handler(async ({ data }) => {
    await api((client) => client.recurrences.ignore({ payload: data }))
    return data
  })

export const linkCandidatesFn = createServerFn({ method: 'GET' })
  .validator(input(OccurrenceRef))
  .handler(({ data }) =>
    api((client) => client.recurrences.candidates({ query: data })),
  )

export const linkPaymentsFn = createServerFn({ method: 'POST' })
  .validator(
    input(
      Schema.Struct({
        ...OccurrenceRef.fields,
        entryIds: Schema.Array(Schema.String),
      }),
    ),
  )
  .handler(({ data }) =>
    api((client) => client.recurrences.link({ payload: data })),
  )

export const confirmMatchFn = createServerFn({ method: 'POST' })
  .validator(input(MatchRef))
  .handler(async ({ data }) => {
    await api((client) => client.recurrences.confirm({ payload: data }))
    return data
  })

export const rejectMatchFn = createServerFn({ method: 'POST' })
  .validator(input(MatchRef))
  .handler(async ({ data }) => {
    await api((client) => client.recurrences.reject({ payload: data }))
    return data
  })

export const unlinkMatchFn = createServerFn({ method: 'POST' })
  .validator(input(MatchRef))
  .handler(async ({ data }) => {
    await api((client) => client.recurrences.unlink({ payload: data }))
    return data
  })

export const skipOccurrenceFn = createServerFn({ method: 'POST' })
  .validator(input(OccurrenceRef))
  .handler(async ({ data }) => {
    await api((client) => client.recurrences.skip({ payload: data }))
    return data
  })

export const completeOccurrenceFn = createServerFn({ method: 'POST' })
  .validator(input(OccurrenceRef))
  .handler(async ({ data }) => {
    await api((client) => client.recurrences.complete({ payload: data }))
    return data
  })

// ─── Assistant ────────────────────────────────────────────────────────────

export const assistantStatusFn = createServerFn({ method: 'GET' }).handler(() =>
  api((client) => client.assistant.status()),
)

export const latestAnalysisFn = createServerFn({ method: 'POST' })
  .validator(input(Schema.Struct({ refreshInitial: Schema.Boolean })))
  .handler(({ data }) =>
    api((client) => client.assistant.latest({ payload: data })),
  )

export const monthlyAnalysisFn = createServerFn({ method: 'POST' })
  .validator(input(Schema.Struct({ month: Month })))
  .handler(({ data }) =>
    api((client) => client.assistant.monthly({ params: data })),
  )

export const askAssistantFn = createServerFn({ method: 'POST' })
  .validator(
    input(
      Schema.Struct({
        question: Schema.String,
        history: Schema.Array(
          Schema.Struct({
            role: Schema.Literals(['user', 'assistant']),
            content: Schema.String,
          }),
        ),
      }),
    ),
  )
  .handler(({ data }) =>
    api((client) => client.assistant.ask({ payload: data })),
  )
