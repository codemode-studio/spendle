import * as Context from 'effect/Context'
import * as Crypto from 'effect/Crypto'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'

import { Cents, Currency, LocalDate } from '../domain/Money.ts'
import { EventLog } from '../events/EventLog.ts'
import { Accounts, AccountNotFound, LedgerStoreError } from './Accounts.ts'

export const SourceKind = Schema.Literals(['open_finance', 'file', 'manual'])
export const TransactionStatus = Schema.Literals([
  'pending',
  'posted',
  'removed',
])
export const BalanceKind = Schema.Literals(['booked', 'available', 'statement'])

export class Source extends Schema.Class<Source>('Source')({
  id: Schema.String,
  kind: SourceKind,
  externalRef: Schema.String,
  label: Schema.String,
}) {}

/** One transaction as a source reports it. Amounts are signed: outflows are negative. */
export const ReportedTransaction = Schema.Struct({
  externalId: Schema.NonEmptyString,
  bookedOn: LocalDate,
  amountCents: Cents,
  currency: Currency,
  description: Schema.String,
  status: TransactionStatus,
  raw: Schema.Json,
})
export type ReportedTransaction = typeof ReportedTransaction.Type

export const ReportedBalance = Schema.Struct({
  kind: BalanceKind,
  asOf: LocalDate,
  balanceCents: Cents,
  currency: Currency,
})
export type ReportedBalance = typeof ReportedBalance.Type

export class TransactionObservation extends Schema.Class<TransactionObservation>(
  'TransactionObservation',
)({
  id: Schema.String,
  sourceId: Schema.String,
  accountId: Schema.String,
  externalId: Schema.String,
  version: Schema.Int,
  bookedOn: LocalDate,
  amountCents: Cents,
  currency: Currency,
  description: Schema.String,
  status: TransactionStatus,
}) {}

export interface RecordedTransactions {
  /** New observations and new versions of changed ones, in input order. */
  readonly recorded: ReadonlyArray<TransactionObservation>
  /** Reports identical to the latest version already stored. */
  readonly unchanged: number
}

export class CurrencyMismatch extends Schema.TaggedError<CurrencyMismatch>()(
  'CurrencyMismatch',
  {
    accountId: Schema.String,
    accountCurrency: Schema.String,
    reportedCurrency: Schema.String,
  },
) {
  override get message(): string {
    return `Account ${this.accountId} is in ${this.accountCurrency}, not ${this.reportedCurrency}`
  }
}

export class SourceNotFound extends Schema.TaggedError<SourceNotFound>()(
  'SourceNotFound',
  {
    sourceId: Schema.String,
  },
) {
  override get message(): string {
    return `Source ${this.sourceId} not found`
  }
}

type RecordError =
  AccountNotFound | SourceNotFound | CurrencyMismatch | LedgerStoreError

export interface ObservationsShape {
  /** Returns the source for `(kind, externalRef)`, creating it on first use. */
  readonly registerSource: (input: {
    readonly kind: Source['kind']
    readonly externalRef: string
    readonly label: string
  }) => Effect.Effect<Source, LedgerStoreError>
  /**
   * Records what a source reported for an account. Repeating a report is a
   * no-op; a different report for the same external id becomes the next
   * version. The batch is atomic and emits one `TransactionObserved` per
   * recorded observation.
   */
  readonly recordTransactions: (input: {
    readonly sourceId: string
    readonly accountId: string
    readonly transactions: ReadonlyArray<ReportedTransaction>
  }) => Effect.Effect<RecordedTransactions, RecordError>
  /** Records a reported balance; returns false when it was already known. */
  readonly recordBalance: (input: {
    readonly sourceId: string
    readonly accountId: string
    readonly balance: ReportedBalance
  }) => Effect.Effect<boolean, RecordError>
  /** The latest version of each observation of the account, removed ones excluded. */
  readonly current: (
    accountId: string,
  ) => Effect.Effect<ReadonlyArray<TransactionObservation>, LedgerStoreError>
}

