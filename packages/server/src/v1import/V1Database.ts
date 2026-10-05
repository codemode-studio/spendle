import * as SqliteClient from '@effect/sql-sqlite-node/SqliteClient'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'

/**
 * The parts of a V1 database (`src/db/schema.ts`) the migration reads:
 * configuration, what the person taught, and the transactions and groups
 * their decisions are about. Imported facts are read only to recognise
 * those decisions; V2 observes the facts again from their sources.
 */

const Bit = Schema.BooleanFromBit

export const V1Owner = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  type: Schema.String,
  active: Bit,
})
export type V1Owner = typeof V1Owner.Type

export const V1Account = Schema.Struct({
  id: Schema.String,
  ownerId: Schema.String,
  institutionName: Schema.NullOr(Schema.String),
  name: Schema.String,
  kind: Schema.String,
  purpose: Schema.String,
  currency: Schema.String,
  active: Bit,
})
export type V1Account = typeof V1Account.Type

export const V1Card = Schema.Struct({
  id: Schema.String,
  ownerId: Schema.String,
  institutionName: Schema.NullOr(Schema.String),
  name: Schema.String,
  currency: Schema.String,
  lastFour: Schema.NullOr(Schema.String),
  limitCents: Schema.Int,
  closingDay: Schema.Int,
  dueDay: Schema.NullOr(Schema.Int),
  active: Bit,
})
export type V1Card = typeof V1Card.Type

export const V1Category = Schema.Struct({
  id: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  name: Schema.String,
  bucket: Schema.String,
  color: Schema.String,
  icon: Schema.NullOr(Schema.String),
  active: Bit,
})
export type V1Category = typeof V1Category.Type

export const V1Knowledge = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  signature: Schema.String,
  pattern: Schema.String,
  matchMode: Schema.String,
  direction: Schema.String,
  categoryId: Schema.NullOr(Schema.String),
  sampleDescription: Schema.String,
  confirmations: Schema.Int,
  corrections: Schema.Int,
  /** Unix seconds. */
  lastLearnedAt: Schema.Int,
})
export type V1Knowledge = typeof V1Knowledge.Type

export const V1Transaction = Schema.Struct({
  id: Schema.String,
  accountId: Schema.NullOr(Schema.String),
  cardId: Schema.NullOr(Schema.String),
  categoryId: Schema.NullOr(Schema.String),
  sourceKey: Schema.NullOr(Schema.String),
  postedAt: Schema.String,
  description: Schema.String,
  amountCents: Schema.Int,
  currency: Schema.String,
  baseAmountCents: Schema.NullOr(Schema.Int),
  baseCurrency: Schema.String,
  status: Schema.String,
})
export type V1Transaction = typeof V1Transaction.Type

/** A staged import line and the transaction it became or confirmed. */
export const V1Evidence = Schema.Struct({
  transactionId: Schema.String,
  matchKind: Schema.String,
  suggestionSource: Schema.String,
  suggestedCategoryId: Schema.NullOr(Schema.String),
})
export type V1Evidence = typeof V1Evidence.Type

export const V1Group = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  status: Schema.String,
  reason: Schema.NullOr(Schema.String),
})
export type V1Group = typeof V1Group.Type

export const V1Link = Schema.Struct({
  groupId: Schema.String,
  transactionId: Schema.String,
  previousCategoryId: Schema.NullOr(Schema.String),
})
export type V1Link = typeof V1Link.Type

export const V1StatementPayment = Schema.Struct({
  id: Schema.String,
  cardId: Schema.String,
  dueDate: Schema.String,
  transactionId: Schema.String,
})
export type V1StatementPayment = typeof V1StatementPayment.Type

export const V1Settings = Schema.Struct({
  monthlyIncomeTargetCents: Schema.Int,
  reserveMonths: Schema.Int,
  keepReserveContributions: Bit,
})

export const V1Strategy = Schema.Struct({
  id: Schema.String,
  template: Schema.String,
  name: Schema.String,
  essentialBps: Schema.Int,
  lifestyleBps: Schema.Int,
  investmentBps: Schema.Int,
  reserveBps: Schema.Int,
  isDefault: Bit,
})
export type V1Strategy = typeof V1Strategy.Type

