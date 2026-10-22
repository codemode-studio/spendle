import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import { monthStart, today } from '../domain/LocalDate.ts'
import { Investments } from '../investments/Investments.ts'
import { baseCurrency } from '../rates/Conversion.ts'
import { ExchangeRates } from '../rates/ExchangeRates.ts'
import type { RateNeed } from '../rates/ExchangeRates.ts'
import { Cards } from '../reconciliation/Cards.ts'
import { LedgerReads } from './LedgerReads.ts'
import { buildMonth, indexFacts, projectCash } from './Month.ts'
import type { MonthCycle, MonthFacts, MonthInstallment } from './Month.ts'
import { Planning, PlanningError } from './Planning.ts'
import { Recurrences } from './Recurrences.ts'

/**
 * The monthly picture and the cash forecast, read from the ledger, card
 * cycles, recurrences and the plan in one pass. Nothing here writes except
 * closing a month, which freezes its plan through `Planning`.
 */
const make = Effect.gen(function* () {
  const reads = yield* LedgerReads
  const planning = yield* Planning
  const recurrences = yield* Recurrences
  const cards = yield* Cards
  const investments = yield* Investments
  const exchangeRates = yield* ExchangeRates

  const facts = Effect.gen(function* () {
    const [day, accounts, entries, relations, checkpoints, categories] =
      yield* Effect.all([
        today,
        reads.accounts,
        reads.entries,
        reads.relations,
        reads.checkpoints,
        reads.categories,
      ])
    const { book } = yield* recurrences.load({ entries, relations })
    const cycles: Array<MonthCycle> = []
    const installments: Array<MonthInstallment> = []
    for (const account of accounts) {
      if (account.card === null) continue
      const [cardCycles, plans] = yield* Effect.all([
        cards.cycles(account.id),
        cards.installments(account.id),
      ])
      for (const cycle of cardCycles.cycles)
        cycles.push({
          accountId: account.id,
          closingOn: cycle.closingOn,
          dueOn: cycle.dueOn,
          // A bill still pending at the provider is what the month will owe.
          billedCents: cycle.projectedCents,
          paidCents: cycle.paidCents,
          entryIds: cycle.entryIds,
        })
      for (const plan of plans)
        installments.push({
          accountId: account.id,
          amountCents: plan.amountCents,
          total: plan.total,
          seen: plan.seen,
          scheduled: plan.scheduled,
          entryIds: plan.entryIds,
          lastBookedOn: plan.lastBookedOn,
        })
    }
    // Every other currency from the first day a value in it needs a rate.
    const currencyOf = new Map(
      accounts.map((account) => [account.id, account.currency]),
    )
    const needs: Array<RateNeed> = [
      ...entries.map((entry) => ({
        currency: entry.currency,
        from: entry.bookedOn,
      })),
      ...checkpoints.map((checkpoint) => ({
        currency: currencyOf.get(checkpoint.accountId) ?? baseCurrency,
        from: checkpoint.asOf,
      })),
      ...accounts.map((account) => ({ currency: account.currency, from: day })),
      ...book.map(({ rule }) => ({
        currency: rule.currency,
        from: rule.startsOn < day ? rule.startsOn : day,
      })),
    ].filter((need) => need.currency !== baseCurrency)
    const [settings, strategies, budgets, goals, invested, rates] =
      yield* Effect.all([
        planning.settings,
        planning.strategies,
        planning.budgets,
        planning.goalsForPlan,
        investments.snapshot(day),
        exchangeRates.table(needs),
      ])
    return {
      today: day,
      accounts,
      entries,
      relations,
      cycles,
      installments,
      checkpoints,
      book,
      settings,
      strategies,
      budgets,
      goals,
      reserveInvestedCents:
        invested.summary.reservePositionCount > 0
          ? invested.summary.reserveBrlCents
          : null,
      categoryBuckets: new Map(
        categories.map((category) => [category.id, category.bucket]),
      ),
      rates,
    } satisfies MonthFacts
  }).pipe(Effect.withSpan('Dashboard.facts'))

  /** One month, the current one by default. */
  const month = Effect.fn('Dashboard.month')(function* (month?: string) {
    const loaded = yield* facts
    return buildMonth(loaded, month ?? loaded.today.slice(0, 7))
  })

  /** The `months` months before the current one, latest first, without their lines. */
  const history = Effect.fn('Dashboard.history')(function* (months: number) {
    const loaded = yield* facts
    const index = indexFacts(loaded)
    return Array.from({ length: months }, (_, offset) => {
      const view = buildMonth(
        loaded,
        monthStart(loaded.today, -(offset + 1)).slice(0, 7),
        index,
      )
      return { ...view, family: { ...view.family, lines: [] } }
    })
  })

  const forecast = Effect.fn('Dashboard.forecast')(function* (daysAhead = 90) {
    return projectCash(yield* facts, { daysBack: 14, daysAhead })
  })

  /**
   * Closes the current month: refused while anything blocks it, and once
   * closed its strategy, allocation and income stay as they were.
   */
  const close = Effect.fn('Dashboard.close')(function* () {
    const loaded = yield* facts
    const current = loaded.today.slice(0, 7)
    if (loaded.budgets.some((budget) => budget.month === current))
      return { month: current, alreadyClosed: true }
    const view = buildMonth(loaded, current)
    if (view.integrity.closingBlockerCount > 0)
      return yield* new PlanningError({
        reason: 'closing_blocked',
        detail: String(view.integrity.closingBlockerCount),
      })
    yield* planning.freeze({
      month: current,
      strategyId: view.strategy.id,
      strategyName: view.strategy.name,
      baseIncomeCents: view.baseIncomeCents,
      eligibleIncomeCents: view.incomeCents,
      allocation: view.allocation,
      effectiveAllocation: view.effectiveAllocation,
      reserveRedirected: view.reserve.redirected,
    })
    return { month: current, alreadyClosed: false }
  })

  return { facts, month, history, forecast, close }
})

export class Dashboard extends Context.Service<
  Dashboard,
  Effect.Success<typeof make>
>()('@spendle/server/planning/Dashboard') {
  static readonly layer = Layer.effect(Dashboard, make)
}
