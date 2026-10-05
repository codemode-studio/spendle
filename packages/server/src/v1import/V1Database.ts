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
  notes: Schema.NullOr(Schema.String),
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

export const V1AssetClass = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  color: Schema.String,
  sortOrder: Schema.Int,
  active: Bit,
})
export type V1AssetClass = typeof V1AssetClass.Type

export const V1Position = Schema.Struct({
  id: Schema.String,
  accountId: Schema.String,
  assetClassId: Schema.String,
  /** Whether its goal is the emergency reserve. */
  reserve: Bit,
  name: Schema.String,
  symbol: Schema.NullOr(Schema.String),
  currency: Schema.String,
  initialAmountMinor: Schema.Int,
  manualCurrentAmountMinor: Schema.NullOr(Schema.Int),
  manualCurrentAt: Schema.NullOr(Schema.String),
  active: Bit,
})
export type V1Position = typeof V1Position.Type

export const V1PositionMovement = Schema.Struct({
  id: Schema.String,
  positionId: Schema.String,
  transactionId: Schema.String,
})
export type V1PositionMovement = typeof V1PositionMovement.Type

/** A balance the person informed by hand, still standing in V1. */
export const V1Checkpoint = Schema.Struct({
  id: Schema.String,
  accountId: Schema.NullOr(Schema.String),
  cardId: Schema.NullOr(Schema.String),
  asOf: Schema.String,
  balanceCents: Schema.Int,
})
export type V1Checkpoint = typeof V1Checkpoint.Type

/** Counts of V1 records V2 has no place for yet. */
export const V1Uncovered = Schema.Struct({
  splits: Schema.Int,
  recurrences: Schema.Int,
  cardInstruments: Schema.Int,
  budgets: Schema.Int,
  goals: Schema.Int,
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
  readonly assetClasses: ReadonlyArray<V1AssetClass>
  readonly positions: ReadonlyArray<V1Position>
  readonly positionMovements: ReadonlyArray<V1PositionMovement>
  readonly checkpoints: ReadonlyArray<V1Checkpoint>
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
         currency, base_amount_cents AS baseAmountCents, base_currency AS baseCurrency, status,
         notes
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
    assetClasses: yield* all(
      sql,
      V1AssetClass,
      `SELECT id, name, color, sort_order AS sortOrder, active
       FROM investment_asset_classes ORDER BY sort_order, id`,
    ),
    positions: yield* all(
      sql,
      V1Position,
      `SELECT p.id, p.account_id AS accountId, p.asset_class_id AS assetClassId,
         coalesce(g.type = 'emergency_reserve', 0) AS reserve, p.name, p.symbol, p.currency,
         p.initial_amount_minor AS initialAmountMinor,
         p.manual_current_amount_minor AS manualCurrentAmountMinor,
         p.manual_current_at AS manualCurrentAt, p.active
       FROM investment_positions p LEFT JOIN investment_goals g ON g.id = p.goal_id
       ORDER BY p.created_at, p.id`,
    ),
    positionMovements: yield* all(
      sql,
      V1PositionMovement,
      `SELECT id, position_id AS positionId, transaction_id AS transactionId
       FROM investment_position_movements ORDER BY created_at, id`,
    ),
    checkpoints: yield* all(
      sql,
      V1Checkpoint,
      `SELECT id, account_id AS accountId, credit_card_id AS cardId, as_of AS asOf,
         balance_cents AS balanceCents
       FROM balance_checkpoints
       WHERE kind = 'manual' AND review_state <> 'invalidated'
       ORDER BY as_of, created_at, id`,
    ),
    uncovered: {
      splits: yield* count('transaction_splits'),
      recurrences: yield* count('recurrences'),
      cardInstruments: yield* count('credit_card_instruments'),
      budgets: yield* count('monthly_budgets'),
      goals: yield* count('investment_goals'),
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