/** A closed V1 month with the plan it was closed with. */
export const V1Budget = Schema.Struct({
  id: Schema.String,
  month: Schema.String,
  strategyTemplate: Schema.NullOr(Schema.String),
  strategyName: Schema.NullOr(Schema.String),
  baseIncomeCents: Schema.Int,
  eligibleIncomeCents: Schema.NullOr(Schema.Int),
  essentialBps: Schema.Int,
  lifestyleBps: Schema.Int,
  investmentBps: Schema.Int,
  reserveBps: Schema.Int,
  effectiveInvestmentBps: Schema.Int,
  effectiveReserveBps: Schema.Int,
  reserveRedirected: Bit,
})
export type V1Budget = typeof V1Budget.Type

export const V1Goal = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  type: Schema.String,
  targetCents: Schema.Int,
  currentCents: Schema.Int,
  targetDate: Schema.NullOr(Schema.String),
})
export type V1Goal = typeof V1Goal.Type

export const V1RecurrenceGroup = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
})

export const V1Recurrence = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  groupId: Schema.NullOr(Schema.String),
  participantLabel: Schema.NullOr(Schema.String),
  accountId: Schema.NullOr(Schema.String),
  cardId: Schema.NullOr(Schema.String),
  categoryId: Schema.NullOr(Schema.String),
  amountCents: Schema.Int,
  currency: Schema.String,
  direction: Schema.String,
  amountMode: Schema.String,
  matchMode: Schema.String,
  destinationMode: Schema.String,
  frequency: Schema.String,
  startsOn: Schema.String,
  scheduleAnchor: Schema.String,
  nextDate: Schema.String,
  dateToleranceDays: Schema.Int,
  amountToleranceBps: Schema.Int,
  active: Bit,
})
export type V1Recurrence = typeof V1Recurrence.Type

export const V1Occurrence = Schema.Struct({
  id: Schema.String,
  recurrenceId: Schema.String,
  expectedDate: Schema.String,
  status: Schema.String,
})
export type V1Occurrence = typeof V1Occurrence.Type

/** A payment the person linked to an occurrence (`confirmed`, never `auto_confirmed`). */
export const V1RecurrenceLink = Schema.Struct({
  id: Schema.String,
  occurrenceId: Schema.String,
  transactionId: Schema.String,
})
export type V1RecurrenceLink = typeof V1RecurrenceLink.Type

/** A merchant signature the person tied to a recurrence. */
export const V1RecurrenceAlias = Schema.Struct({
  id: Schema.String,
  recurrenceId: Schema.String,
  pattern: Schema.String,
  sampleDescription: Schema.String,
})
export type V1RecurrenceAlias = typeof V1RecurrenceAlias.Type

export const V1DetectionIgnore = Schema.Struct({
  id: Schema.String,
  signature: Schema.String,
  direction: Schema.String,
})

/** What the person planned in V1: income, strategy, goals, closed months and recurrences. */
export interface V1Planning {
  readonly settings: typeof V1Settings.Type | null
  readonly strategies: ReadonlyArray<V1Strategy>
  readonly budgets: ReadonlyArray<V1Budget>
  readonly goals: ReadonlyArray<V1Goal>
  readonly groups: ReadonlyArray<typeof V1RecurrenceGroup.Type>
  readonly recurrences: ReadonlyArray<V1Recurrence>
  readonly occurrences: ReadonlyArray<V1Occurrence>
  readonly links: ReadonlyArray<V1RecurrenceLink>
  readonly aliases: ReadonlyArray<V1RecurrenceAlias>
  readonly ignores: ReadonlyArray<typeof V1DetectionIgnore.Type>
}

/** Counts of V1 records V2 has no place for yet. */
export const V1Uncovered = Schema.Struct({
  splits: Schema.Int,
  cardInstruments: Schema.Int,
  goalContributions: Schema.Int,
  investmentPositions: Schema.Int,
  categorizationRules: Schema.Int,
})
export type V1Uncovered = typeof V1Uncovered.Type

export interface V1Snapshot {
  readonly owners: ReadonlyArray<V1Owner>
  readonly accounts: ReadonlyArray<V1Account>
  readonly cards: ReadonlyArray<V1Card>
  readonly categories: ReadonlyArray<V1Category>
  readonly knowledge: ReadonlyArray<V1Knowledge>
  readonly transactions: ReadonlyArray<V1Transaction>
  readonly evidence: ReadonlyArray<V1Evidence>
  readonly groups: ReadonlyArray<V1Group>
  readonly links: ReadonlyArray<V1Link>
  readonly statementPayments: ReadonlyArray<V1StatementPayment>
  readonly planning: V1Planning
  readonly uncovered: V1Uncovered
}

