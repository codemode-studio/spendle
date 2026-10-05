import * as Context from 'effect/Context'
import * as Crypto from 'effect/Crypto'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'

import { Categories } from '../categories/Categories.ts'
import * as Reactor from '../events/Reactor.ts'
import { foldDescription } from '../imports/Statement.ts'
import { Accounts } from '../ledger/Accounts.ts'
import { Entries, entriesResolved } from '../ledger/Entries.ts'
import type { LedgerEntry } from '../ledger/Entries.ts'
import { isValidAllocation, strategyTemplates } from '../planning/Budget.ts'
import { Planning } from '../planning/Planning.ts'
import { Recurrences } from '../planning/Recurrences.ts'
import { formatCents, recognise } from './Plan.ts'
import type { Movement, Unmapped } from './Plan.ts'
import type { V1Recurrence, V1Snapshot } from './V1Database.ts'
import type { PendingTally, Tally, Waiting } from './V1Import.ts'

export interface PlanningSummary {
  readonly settings: Tally
  readonly strategies: Tally
  readonly budgets: Tally
  readonly goals: Tally
  readonly recurrences: Tally
  readonly aliases: Tally
  readonly skippedOccurrences: Tally
  readonly ignores: Tally
  readonly links: Tally
  readonly unmapped: ReadonlyArray<Unmapped>
  readonly pending: {
    readonly links: PendingTally
    readonly waiting: ReadonlyArray<Waiting>
  }
}

const MapKind = Schema.Literals([
  'settings',
  'strategy',
  'budget',
  'goal',
  'recurrence_group',
  'recurrence',
  'recurrence_alias',
  'occurrence_skip',
  'detection_ignore',
])
type MapKind = typeof MapKind.Type

const tally = () => ({ migrated: 0, already: 0, skipped: 0 })
const goalTypes = new Set([
  'emergency_reserve',
  'medium_term',
  'retirement',
  'other',
])
const isTemplate = (
  value: string | null,
): value is (typeof strategyTemplates)[number] =>
  value !== null && (strategyTemplates as ReadonlyArray<string>).includes(value)
const incomeBuckets = new Set(['income'])
const expenseBuckets = new Set(['essential', 'lifestyle', 'tax', 'business'])

