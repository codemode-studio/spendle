import * as Context from 'effect/Context'
import * as Crypto from 'effect/Crypto'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'

import { Categories } from '../categories/Categories.ts'
import { Categorizer, CategorizerError } from '../categories/Categorizer.ts'
import { Cents, LocalDate } from '../domain/Money.ts'
import { Accounts } from './Accounts.ts'
import { Entries } from './Entries.ts'
import { Notes } from './Notes.ts'
import { Observations } from './Observations.ts'

/**
 * What the person types in is a fact like any other, from one `manual`
 * source: each transaction is an observation with its own id, an edit is
 * its next version and a deletion a `removed` version. It resolves into
 * entries, reconciles and categorizes like a bank's report, and merges with
 * the bank's line once the bank reports the same movement. A balance the
 * person informs is a `booked` balance from the same source, so the balance
 * proof checks it like a statement's.
 */
export const manualSourceRef = 'person'

/** The fields of a typed-in transaction. Amounts are signed: outflows are negative. */
export const ManualTransaction = Schema.Struct({
  bookedOn: LocalDate,
  amountCents: Cents.check(
    Schema.makeFilter((cents: number) => cents !== 0, {
      description: 'a non-zero amount',
    }),
  ),
  /** Trimmed before it is checked. */
  description: Schema.String.check(
    Schema.isMinLength(2),
    Schema.isMaxLength(200),
  ),
})
export type ManualTransaction = typeof ManualTransaction.Type

export class ManualEntryError extends Schema.TaggedError<ManualEntryError>()(
  'ManualEntryError',
  {
    reason: Schema.Literals([
      'invalid_input',
      'manual_transaction_not_found',
      'checkpoint_not_found',
      /** The balance came from a bank or a file; only the person's own can be withdrawn. */
      'not_a_manual_checkpoint',
      /** Card balances follow statement cycles. */
      'checkpoint_on_card',
      'account_archived',
    ]),
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return [this.reason, this.detail].filter(Boolean).join(': ')
  }
}

const decodeManual = Schema.decodeUnknownEffect(ManualTransaction)
const decodeTransaction = (input: ManualTransaction) =>
  decodeManual({ ...input, description: input.description.trim() })

const LatestRow = Schema.Struct({
  accountId: Schema.String,
  bookedOn: Schema.String,
  amountCents: Schema.Int,
  currency: Schema.String,
  description: Schema.String,
  status: Schema.Literals(['pending', 'posted', 'removed']),
})

