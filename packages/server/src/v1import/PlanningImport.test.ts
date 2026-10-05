import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, describe, it } from '@effect/vitest'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as TestClock from 'effect/testing/TestClock'

import { Imports } from '../imports/Imports.ts'
import { Accounts } from '../ledger/Accounts.ts'
import { Dashboard } from '../planning/Dashboard.ts'
import { Planning } from '../planning/Planning.ts'
import { Recurrences } from '../planning/Recurrences.ts'
import { drain, planningTest } from '../testing/FakePluggy.ts'
import { makeV1Database, writeV1 } from '../testing/V1Fixture.ts'
import { checkingStatement, seedV1 } from '../testing/V1Scenario.ts'
import * as PlanningImport from './PlanningImport.ts'
import { readV1 } from './V1Database.ts'
import { V1Import } from './V1Import.ts'

const MigrationTest = PlanningImport.reactor.pipe(
  Layer.provideMerge(PlanningImport.V1PlanningImport.layer),
  Layer.provideMerge(V1Import.layer),
  Layer.provideMerge(planningTest()),
  Layer.provideMerge(NodeServices.layer),
)

// The scenario's household with a plan: income, a strategy, a closed month,
// a goal, and a market recurrence with one linked payment and one skip.
const v1Database = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const dir = yield* fs.makeTempDirectoryScoped()
  const path = yield* makeV1Database(dir, seedV1)
  yield* writeV1(path, (v1) =>
    Effect.gen(function* () {
      yield* v1.upsert('app_settings', {
        id: 'default',
        monthly_income_target_cents: 1_200_000,
        reserve_months: 4,
        keep_reserve_contributions: 1,
        ai_classification_consent: 1,
      })
      yield* v1.upsert('budget_strategies', {
        id: 'strategy-wealth',
        template: 'wealth',
        name: 'Patrimonial',
        essential_bps: 3_000,
        lifestyle_bps: 2_500,
        investment_bps: 3_500,
        reserve_bps: 1_000,
        is_default: 1,
      })
      yield* v1.insert('monthly_budgets', {
        id: 'august',
        month: '2026-08',
        strategy_id: 'strategy-wealth',
        base_income_cents: 1_000_000,
        eligible_income_cents: 1_050_000,
        essential_bps: 3_000,
        lifestyle_bps: 2_500,
        investment_bps: 3_500,
        reserve_bps: 1_000,
        effective_investment_bps: 3_500,
        effective_reserve_bps: 1_000,
        closed: 1,
      })
      yield* v1.insert('investment_goals', {
        id: 'trip',
        name: 'Viagem',
        type: 'medium_term',
        target_cents: 900_000,
        current_cents: 150_000,
        target_date: '2027-06-01',
      })
      yield* v1.insert('recurrences', {
        id: 'market',
        name: 'Mercado do mês',
        account_id: 'checking',
        category_id: 'groceries',
        amount_cents: 1_500,
        frequency: 'monthly',
        starts_on: '2026-08-10',
        schedule_anchor: '2026-08-10',
        next_date: '2026-10-10',
      })
      for (const [id, date, status] of [
        ['market-aug', '2026-08-10', 'skipped'],
        ['market-sep', '2026-09-10', 'matched'],
        ['market-oct', '2026-10-10', 'expected'],
      ] as const)
        yield* v1.insert('recurrence_occurrences', {
          id,
          recurrence_id: 'market',
          expected_date: date,
          expected_amount_cents: 1_500,
          currency: 'BRL',
          direction: 'expense',
          category_id: 'groceries',
          status,
        })
      yield* v1.insert('recurrence_matches', {
        id: 'market-sep-link',
        occurrence_id: 'market-sep',
        transaction_id: 'review',
        status: 'confirmed',
        score: 100,
        reason: 'vinculado manualmente',
      })
      yield* v1.insert('recurrence_detection_ignores', {
        id: 'ignore-cafe',
        signature: 'cafe',
        direction: 'expense',
      })
    }),
  )
  return path
})

describe('V1 planning import', () => {
  it.effect(
    'brings the plan, closed months, goals and linked recurrence payments over',
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(
          DateTime.toEpochMillis(DateTime.makeUnsafe('2026-09-20T15:00:00Z')),
        )
        const path = yield* v1Database
        yield* (yield* V1Import).run(yield* readV1(path))
        const summary = yield* (yield* PlanningImport.V1PlanningImport).run(
          yield* readV1(path),
        )

        const checking = (yield* (yield* Accounts).list).find(
          (account) => account.name === 'Conta Nubank',
        )!
        yield* (yield* Imports).importFile({
          accountId: checking.id,
          fileName: 'nubank.ofx',
          bytes: checkingStatement,
        })
        yield* drain

        const planning = yield* Planning
        const market = (yield* (yield* Recurrences).view()).recurrences.find(
          (recurrence) => recurrence.name === 'Mercado do mês',
        )!
        const august = yield* (yield* Dashboard).month('2026-08')
        const again = yield* (yield* PlanningImport.V1PlanningImport).run(
          yield* readV1(path),
        )

        assert.deepStrictEqual(
          {
            moved: [
              summary.settings.migrated,
              summary.strategies.migrated,
              summary.budgets.migrated,
              summary.goals.migrated,
              summary.recurrences.migrated,
              summary.skippedOccurrences.migrated,
              summary.ignores.migrated,
              summary.links.migrated,
            ],
            // The scenario's rent recurrence has no category: it stays behind with a reason.
            left: summary.unmapped.map((item) => [item.kind, item.v1Id]),
            settings: { ...(yield* planning.settings) },
            strategy: (yield* planning.strategies).find(
              (strategy) => strategy.isDefault,
            )?.allocation,
            august: [
              august.closed,
              august.baseIncomeCents,
              august.strategy.id,
              august.targets.essential,
            ],
            goal: (yield* planning.goals).map((goal) => [
              goal.name,
              goal.currentCents,
              goal.targetCents,
            ]),
            market: market.occurrences.map((occurrence) => [
              occurrence.expectedDate,
              occurrence.status,
              occurrence.matches.map((match) => [
                match.entry.description,
                match.status,
              ]),
            ]),
            again: [
              again.recurrences.migrated,
              again.links.migrated,
              again.pending.links.applied,
            ],
          },
          {
            moved: [1, 1, 1, 2, 1, 1, 1, 1],
            left: [['recurrence', 'rent']],
            settings: {
              monthlyIncomeTargetCents: 1_200_000,
              reserveMonths: 4,
              keepReserveContributions: true,
            },
            strategy: {
              essential: 3_000,
              lifestyle: 2_500,
              investment: 3_500,
              reserve: 1_000,
            },
            august: [true, 1_000_000, 'strategy-wealth', 300_000],
            // The shared scenario's emergency reserve goal comes over too.
            goal: [
              ['Reserva de emergência', 0, 3_000_000],
              ['Viagem', 150_000, 900_000],
            ],
            market: [
              ['2026-08-10', 'skipped', []],
              ['2026-09-10', 'matched', [['MERCADO CENTRAL', 'confirmed']]],
              ['2026-10-10', 'expected', []],
            ],
            again: [0, 0, 1],
          },
        )
      }).pipe(Effect.scoped, Effect.provide(MigrationTest)),
  )
})