/**
 * Brings V1's plan over: income target and reserve rule, strategy shares,
 * closed months (frozen as they were), goals, recurrences with the
 * merchants and skips the person decided, detection ignores, and the
 * payments the person linked, which apply once their movements arrive.
 * The AI consent setting is not migrated: the assistant needs none.
 */
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const crypto = yield* Crypto.Crypto
  const planning = yield* Planning
  const recurrences = yield* Recurrences
  const accounts = yield* Accounts
  const categories = yield* Categories
  const entries = yield* Entries
  const now = Effect.map(DateTime.now, DateTime.formatIso)

  const findMapped = SqlSchema.findAll({
    Request: MapKind,
    Result: Schema.Struct({ v1Id: Schema.String, v2Id: Schema.String }),
    execute: (kind) =>
      sql`SELECT v1_id AS v1Id, v2_id AS v2Id FROM v1_import_planning_map WHERE kind = ${kind}`,
  })
  const mapped = (kind: MapKind) =>
    Effect.map(
      findMapped(kind),
      (rows) => new Map(rows.map((row) => [row.v1Id, row.v2Id])),
    )
  const remember = (kind: MapKind, v1Id: string, v2Id: string) =>
    Effect.gen(function* () {
      yield* sql`
        INSERT INTO v1_import_planning_map (kind, v1_id, v2_id, imported_at)
        VALUES (${kind}, ${v1Id}, ${v2Id}, ${yield* now})
        ON CONFLICT (kind, v1_id) DO NOTHING
      `
    })
  const findAccountMap = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({
      kind: Schema.String,
      v1Id: Schema.String,
      v2Id: Schema.String,
    }),
    execute: () =>
      sql`SELECT kind, v1_id AS v1Id, v2_id AS v2Id FROM v1_import_map WHERE kind IN ('account', 'card')`,
  })
  const findMovement = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({
      v1TransactionId: Schema.String,
      accountId: Schema.String,
      bookedOn: Schema.String,
      amountCents: Schema.Int,
      descriptionKey: Schema.String,
      description: Schema.String,
      uniqueByDescription: Schema.BooleanFromBit,
      uniqueByAmount: Schema.BooleanFromBit,
    }),
    execute: (id) => sql`
      SELECT v1_transaction_id AS v1TransactionId, account_id AS accountId, booked_on AS bookedOn,
        amount_cents AS amountCents, description_key AS descriptionKey, description,
        unique_by_description AS uniqueByDescription, unique_by_amount AS uniqueByAmount
      FROM v1_import_movements WHERE v1_transaction_id = ${id}
    `,
  })
  const findPendingLinks = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({
      v1MatchId: Schema.String,
      recurrenceId: Schema.String,
      expectedDate: Schema.String,
      v1TransactionId: Schema.String,
      status: Schema.Literals(['pending', 'applied', 'superseded', 'refused']),
    }),
    execute: () => sql`
      SELECT v1_match_id AS v1MatchId, recurrence_id AS recurrenceId, expected_date AS expectedDate,
        v1_transaction_id AS v1TransactionId, status
      FROM v1_import_recurrence_links ORDER BY v1_match_id
    `,
  })
  // A verdict the person already gave in V2 about this occurrence and entry.
  const findVerdicts = SqlSchema.findAll({
    Request: Schema.Struct({
      recurrenceId: Schema.String,
      expectedDate: Schema.String,
      entryId: Schema.String,
    }),
    Result: Schema.Struct({ origin: Schema.String }),
    execute: ({ recurrenceId, expectedDate, entryId }) => sql`
      SELECT DISTINCT d.origin FROM recurrence_link_decisions d
      JOIN recurrence_link_endpoints p ON p.key = d.key
      JOIN entry_evidence v ON v.source_id = p.source_id AND v.account_id = p.account_id
        AND v.external_id = p.external_id
      WHERE d.recurrence_id = ${recurrenceId} AND d.expected_date = ${expectedDate}
        AND v.entry_id = ${entryId}
    `,
  })

  /** Applies waiting V1 links whose movement V2 now holds as exactly one entry. */
  const applyPending = Effect.fn('V1PlanningImport.applyPending')(function* () {
    const counts = { applied: 0, pending: 0, superseded: 0, refused: 0 }
    const waiting: Array<Waiting> = []
    const entriesOf = new Map<string, ReadonlyArray<LedgerEntry>>()
    for (const row of yield* findPendingLinks(undefined)) {
      if (row.status !== 'pending') {
        counts[row.status]++
        continue
      }
      const movement = yield* findMovement(row.v1TransactionId)
      if (movement._tag === 'None') {
        counts.pending++
        continue
      }
      const found: Movement = movement.value
      let list = entriesOf.get(found.accountId)
      if (list === undefined) {
        list = yield* entries.entries(found.accountId)
        entriesOf.set(found.accountId, list)
      }
      const recognised = recognise(found, list)
      if (recognised._tag !== 'Entry') {
        counts.pending++
        waiting.push({
          kind: 'recurrence_link',
          v1Id: row.v1MatchId,
          label: `recurrence payment ${found.bookedOn} ${formatCents(found.amountCents)} ${found.description}`,
          reason: recognised._tag === 'Missing' ? 'not_observed' : 'ambiguous',
        })
        continue
      }
      const ref = {
        recurrenceId: row.recurrenceId,
        expectedDate: row.expectedDate,
        entryId: recognised.entryId,
      }
      const decided = yield* findVerdicts(ref)
      const status = decided.some((verdict) => verdict.origin !== 'v1_import')
        ? 'superseded'
        : 'applied'
      if (status === 'applied' && decided.length === 0)
        yield* recurrences.importLink(ref)
      yield* sql`
        UPDATE v1_import_recurrence_links SET status = ${status}, entry_id = ${recognised.entryId},
          resolved_at = ${yield* now}
        WHERE v1_match_id = ${row.v1MatchId}
      `
      counts[status]++
    }
    return { links: counts, waiting }
  })

  const run = Effect.fn('V1PlanningImport.run')(function* (
    snapshot: V1Snapshot,
  ) {
    const source = snapshot.planning
    const unmapped: Array<Unmapped> = []
    const result = {
      settings: tally(),
      strategies: tally(),
      budgets: tally(),
      goals: tally(),
      recurrences: tally(),
      aliases: tally(),
      skippedOccurrences: tally(),
      ignores: tally(),
      links: tally(),
    }

    if (source.settings !== null) {
      if ((yield* mapped('settings')).has('default')) result.settings.already++
      else {
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* planning.updateSettings({
              monthlyIncomeTargetCents: Math.max(
                0,
                source.settings!.monthlyIncomeTargetCents,
              ),
              reserveMonths: Math.min(
                36,
                Math.max(1, source.settings!.reserveMonths),
              ),
              keepReserveContributions:
                source.settings!.keepReserveContributions,
            })
            yield* remember('settings', 'default', 'default')
          }),
        )
        result.settings.migrated++
      }
    }

    const knownStrategies = yield* mapped('strategy')
    for (const strategy of source.strategies) {
      if (knownStrategies.has(strategy.id)) {
        result.strategies.already++
        continue
      }
      const allocation = {
        essential: strategy.essentialBps,
        lifestyle: strategy.lifestyleBps,
        investment: strategy.investmentBps,
        reserve: strategy.reserveBps,
      }
      if (!isTemplate(strategy.template) || !isValidAllocation(allocation)) {
        result.strategies.skipped++
        unmapped.push({
          kind: 'strategy',
          v1Id: strategy.id,
          label: strategy.name,
          reason: 'unknown template or shares not adding to 100%',
        })
        continue
      }
      const id = `strategy-${strategy.template}`
      yield* sql.withTransaction(
        Effect.gen(function* () {
          if (strategy.isDefault)
            yield* sql`UPDATE budget_strategies SET is_default = 0`
          yield* sql`
            UPDATE budget_strategies SET essential_bps = ${allocation.essential},
              lifestyle_bps = ${allocation.lifestyle}, investment_bps = ${allocation.investment},
              reserve_bps = ${allocation.reserve},
              is_default = ${strategy.isDefault ? 1 : sql.literal('is_default')}
            WHERE id = ${id}
          `
          yield* remember('strategy', strategy.id, id)
        }),
      )
      result.strategies.migrated++
    }

    const knownBudgets = yield* mapped('budget')
    const closed = new Set(
      (yield* planning.budgets).map((budget) => budget.month),
    )
    for (const budget of source.budgets) {
      if (knownBudgets.has(budget.id) || closed.has(budget.month)) {
        result.budgets.already++
        continue
      }
      const allocation = {
        essential: budget.essentialBps,
        lifestyle: budget.lifestyleBps,
        investment: budget.investmentBps,
        reserve: budget.reserveBps,
      }
      if (
        !/^\d{4}-(0[1-9]|1[0-2])$/.test(budget.month) ||
        !isValidAllocation(allocation)
      ) {
        result.budgets.skipped++
        unmapped.push({
          kind: 'budget',
          v1Id: budget.id,
          label: budget.month,
          reason: 'invalid month or shares',
        })
        continue
      }
      const template = isTemplate(budget.strategyTemplate)
        ? budget.strategyTemplate
        : 'balanced'
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* planning.freeze(
            {
              month: budget.month,
              strategyId: `strategy-${template}`,
              strategyName: budget.strategyName ?? 'Equilibrada',
              baseIncomeCents: budget.baseIncomeCents,
              eligibleIncomeCents: budget.eligibleIncomeCents ?? 0,
              allocation,
              effectiveAllocation: {
                ...allocation,
                investment: budget.effectiveInvestmentBps,
                reserve: budget.effectiveReserveBps,
              },
              reserveRedirected: budget.reserveRedirected,
            },
            'v1_import',
          )
          yield* remember('budget', budget.id, budget.month)
        }),
      )
      result.budgets.migrated++
    }

    const knownGoals = yield* mapped('goal')
    for (const goal of source.goals) {
      if (knownGoals.has(goal.id)) {
        result.goals.already++
        continue
      }
      if (!goalTypes.has(goal.type) || goal.name.trim().length < 2) {
        result.goals.skipped++
        unmapped.push({
          kind: 'goal',
          v1Id: goal.id,
          label: goal.name,
          reason: `unknown type ${goal.type} or short name`,
        })
        continue
      }
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const saved = yield* planning.saveGoal({
            name: goal.name,
            type: goal.type as 'emergency_reserve',
            targetCents: Math.max(0, goal.targetCents),
            currentCents: Math.max(0, goal.currentCents),
            targetDate:
              goal.targetDate && /^\d{4}-\d{2}-\d{2}$/.test(goal.targetDate)
                ? goal.targetDate
                : null,
          })
          yield* remember('goal', goal.id, saved.id)
        }),
      )
      result.goals.migrated++
    }

    // Groups only where a migrated recurrence uses them.
    const knownGroups = yield* mapped('recurrence_group')
    const groupId = (v1Id: string | null) =>
      Effect.gen(function* () {
        if (v1Id === null) return null
        const known = knownGroups.get(v1Id)
        if (known) return known
        const group = source.groups.find((item) => item.id === v1Id)
        if (!group || group.name.trim() === '') return null
        const key = foldDescription(group.name.trim())
        yield* sql`
          INSERT INTO recurrence_groups (id, name, name_key, created_at)
          VALUES (${yield* crypto.randomUUIDv7.pipe(Effect.orDie)}, ${group.name.trim()}, ${key}, ${yield* now})
          ON CONFLICT (name_key) DO NOTHING
        `
        const id = (yield* sql<{
          id: string
        }>`SELECT id FROM recurrence_groups WHERE name_key = ${key}`)[0]!.id
        yield* remember('recurrence_group', v1Id, id)
        knownGroups.set(v1Id, id)
        return id
      })

    const accountMap = new Map(
      (yield* findAccountMap(undefined)).map((row) => [
        `${row.kind}:${row.v1Id}`,
        row.v2Id,
      ]),
    )
    const v2Categories = new Map(
      (yield* categories.list).map((category) => [category.id, category]),
    )
    const knownRecurrences = yield* mapped('recurrence')
    const recurrenceIssue = (
      recurrence: V1Recurrence,
      accountId: string | null,
    ) => {
      const category = recurrence.categoryId
        ? v2Categories.get(recurrence.categoryId)
        : undefined
      const buckets =
        recurrence.direction === 'income' ? incomeBuckets : expenseBuckets
      if (
        !category ||
        !category.active ||
        category.system ||
        !buckets.has(category.bucket)
      )
        return 'its category is missing, archived or does not fit the direction in V2'
      if ((recurrence.accountId || recurrence.cardId) && accountId === null)
        return 'its account or card was not migrated'
      if (recurrence.destinationMode === 'fixed' && accountId === null)
        return 'fixed destination without an account'
      if (
        !/^[A-Z]{3}$/.test(recurrence.currency) ||
        recurrence.amountCents === 0
      )
        return 'invalid currency or amount'
      return null
    }
    for (const recurrence of source.recurrences) {
      if (knownRecurrences.has(recurrence.id)) {
        result.recurrences.already++
        continue
      }
      const accountId = recurrence.accountId
        ? (accountMap.get(`account:${recurrence.accountId}`) ?? null)
        : recurrence.cardId
          ? (accountMap.get(`card:${recurrence.cardId}`) ?? null)
          : null
      const issue = recurrenceIssue(recurrence, accountId)
      if (issue !== null) {
        result.recurrences.skipped++
        unmapped.push({
          kind: 'recurrence',
          v1Id: recurrence.id,
          label: recurrence.name,
          reason: issue,
        })
        continue
      }
      if (
        accountId !== null &&
        (yield* accounts.get(accountId)).currency !== recurrence.currency
      ) {
        result.recurrences.skipped++
        unmapped.push({
          kind: 'recurrence',
          v1Id: recurrence.id,
          label: recurrence.name,
          reason: 'its account is in another currency',
        })
        continue
      }
      // The schedule restarts at the first occurrence V1 still expected, so
      // occurrences V1 settled by itself do not come back as debts. Links
      // the person confirmed keep their earlier dates as history.
      const open = source.occurrences
        .filter(
          (occurrence) =>
            occurrence.recurrenceId === recurrence.id &&
            occurrence.status === 'expected',
        )
        .map((occurrence) => occurrence.expectedDate)
        .sort()
      const startsOn = open[0] ?? recurrence.nextDate
      const anchor =
        recurrence.scheduleAnchor === '1970-01-01'
          ? recurrence.nextDate
          : recurrence.scheduleAnchor
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const id = yield* crypto.randomUUIDv7.pipe(Effect.orDie)
          const group = yield* groupId(recurrence.groupId)
          yield* sql`
            INSERT INTO recurrences (id, name, group_id, participant_label, account_id, category_id,
              amount_cents, currency, direction, amount_mode, match_mode, destination_mode, frequency,
              starts_on, schedule_anchor, date_tolerance_days, amount_tolerance_bps, active, created_at)
            VALUES (${id}, ${recurrence.name.trim() || 'Recorrência'}, ${group},
              ${group ? recurrence.participantLabel : null}, ${accountId}, ${recurrence.categoryId},
              ${Math.abs(recurrence.amountCents)}, ${recurrence.currency},
              ${recurrence.direction === 'income' ? 'income' : 'expense'},
              ${recurrence.amountMode === 'variable' ? 'variable' : 'fixed'},
              ${recurrence.matchMode === 'aggregate' ? 'aggregate' : 'single'},
              ${recurrence.destinationMode === 'fixed' ? 'fixed' : 'automatic'},
              ${recurrence.frequency === 'yearly' ? 'yearly' : 'monthly'}, ${startsOn}, ${anchor},
              ${recurrence.dateToleranceDays}, ${recurrence.amountToleranceBps},
              ${recurrence.active ? 1 : 0}, ${yield* now})
          `
          yield* remember('recurrence', recurrence.id, id)
          knownRecurrences.set(recurrence.id, id)
        }),
      )
      result.recurrences.migrated++
    }

    const knownAliases = yield* mapped('recurrence_alias')
    for (const alias of source.aliases) {
      const recurrenceId = knownRecurrences.get(alias.recurrenceId)
      if (knownAliases.has(alias.id)) result.aliases.already++
      else if (recurrenceId === undefined || alias.pattern.trim().length < 2)
        result.aliases.skipped++
      else {
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO recurrence_aliases (recurrence_id, pattern, sample_description, origin)
              VALUES (${recurrenceId}, ${alias.pattern.trim()}, ${alias.sampleDescription}, 'v1_import')
              ON CONFLICT (recurrence_id, pattern) DO NOTHING
            `
            yield* remember('recurrence_alias', alias.id, recurrenceId)
          }),
        )
        result.aliases.migrated++
      }
    }

    const occurrenceById = new Map(
      source.occurrences.map((occurrence) => [occurrence.id, occurrence]),
    )
    const knownSkips = yield* mapped('occurrence_skip')
    for (const occurrence of source.occurrences) {
      if (occurrence.status !== 'skipped') continue
      const recurrenceId = knownRecurrences.get(occurrence.recurrenceId)
      if (knownSkips.has(occurrence.id)) result.skippedOccurrences.already++
      else if (recurrenceId === undefined) result.skippedOccurrences.skipped++
      else {
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO recurrence_occurrence_decisions (recurrence_id, expected_date, decision, decided_at)
              VALUES (${recurrenceId}, ${occurrence.expectedDate}, 'skipped', ${yield* now})
              ON CONFLICT (recurrence_id, expected_date) DO NOTHING
            `
            yield* remember('occurrence_skip', occurrence.id, recurrenceId)
          }),
        )
        result.skippedOccurrences.migrated++
      }
    }

    const knownIgnores = yield* mapped('detection_ignore')
    for (const ignore of source.ignores) {
      if (knownIgnores.has(ignore.id)) {
        result.ignores.already++
        continue
      }
      if (ignore.direction !== 'income' && ignore.direction !== 'expense') {
        result.ignores.skipped++
        continue
      }
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO recurrence_detection_ignores (signature, direction, decided_at)
            VALUES (${ignore.signature}, ${ignore.direction}, ${yield* now})
            ON CONFLICT (signature, direction) DO NOTHING
          `
          yield* remember('detection_ignore', ignore.id, ignore.signature)
        }),
      )
      result.ignores.migrated++
    }

    for (const link of source.links) {
      const occurrence = occurrenceById.get(link.occurrenceId)
      const recurrenceId = occurrence
        ? knownRecurrences.get(occurrence.recurrenceId)
        : undefined
      const movement = yield* findMovement(link.transactionId)
      if (
        !occurrence ||
        recurrenceId === undefined ||
        movement._tag === 'None'
      ) {
        result.links.skipped++
        if (occurrence && recurrenceId === undefined)
          unmapped.push({
            kind: 'recurrence_link',
            v1Id: link.id,
            label: occurrence.expectedDate,
            reason: 'its recurrence was not migrated',
          })
        continue
      }
      const inserted = yield* sql`
        INSERT INTO v1_import_recurrence_links (v1_match_id, recurrence_id, expected_date,
          v1_transaction_id, status)
        VALUES (${link.id}, ${recurrenceId}, ${occurrence.expectedDate}, ${link.transactionId}, 'pending')
        ON CONFLICT (v1_match_id) DO NOTHING
        RETURNING v1_match_id
      `
      if (inserted.length > 0) result.links.migrated++
      else result.links.already++
    }

    return {
      ...result,
      unmapped,
      pending: yield* applyPending(),
    } satisfies PlanningSummary
  })

  return { run, applyPending }
})

export class V1PlanningImport extends Context.Service<
  V1PlanningImport,
  Effect.Success<typeof make>
>()('@spendle/server/v1import/PlanningImport/V1PlanningImport') {
  static readonly layer = Layer.effect(V1PlanningImport, make)
}

/** Applies waiting V1 recurrence links as their movements resolve into entries. */
export const reactor = Reactor.layer({
  name: 'v1-import-planning',
  types: [entriesResolved],
  handle: () =>
    Effect.gen(function* () {
      yield* (yield* V1PlanningImport).applyPending()
    }),
})
