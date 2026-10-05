import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'

import { Assistant } from '../../planning/Assistant.ts'
import { Dashboard } from '../../planning/Dashboard.ts'
import { Planning } from '../../planning/Planning.ts'
import { Recurrences } from '../../planning/Recurrences.ts'
import { SpendleApi } from '../definition/Api.ts'
import { respond } from '../Failures.ts'

const settingsOf = (settings: {
  readonly monthlyIncomeTargetCents: number
  readonly reserveMonths: number
  readonly keepReserveContributions: boolean
}) => ({
  monthlyIncomeTargetCents: settings.monthlyIncomeTargetCents,
  reserveMonths: settings.reserveMonths,
  keepReserveContributions: settings.keepReserveContributions,
})

export const PlanningHandlers = HttpApiBuilder.group(
  SpendleApi,
  'planning',
  Effect.fn(function* (handlers) {
    const planning = yield* Planning
    const dashboard = yield* Dashboard
    const assistant = yield* Assistant
    return handlers.handleAll({
      state: () =>
        Effect.all({
          settings: Effect.map(planning.settings, settingsOf),
          strategies: planning.strategies,
          budgets: planning.budgets,
          goals: planning.goals,
        }).pipe(respond('planning.state')),
      settings: ({ payload }) =>
        planning
          .updateSettings(payload)
          .pipe(Effect.map(settingsOf), respond('planning.settings')),
      strategy: ({ payload }) =>
        planning.activateStrategy(payload).pipe(respond('planning.strategy')),
      saveGoal: ({ payload }) =>
        planning.saveGoal(payload).pipe(respond('planning.saveGoal')),
      contribute: ({ params, payload }) =>
        planning
          .addContribution({ goalId: params.goalId, ...payload })
          .pipe(respond('planning.contribute')),
      // A closing that worked stays closed when the assistant fails to write about it.
      close: () =>
        Effect.gen(function* () {
          const result = yield* dashboard.close()
          if (result.alreadyClosed || !assistant.status.configured)
            return { ...result, analysisError: false }
          const analysis = yield* assistant.monthly(result.month).pipe(
            Effect.tapError((error) => Effect.logWarning(error.message)),
            Effect.option,
          )
          return { ...result, analysisError: Option.isNone(analysis) }
        }).pipe(respond('planning.close')),
    })
  }),
)

export const DashboardHandlers = HttpApiBuilder.group(
  SpendleApi,
  'dashboard',
  Effect.fn(function* (handlers) {
    const dashboard = yield* Dashboard
    return handlers.handleAll({
      month: ({ query }) =>
        dashboard.month(query.month).pipe(respond('dashboard.month')),
      history: ({ query }) =>
        dashboard
          .history(query.months ?? 11)
          .pipe(respond('dashboard.history')),
      forecast: ({ query }) =>
        dashboard
          .forecast(query.days ?? 90)
          .pipe(respond('dashboard.forecast')),
    })
  }),
)

export const RecurrencesHandlers = HttpApiBuilder.group(
  SpendleApi,
  'recurrences',
  Effect.fn(function* (handlers) {
    const recurrences = yield* Recurrences
    return handlers.handleAll({
      book: () => recurrences.view().pipe(respond('recurrences.book')),
      create: ({ payload }) =>
        recurrences.create(payload).pipe(
          Effect.map((id) => ({ id })),
          respond('recurrences.create'),
        ),
      update: ({ params, payload }) =>
        recurrences.update(params.recurrenceId, payload).pipe(
          Effect.map((id) => ({ id })),
          respond('recurrences.update'),
        ),
      active: ({ params, payload }) =>
        recurrences.setActive(params.recurrenceId, payload.active).pipe(
          Effect.map((id) => ({ id })),
          respond('recurrences.active'),
        ),
      remove: ({ params }) =>
        recurrences
          .remove(params.recurrenceId)
          .pipe(Effect.asVoid, respond('recurrences.remove')),
      detected: () =>
        recurrences.detected().pipe(respond('recurrences.detected')),
      approve: ({ payload }) =>
        recurrences.approve(payload).pipe(respond('recurrences.approve')),
      ignore: ({ payload }) =>
        recurrences.ignore(payload).pipe(respond('recurrences.ignore')),
      candidates: ({ query }) =>
        recurrences.candidates(query).pipe(respond('recurrences.candidates')),
      link: ({ payload }) =>
        recurrences
          .link(
            {
              recurrenceId: payload.recurrenceId,
              expectedDate: payload.expectedDate,
            },
            payload.entryIds,
          )
          .pipe(
            Effect.map((linked) => ({ linked })),
            respond('recurrences.link'),
          ),
      confirm: ({ payload }) =>
        recurrences.confirm(payload).pipe(respond('recurrences.confirm')),
      reject: ({ payload }) =>
        recurrences.reject(payload).pipe(respond('recurrences.reject')),
      unlink: ({ payload }) =>
        recurrences.unlink(payload).pipe(respond('recurrences.unlink')),
      skip: ({ payload }) =>
        recurrences.skip(payload).pipe(respond('recurrences.skip')),
      complete: ({ payload }) =>
        recurrences.complete(payload).pipe(respond('recurrences.complete')),
    })
  }),
)

export const AssistantHandlers = HttpApiBuilder.group(
  SpendleApi,
  'assistant',
  Effect.fn(function* (handlers) {
    const assistant = yield* Assistant
    return handlers.handleAll({
      status: () => Effect.succeed({ configured: assistant.status.configured }),
      latest: ({ payload }) =>
        assistant
          .latest(payload.refreshInitial)
          .pipe(respond('assistant.latest')),
      monthly: ({ params }) =>
        assistant
          .monthly(params.month)
          .pipe(Effect.map(Option.getOrNull), respond('assistant.monthly')),
      ask: ({ payload }) =>
        assistant
          .ask(payload.question, payload.history)
          .pipe(respond('assistant.ask')),
    })
  }),
)