export class V1ReadError extends Schema.TaggedError<V1ReadError>()(
  'V1ReadError',
  {
    reason: Schema.Literals(['not_found', 'unreadable']),
    path: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason === 'not_found'
      ? `No V1 database at ${this.path}`
      : `Could not read the V1 database at ${this.path}; open it once in the latest V1 so its schema is current`
  }
}

const all = <A, I>(
  sql: SqlClient.SqlClient,
  Result: Schema.Codec<A, I>,
  query: string,
) =>
  SqlSchema.findAll({
    Request: Schema.Void,
    Result,
    execute: () => sql.unsafe(query),
  })(undefined)

const read = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const count = (table: string) =>
    Effect.map(
      all(
        sql,
        Schema.Struct({ n: Schema.Int }),
        `SELECT count(*) AS n FROM ${table}`,
      ),
      (rows) => rows[0]?.n ?? 0,
    )
  return {
    owners: yield* all(
      sql,
      V1Owner,
      `SELECT id, name, type, active FROM ownership_scopes ORDER BY created_at, id`,
    ),
    accounts: yield* all(
      sql,
      V1Account,
      `SELECT a.id, a.ownership_scope_id AS ownerId, i.name AS institutionName, a.name, a.kind,
         a.purpose, a.currency, a.active
       FROM accounts a LEFT JOIN institutions i ON i.id = a.institution_id
       ORDER BY a.created_at, a.id`,
    ),
    cards: yield* all(
      sql,
      V1Card,
      `SELECT c.id, c.ownership_scope_id AS ownerId, i.name AS institutionName, c.name, c.currency,
         c.last_four AS lastFour, c.limit_cents AS limitCents, c.closing_day AS closingDay,
         c.due_day AS dueDay, c.active
       FROM credit_cards c LEFT JOIN institutions i ON i.id = c.institution_id
       ORDER BY c.created_at, c.id`,
    ),
    categories: yield* all(
      sql,
      V1Category,
      `SELECT id, parent_id AS parentId, name, bucket, color, icon, active
       FROM categories ORDER BY created_at, id`,
    ),
    knowledge: yield* all(
      sql,
      V1Knowledge,
      `SELECT id, kind, signature, pattern, match_mode AS matchMode, direction,
         category_id AS categoryId, sample_description AS sampleDescription, confirmations,
         corrections, last_learned_at AS lastLearnedAt
       FROM knowledge_base ORDER BY last_learned_at, id`,
    ),
    transactions: yield* all(
      sql,
      V1Transaction,
      `SELECT id, account_id AS accountId, credit_card_id AS cardId, category_id AS categoryId,
         source_key AS sourceKey, posted_at AS postedAt, description, amount_cents AS amountCents,
         currency, base_amount_cents AS baseAmountCents, base_currency AS baseCurrency, status
       FROM transactions ORDER BY posted_at, id`,
    ),
    evidence: yield* all(
      sql,
      V1Evidence,
      `SELECT e.transaction_id AS transactionId, e.match_kind AS matchKind,
         s.suggestion_source AS suggestionSource, s.suggested_category_id AS suggestedCategoryId
       FROM transaction_evidence e JOIN staged_transactions s ON s.id = e.staged_transaction_id
       ORDER BY e.created_at, e.id`,
    ),
    groups: yield* all(
      sql,
      V1Group,
      `SELECT id, type, status, reason FROM reconciliation_groups ORDER BY created_at, id`,
    ),
    links: yield* all(
      sql,
      V1Link,
      `SELECT group_id AS groupId, transaction_id AS transactionId,
         previous_category_id AS previousCategoryId
       FROM reconciliation_links ORDER BY id`,
    ),
    statementPayments: yield* all(
      sql,
      V1StatementPayment,
      `SELECT id, credit_card_id AS cardId, due_date AS dueDate, transaction_id AS transactionId
       FROM card_statement_payments ORDER BY created_at, id`,
    ),
    planning: {
      settings:
        (yield* all(
          sql,
          V1Settings,
          `SELECT monthly_income_target_cents AS monthlyIncomeTargetCents,
             reserve_months AS reserveMonths,
             keep_reserve_contributions AS keepReserveContributions
           FROM app_settings ORDER BY id LIMIT 1`,
        ))[0] ?? null,
      strategies: yield* all(
        sql,
        V1Strategy,
        `SELECT id, template, name, essential_bps AS essentialBps, lifestyle_bps AS lifestyleBps,
           investment_bps AS investmentBps, reserve_bps AS reserveBps, is_default AS isDefault
         FROM budget_strategies ORDER BY created_at, id`,
      ),
      budgets: yield* all(
        sql,
        V1Budget,
        `SELECT b.id, b.month, s.template AS strategyTemplate, s.name AS strategyName,
           b.base_income_cents AS baseIncomeCents, b.eligible_income_cents AS eligibleIncomeCents,
           b.essential_bps AS essentialBps, b.lifestyle_bps AS lifestyleBps,
           b.investment_bps AS investmentBps, b.reserve_bps AS reserveBps,
           b.effective_investment_bps AS effectiveInvestmentBps,
           b.effective_reserve_bps AS effectiveReserveBps,
           b.reserve_redirected AS reserveRedirected
         FROM monthly_budgets b LEFT JOIN budget_strategies s ON s.id = b.strategy_id
         WHERE b.closed = 1 ORDER BY b.month`,
      ),
      goals: yield* all(
        sql,
        V1Goal,
        `SELECT id, name, type, target_cents AS targetCents, current_cents AS currentCents,
           target_date AS targetDate
         FROM investment_goals WHERE active = 1 ORDER BY priority, created_at, id`,
      ),
      groups: yield* all(
        sql,
        V1RecurrenceGroup,
        `SELECT id, name FROM recurrence_groups ORDER BY created_at, id`,
      ),
      recurrences: yield* all(
        sql,
        V1Recurrence,
        `SELECT id, name, group_id AS groupId, participant_label AS participantLabel,
           account_id AS accountId, credit_card_id AS cardId, category_id AS categoryId,
           amount_cents AS amountCents, currency, direction, amount_mode AS amountMode,
           match_mode AS matchMode, destination_mode AS destinationMode, frequency,
           starts_on AS startsOn, schedule_anchor AS scheduleAnchor, next_date AS nextDate,
           date_tolerance_days AS dateToleranceDays, amount_tolerance_bps AS amountToleranceBps,
           active
         FROM recurrences ORDER BY created_at, id`,
      ),
      occurrences: yield* all(
        sql,
        V1Occurrence,
        `SELECT id, recurrence_id AS recurrenceId, expected_date AS expectedDate, status
         FROM recurrence_occurrences ORDER BY expected_date, id`,
      ),
      links: yield* all(
        sql,
        V1RecurrenceLink,
        `SELECT id, occurrence_id AS occurrenceId, transaction_id AS transactionId
         FROM recurrence_matches WHERE status = 'confirmed' ORDER BY created_at, id`,
      ),
      aliases: yield* all(
        sql,
        V1RecurrenceAlias,
        `SELECT id, recurrence_id AS recurrenceId, signature AS pattern,
           sample_description AS sampleDescription
         FROM knowledge_base WHERE kind = 'recurrence' AND recurrence_id IS NOT NULL
         ORDER BY last_learned_at, id`,
      ),
      ignores: yield* all(
        sql,
        V1DetectionIgnore,
        `SELECT id, signature, direction FROM recurrence_detection_ignores ORDER BY created_at, id`,
      ),
    },
    uncovered: {
      splits: yield* count('transaction_splits'),
      cardInstruments: yield* count('credit_card_instruments'),
      goalContributions: yield* count('goal_contributions'),
      investmentPositions: yield* count('investment_positions'),
      categorizationRules: yield* count('categorization_rules'),
    },
  } satisfies V1Snapshot
})

/**
 * Reads the V1 database at `path` without writing to it: the connection is
 * read-only and leaves the journal mode as V1 set it.
 */
export const readV1 = Effect.fn('V1Database.readV1')(function* (path: string) {
  const fs = yield* FileSystem.FileSystem
  const exists = yield* fs
    .exists(path)
    .pipe(
      Effect.mapError(
        (cause) => new V1ReadError({ reason: 'unreadable', path, cause }),
      ),
    )
  if (!exists) return yield* new V1ReadError({ reason: 'not_found', path })
  return yield* read.pipe(
    Effect.provide(
      SqliteClient.layer({
        filename: path,
        readonly: true,
        disableWAL: true,
      }).pipe(Layer.orDie),
    ),
    Effect.mapError(
      (cause) => new V1ReadError({ reason: 'unreadable', path, cause }),
    ),
  )
})