// Who reported it, part of the fact. No timestamp: repeating an edit with
// the same fields is the same report, not a new version.
const provenance = { enteredBy: 'person' } as const

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const crypto = yield* Crypto.Crypto
  const observations = yield* Observations
  const accounts = yield* Accounts
  const entries = yield* Entries
  const categories = yield* Categories
  const categorizer = yield* Categorizer
  const notes = yield* Notes

  const source = observations
    .registerSource({
      kind: 'manual',
      externalRef: manualSourceRef,
      label: 'Informado pela pessoa',
    })
    .pipe(Effect.withSpan('ManualEntries.source'))

  const findLatest = SqlSchema.findOneOption({
    Request: Schema.Struct({
      sourceId: Schema.String,
      externalId: Schema.String,
    }),
    Result: LatestRow,
    execute: ({ sourceId, externalId }) => sql`
      SELECT account_id AS accountId, booked_on AS bookedOn, amount_cents AS amountCents,
        currency, description, status
      FROM transaction_observations
      WHERE source_id = ${sourceId} AND external_id = ${externalId}
      ORDER BY version DESC LIMIT 1
    `,
  })
  const findEntry = SqlSchema.findOneOption({
    Request: Schema.Struct({
      sourceId: Schema.String,
      accountId: Schema.String,
      externalId: Schema.String,
    }),
    Result: Schema.Struct({ entryId: Schema.String }),
    execute: (key) => sql`
      SELECT entry_id AS entryId FROM entry_evidence
      WHERE source_id = ${key.sourceId} AND account_id = ${key.accountId}
        AND external_id = ${key.externalId}
    `,
  })
  const findBalance = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({
      accountId: Schema.String,
      sourceKind: Schema.String,
    }),
    execute: (id) => sql`
      SELECT b.account_id AS accountId, s.kind AS sourceKind
      FROM balance_observations b JOIN sources s ON s.id = b.source_id
      WHERE b.id = ${id}
    `,
  })
  const findLatestManualBalance = SqlSchema.findOneOption({
    Request: Schema.Struct({
      sourceId: Schema.String,
      accountId: Schema.String,
      asOf: Schema.String,
    }),
    Result: Schema.Struct({ id: Schema.String, withdrawn: Schema.Int }),
    execute: (key) => sql`
      SELECT b.id, COALESCE((
        SELECT w.withdrawn FROM manual_checkpoint_withdrawals w
        WHERE w.balance_observation_id = b.id ORDER BY w.rowid DESC LIMIT 1
      ), 0) AS withdrawn
      FROM balance_observations b
      WHERE b.source_id = ${key.sourceId} AND b.account_id = ${key.accountId}
        AND b.kind = 'booked' AND b.as_of = ${key.asOf}
      ORDER BY b.rowid DESC LIMIT 1
    `,
  })

  const invalid = (cause: Schema.SchemaError) =>
    new ManualEntryError({ reason: 'invalid_input', detail: cause.message })

  const openAccount = Effect.fnUntraced(function* (accountId: string) {
    const account = yield* accounts.get(accountId)
    if (account.archived)
      return yield* new ManualEntryError({
        reason: 'account_archived',
        detail: accountId,
      })
    return account
  })

  // Resolves the account now, so the answer carries the entry the
  // transaction became; the entry-resolution reactor finds nothing left.
  const resolveEntry = Effect.fnUntraced(function* (
    sourceId: string,
    accountId: string,
    externalId: string,
  ) {
    yield* entries.resolveAccount(accountId)
    const found = yield* findEntry({ sourceId, accountId, externalId })
    return Option.getOrNull(Option.map(found, (row) => row.entryId))
  })

  const latestOf = Effect.fnUntraced(function* (externalId: string) {
    const { id: sourceId } = yield* source
    const latest = yield* findLatest({ sourceId, externalId })
    if (Option.isNone(latest) || latest.value.status === 'removed')
      return yield* new ManualEntryError({
        reason: 'manual_transaction_not_found',
        detail: externalId,
      })
    return { sourceId, latest: latest.value }
  })

  /**
   * Records a transaction the person typed in. A category given here is
   * the person's decision for its entry (it teaches nothing, as a typed
   * description is no merchant's); a note becomes the entry's note.
   */
  const createTransaction = Effect.fn('ManualEntries.createTransaction')(
    function* (input: {
      readonly accountId: string
      readonly transaction: ManualTransaction
      readonly categoryId?: string | undefined
      readonly note?: string | undefined
      /** Fixed id, as `migrate-v1` uses to stay idempotent; a new UUID otherwise. */
      readonly externalId?: string | undefined
    }) {
      const transaction = yield* decodeTransaction(input.transaction).pipe(
        Effect.mapError(invalid),
      )
      const account = yield* openAccount(input.accountId)
      const categoryId =
        input.categoryId === undefined || input.categoryId === 'uncategorized'
          ? undefined
          : input.categoryId
      if (categoryId !== undefined) {
        const category = yield* categories.get(categoryId).pipe(
          Effect.catchTag('CategoriesError', () =>
            Effect.fail(
              new CategorizerError({
                reason: 'category_not_found',
                categoryId,
              }),
            ),
          ),
        )
        if (category.system || !category.active)
          return yield* new CategorizerError({
            reason: 'category_not_assignable',
            categoryId,
          })
      }
      const { id: sourceId } = yield* source
      const externalId =
        input.externalId ?? (yield* crypto.randomUUIDv7.pipe(Effect.orDie))
      yield* observations.recordTransactions({
        sourceId,
        accountId: account.id,
        transactions: [
          {
            externalId,
            ...transaction,
            currency: account.currency,
            status: 'posted',
            raw: provenance,
          },
        ],
      })
      const entryId = yield* resolveEntry(sourceId, account.id, externalId)
      if (entryId !== null && categoryId !== undefined)
        yield* categorizer.decide(entryId, categoryId, {
          learn: false,
          origin: 'transaction_list',
        })
      if (entryId !== null && input.note !== undefined && input.note.trim())
        yield* notes.set(entryId, input.note)
      return { externalId, entryId }
    },
  )

  /** A correction of a typed-in transaction: its next version. The account stays. */
  const reviseTransaction = Effect.fn('ManualEntries.reviseTransaction')(
    function* (externalId: string, input: ManualTransaction) {
      const transaction = yield* decodeTransaction(input).pipe(
        Effect.mapError(invalid),
      )
      const { sourceId, latest } = yield* latestOf(externalId)
      yield* observations.recordTransactions({
        sourceId,
        accountId: latest.accountId,
        transactions: [
          {
            externalId,
            ...transaction,
            currency: latest.currency,
            status: 'posted',
            raw: provenance,
          },
        ],
      })
      const entryId = yield* resolveEntry(
        sourceId,
        latest.accountId,
        externalId,
      )
      return { externalId, entryId }
    },
  )

  /** Deletes a typed-in transaction: a `removed` version, so its history stays. */
  const removeTransaction = Effect.fn('ManualEntries.removeTransaction')(
    function* (externalId: string) {
      const { sourceId, latest } = yield* latestOf(externalId)
      yield* observations.recordTransactions({
        sourceId,
        accountId: latest.accountId,
        transactions: [
          {
            externalId,
            bookedOn: latest.bookedOn,
            amountCents: latest.amountCents,
            currency: latest.currency,
            description: latest.description,
            status: 'removed',
            raw: provenance,
          },
        ],
      })
      yield* entries.resolveAccount(latest.accountId)
    },
  )

  const recordWithdrawal = (id: string, withdrawn: boolean) =>
    Effect.gen(function* () {
      yield* sql`
        INSERT INTO manual_checkpoint_withdrawals (balance_observation_id, withdrawn, recorded_at)
        VALUES (${id}, ${withdrawn ? 1 : 0}, ${DateTime.formatIso(yield* DateTime.now)})
      `
    })

  /**
   * The balance the person says the account had at the end of `asOf`. It
   * is a checkpoint of the balance proof like a statement's; informing the
   * same value again after withdrawing it puts it back.
   */
  const recordCheckpoint = Effect.fn('ManualEntries.recordCheckpoint')(
    function* (input: {
      readonly accountId: string
      readonly asOf: string
      readonly balanceCents: number
    }) {
      const account = yield* openAccount(input.accountId)
      if (account.kind === 'credit_card')
        return yield* new ManualEntryError({
          reason: 'checkpoint_on_card',
          detail: account.id,
        })
      const { id: sourceId } = yield* source
      yield* observations.recordBalance({
        sourceId,
        accountId: account.id,
        balance: {
          kind: 'booked',
          asOf: input.asOf,
          balanceCents: input.balanceCents,
          currency: account.currency,
        },
      })
      const latest = yield* findLatestManualBalance({
        sourceId,
        accountId: account.id,
        asOf: input.asOf,
      })
      if (Option.isNone(latest))
        return yield* new ManualEntryError({
          reason: 'checkpoint_not_found',
          detail: account.id,
        })
      if (latest.value.withdrawn === 1)
        yield* recordWithdrawal(latest.value.id, false)
      return { id: latest.value.id }
    },
  )

  /** Withdraws a balance the person informed; the proof stops using it. */
  const withdrawCheckpoint = Effect.fn('ManualEntries.withdrawCheckpoint')(
    function* (id: string) {
      const found = yield* findBalance(id)
      if (Option.isNone(found))
        return yield* new ManualEntryError({
          reason: 'checkpoint_not_found',
          detail: id,
        })
      if (found.value.sourceKind !== 'manual')
        return yield* new ManualEntryError({
          reason: 'not_a_manual_checkpoint',
          detail: id,
        })
      yield* recordWithdrawal(id, true)
      return { accountId: found.value.accountId }
    },
  )

  return {
    createTransaction,
    reviseTransaction,
    removeTransaction,
    recordCheckpoint,
    withdrawCheckpoint,
  }
})

export class ManualEntries extends Context.Service<
  ManualEntries,
  Effect.Success<typeof make>
>()('@spendle/server/ledger/Manual/ManualEntries') {
  static readonly layer = Layer.effect(ManualEntries, make)
}