const ObservationRow = Schema.Struct({
  id: Schema.String,
  sourceId: Schema.String,
  accountId: Schema.String,
  externalId: Schema.String,
  version: Schema.Int,
  bookedOn: LocalDate,
  amountCents: Cents,
  currency: Currency,
  description: Schema.String,
  status: TransactionStatus,
}).pipe(Schema.decodeTo(TransactionObservation))

const sameReport = (
  stored: TransactionObservation,
  reported: ReportedTransaction,
) =>
  stored.bookedOn === reported.bookedOn &&
  stored.amountCents === reported.amountCents &&
  stored.currency === reported.currency &&
  stored.description === reported.description &&
  stored.status === reported.status

const encodeRaw = Schema.encodeEffect(Schema.fromJsonString(Schema.Json))

export class Observations extends Context.Service<
  Observations,
  ObservationsShape
>()('@spendle/server/ledger/Observations') {
  static readonly layer = Layer.effect(
    Observations,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const crypto = yield* Crypto.Crypto
      const log = yield* EventLog
      const accounts = yield* Accounts

      const storeError = (operation: string) => (cause: unknown) =>
        new LedgerStoreError({ operation, cause })
      const now = Effect.map(DateTime.now, DateTime.formatIso)
      const newId = crypto.randomUUIDv7.pipe(Effect.orDie)
      const observationColumns = sql`
        id, source_id AS sourceId, account_id AS accountId, external_id AS externalId, version,
        booked_on AS bookedOn, amount_cents AS amountCents, currency, description, status
      `

      const findSource = SqlSchema.findOneOption({
        Request: Schema.Struct({
          kind: SourceKind,
          externalRef: Schema.String,
        }),
        Result: Source,
        execute: ({ kind, externalRef }) => sql`
          SELECT id, kind, external_ref AS externalRef, label FROM sources
          WHERE kind = ${kind} AND external_ref = ${externalRef}
        `,
      })
      const sourceExists = SqlSchema.findOneOption({
        Request: Schema.String,
        Result: Schema.Struct({ id: Schema.String }),
        execute: (id) => sql`SELECT id FROM sources WHERE id = ${id}`,
      })
      const findLatest = SqlSchema.findOneOption({
        Request: Schema.Struct({
          sourceId: Schema.String,
          accountId: Schema.String,
          externalId: Schema.String,
        }),
        Result: ObservationRow,
        execute: (key) => sql`
          SELECT ${observationColumns} FROM transaction_observations
          WHERE source_id = ${key.sourceId} AND account_id = ${key.accountId}
            AND external_id = ${key.externalId}
          ORDER BY version DESC LIMIT 1
        `,
      })
      const findCurrent = SqlSchema.findAll({
        Request: Schema.String,
        Result: ObservationRow,
        execute: (accountId) => sql`
          SELECT ${observationColumns} FROM transaction_observations o
          WHERE account_id = ${accountId} AND status <> 'removed'
            AND version = (
              SELECT max(version) FROM transaction_observations l
              WHERE l.source_id = o.source_id AND l.account_id = o.account_id
                AND l.external_id = o.external_id
            )
          ORDER BY booked_on, id
        `,
      })

      // Checks the source and account exist and the currency matches, before writing.
      const guard = Effect.fnUntraced(function* (
        sourceId: string,
        accountId: string,
        currencies: ReadonlyArray<string>,
      ) {
        if (
          Option.isNone(
            yield* sourceExists(sourceId).pipe(
              Effect.mapError(storeError('guard')),
            ),
          )
        ) {
          return yield* new SourceNotFound({ sourceId })
        }
        const account = yield* accounts.get(accountId)
        const mismatch = currencies.find(
          (currency) => currency !== account.currency,
        )
        if (mismatch !== undefined) {
          return yield* new CurrencyMismatch({
            accountId,
            accountCurrency: account.currency,
            reportedCurrency: mismatch,
          })
        }
      })

      const registerSource = Effect.fn('Observations.registerSource')(
        function* (input: {
          readonly kind: Source['kind']
          readonly externalRef: string
          readonly label: string
        }) {
          const existing = yield* findSource(input).pipe(
            Effect.mapError(storeError('registerSource')),
          )
          if (Option.isSome(existing)) return existing.value
          const source = new Source({ id: yield* newId, ...input })
          yield* sql`
          INSERT INTO sources (id, kind, external_ref, label, created_at)
          VALUES (${source.id}, ${source.kind}, ${source.externalRef}, ${source.label}, ${yield* now})
        `.pipe(Effect.mapError(storeError('registerSource')))
          return source
        },
      )

      const recordTransactions = Effect.fn('Observations.recordTransactions')(
        function* (input: {
          readonly sourceId: string
          readonly accountId: string
          readonly transactions: ReadonlyArray<ReportedTransaction>
        }) {
          const { sourceId, accountId } = input
          yield* guard(
            sourceId,
            accountId,
            input.transactions.map((transaction) => transaction.currency),
          )
          const observedAt = yield* now
          return yield* sql
            .withTransaction(
              Effect.gen(function* () {
                const recorded: Array<TransactionObservation> = []
                let unchanged = 0
                for (const reported of input.transactions) {
                  const latest = yield* findLatest({
                    sourceId,
                    accountId,
                    externalId: reported.externalId,
                  })
                  if (
                    Option.isSome(latest) &&
                    sameReport(latest.value, reported)
                  ) {
                    unchanged++
                    continue
                  }
                  const observation = new TransactionObservation({
                    id: yield* newId,
                    sourceId,
                    accountId,
                    externalId: reported.externalId,
                    version: Option.isSome(latest)
                      ? latest.value.version + 1
                      : 1,
                    bookedOn: reported.bookedOn,
                    amountCents: reported.amountCents,
                    currency: reported.currency,
                    description: reported.description,
                    status: reported.status,
                  })
                  yield* sql`
                  INSERT INTO transaction_observations (id, source_id, account_id, external_id, version,
                    booked_on, amount_cents, currency, description, status, raw, observed_at)
                  VALUES (${observation.id}, ${sourceId}, ${accountId}, ${observation.externalId},
                    ${observation.version}, ${observation.bookedOn}, ${observation.amountCents},
                    ${observation.currency}, ${observation.description}, ${observation.status},
                    ${yield* encodeRaw(reported.raw)}, ${observedAt})
                `
                  recorded.push(observation)
                }
                yield* log.append(
                  recorded.map((observation) => ({
                    type: 'TransactionObserved',
                    streamId: accountId,
                    payload: {
                      observationId: observation.id,
                      sourceId,
                      accountId,
                      externalId: observation.externalId,
                      version: observation.version,
                    },
                  })),
                )
                return { recorded, unchanged }
              }),
            )
            .pipe(Effect.mapError(storeError('recordTransactions')))
        },
      )

      const recordBalance = Effect.fn('Observations.recordBalance')(
        function* (input: {
          readonly sourceId: string
          readonly accountId: string
          readonly balance: ReportedBalance
        }) {
          const { sourceId, accountId, balance } = input
          yield* guard(sourceId, accountId, [balance.currency])
          const id = yield* newId
          const observedAt = yield* now
          return yield* sql
            .withTransaction(
              Effect.gen(function* () {
                const inserted = yield* sql<{ id: string }>`
                INSERT INTO balance_observations (id, source_id, account_id, kind, as_of,
                  balance_cents, currency, observed_at)
                VALUES (${id}, ${sourceId}, ${accountId}, ${balance.kind}, ${balance.asOf},
                  ${balance.balanceCents}, ${balance.currency}, ${observedAt})
                ON CONFLICT DO NOTHING
                RETURNING id
              `
                if (inserted.length === 0) return false
                yield* log.append([
                  {
                    type: 'BalanceObserved',
                    streamId: accountId,
                    payload: { balanceObservationId: id, sourceId, accountId },
                  },
                ])
                return true
              }),
            )
            .pipe(Effect.mapError(storeError('recordBalance')))
        },
      )

      const current = Effect.fn('Observations.current')((accountId: string) =>
        findCurrent(accountId).pipe(Effect.mapError(storeError('current'))),
      )

      return Observations.of({
        registerSource,
        recordTransactions,
        recordBalance,
        current,
      })
    }),
  )
}
