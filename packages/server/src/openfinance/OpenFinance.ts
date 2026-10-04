import * as Context from 'effect/Context'
import * as Crypto from 'effect/Crypto'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as Semaphore from 'effect/Semaphore'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'

import { addDays, max } from '../domain/LocalDate.ts'
import { EventLog } from '../events/EventLog.ts'
import {
  Accounts,
  AccountKind,
  AccountPurpose,
  CardTerms,
} from '../ledger/Accounts.ts'
import { Observations } from '../ledger/Observations.ts'
import type { ReportedTransaction } from '../ledger/Observations.ts'
import { continuationStart, historyStart } from './HistoryWindow.ts'
import type { HistoryMonths } from './HistoryWindow.ts'
import {
  bookedOn,
  lastFour,
  providerAccountName,
  runningBalanceCents,
  toMinorUnits,
  toReportedTransaction,
} from './Normalize.ts'
import { endOfDayBalances } from './EndOfDay.ts'
import type { RunningLine } from './EndOfDay.ts'
import type { PluggyAccount, PluggyItem } from './PluggyApi.ts'
import { PluggyClient } from './PluggyClient.ts'

export const ConnectionStatus = Schema.Literals([
  'pending',
  'active',
  'attention',
  'disconnected',
])

export class Connection extends Schema.Class<Connection>('Connection')({
  id: Schema.String,
  ownerId: Schema.String,
  itemId: Schema.NullOr(Schema.String),
  sourceId: Schema.NullOr(Schema.String),
  connectorName: Schema.NullOr(Schema.String),
  status: ConnectionStatus,
  providerStatus: Schema.NullOr(Schema.String),
  errorCode: Schema.NullOr(Schema.String),
  lastSyncedAt: Schema.NullOr(Schema.String),
}) {}

export class ProviderAccount extends Schema.Class<ProviderAccount>(
  'ProviderAccount',
)({
  providerAccountId: Schema.String,
  connectionId: Schema.String,
  type: Schema.Literals(['BANK', 'CREDIT']),
  subtype: Schema.NullOr(Schema.String),
  name: Schema.String,
  lastFour: Schema.NullOr(Schema.String),
  currency: Schema.String,
  accountId: Schema.NullOr(Schema.String),
  historyFrom: Schema.NullOr(Schema.String),
}) {}

/** Link to an existing ledger account, or open a new one from the provider account. */
export const LinkTarget = Schema.Union([
  Schema.Struct({ accountId: Schema.String }),
  Schema.Struct({
    name: Schema.optional(Schema.NonEmptyString),
    kind: AccountKind,
    purpose: AccountPurpose,
    card: Schema.optional(CardTerms),
  }),
])
export type LinkTarget = typeof LinkTarget.Type

export interface SyncResult {
  readonly recorded: number
  readonly unchanged: number
  /** Pending transactions Pluggy no longer reports, recorded as removed. */
  readonly removed: number
  /** Foreign-currency transactions without an amount in the account currency. */
  readonly skipped: number
  /**
   * False when Pluggy had not finished refreshing this item's transactions:
   * nothing was read, and the item's next update triggers another sync.
   */
  readonly providerReady: boolean
}

export class OpenFinanceError extends Schema.TaggedError<OpenFinanceError>()(
  'OpenFinanceError',
  {
    reason: Schema.Literals([
      'connection_not_found',
      'provider_account_not_found',
      'item_belongs_elsewhere',
      'connection_disconnected',
      'already_linked',
      'not_linked',
      'incompatible_account',
      'item_already_registered',
    ]),
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return this.detail ? `${this.reason}: ${this.detail}` : this.reason
  }
}

export const syncRequested = 'OpenFinanceSyncRequested'
export const accountSynced = 'OpenFinanceAccountSynced'

/** Payload of `OpenFinanceSyncRequested`. Without an account, the whole connection syncs. */
export const SyncRequest = Schema.Struct({
  connectionId: Schema.String,
  providerAccountId: Schema.optional(Schema.String),
})

const connectionStatusOf = (item: PluggyItem): Connection['status'] =>
  item.status === 'UPDATED' || item.status === 'UPDATING'
    ? 'active'
    : 'attention'

// Transactions are read only from a finished execution that refreshed them;
// an outdated, failing or partial item would ingest stale data as current.
const transactionsReady = (item: PluggyItem) =>
  item.status === 'UPDATED' &&
  item.statusDetail?.transactions?.isUpdated !== false

/**
 * How long an unresolved transaction is kept after the last response that
 * reported it. Pluggy may drop a transaction from one response and return it
 * later; one absence must not stop re-reading its day.
 */
const unresolvedRetentionDays = 30

export class InvalidatedCheckpoint extends Schema.Class<InvalidatedCheckpoint>(
  'InvalidatedCheckpoint',
)({
  balanceObservationId: Schema.String,
  sourceId: Schema.String,
  asOf: Schema.String,
}) {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const crypto = yield* Crypto.Crypto
  const log = yield* EventLog
  const pluggy = yield* PluggyClient
  const accounts = yield* Accounts
  const observations = yield* Observations

  const now = Effect.map(DateTime.now, DateTime.formatIso)
  const today = Effect.map(DateTime.now, (instant) =>
    bookedOn(DateTime.formatIso(instant)),
  )
  const fail = (reason: OpenFinanceError['reason'], detail?: string) =>
    new OpenFinanceError({ reason, detail })

  const findConnection = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Connection,
    execute: (id) => sql`
        SELECT id, owner_id AS ownerId, item_id AS itemId, source_id AS sourceId,
          connector_name AS connectorName, status, provider_status AS providerStatus,
          error_code AS errorCode, last_synced_at AS lastSyncedAt
        FROM open_finance_connections WHERE id = ${id}
      `,
  })
  const providerAccountColumns = sql`
      provider_account_id AS providerAccountId, connection_id AS connectionId, type, subtype,
      name, last_four AS lastFour, currency, account_id AS accountId, history_from AS historyFrom
    `
  const findProviderAccount = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: ProviderAccount,
    execute: (id) =>
      sql`SELECT ${providerAccountColumns} FROM open_finance_accounts WHERE provider_account_id = ${id}`,
  })
  const findProviderAccounts = SqlSchema.findAll({
    Request: Schema.String,
    Result: ProviderAccount,
    execute: (connectionId) => sql`
        SELECT ${providerAccountColumns} FROM open_finance_accounts
        WHERE connection_id = ${connectionId} ORDER BY name
      `,
  })

  const findOldestUnresolved = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ bookedOn: Schema.String }),
    execute: (providerAccountId) => sql`
        SELECT booked_on AS bookedOn FROM open_finance_unresolved
        WHERE provider_account_id = ${providerAccountId} ORDER BY booked_on LIMIT 1
      `,
  })

  // The latest booked observation of each day from a source, with whether it
  // was already withdrawn.
  const findLatestCheckpoints = SqlSchema.findAll({
    Request: Schema.Struct({
      accountId: Schema.String,
      sourceId: Schema.String,
      from: Schema.String,
      to: Schema.String,
    }),
    Result: Schema.Struct({
      id: Schema.String,
      asOf: Schema.String,
      invalidated: Schema.Number,
    }),
    execute: ({ accountId, sourceId, from, to }) => sql`
        SELECT b.id, b.as_of AS asOf,
          EXISTS (SELECT 1 FROM open_finance_checkpoint_invalidations i
            WHERE i.balance_observation_id = b.id) AS invalidated
        FROM balance_observations b
        WHERE b.account_id = ${accountId} AND b.source_id = ${sourceId}
          AND b.kind = 'booked' AND b.as_of >= ${from} AND b.as_of < ${to}
          AND b.rowid = (
            SELECT max(l.rowid) FROM balance_observations l
            WHERE l.account_id = b.account_id AND l.source_id = b.source_id
              AND l.kind = 'booked' AND l.as_of = b.as_of
          )
      `,
  })
  const findInvalidatedCheckpoints = SqlSchema.findAll({
    Request: Schema.String,
    Result: InvalidatedCheckpoint,
    execute: (accountId) => sql`
        SELECT balance_observation_id AS balanceObservationId, source_id AS sourceId,
          as_of AS asOf
        FROM open_finance_checkpoint_invalidations
        WHERE account_id = ${accountId} ORDER BY as_of, balance_observation_id
      `,
  })

  const connection = Effect.fn('OpenFinance.connection')(function* (
    connectionId: string,
  ) {
    const found = yield* findConnection(connectionId)
    if (Option.isNone(found))
      return yield* fail('connection_not_found', connectionId)
    return found.value
  })
  const providerAccount = Effect.fn('OpenFinance.providerAccount')(function* (
    id: string,
  ) {
    const found = yield* findProviderAccount(id)
    if (Option.isNone(found))
      return yield* fail('provider_account_not_found', id)
    return found.value
  })
  const providerAccounts = Effect.fn('OpenFinance.providerAccounts')(
    (connectionId: string) => findProviderAccounts(connectionId),
  )

  // Provider fields are refreshed on every read; the ledger link and window are not.
  const storeProviderAccounts = (
    connectionId: string,
    items: ReadonlyArray<PluggyAccount>,
  ) =>
    Effect.gen(function* () {
      const updatedAt = yield* now
      for (const item of items) {
        yield* sql`
            INSERT INTO open_finance_accounts (provider_account_id, connection_id, type, subtype,
              name, last_four, currency, updated_at)
            VALUES (${item.id}, ${connectionId}, ${item.type}, ${item.subtype ?? null},
              ${providerAccountName(item)}, ${lastFour(item)}, ${item.currencyCode}, ${updatedAt})
            ON CONFLICT (provider_account_id) DO UPDATE SET subtype = excluded.subtype,
              name = excluded.name, last_four = excluded.last_four, updated_at = excluded.updated_at
          `
      }
    })

  const applyItem = (current: Connection, item: PluggyItem) =>
    Effect.gen(function* () {
      const source = yield* observations.registerSource({
        kind: 'open_finance',
        externalRef: item.id,
        label: item.connector.name,
      })
      // A disconnect may have completed while Pluggy answered; its response
      // must not bring the connection back.
      const updated = yield* sql`
          UPDATE open_finance_connections SET source_id = ${source.id},
            connector_name = ${item.connector.name}, status = ${connectionStatusOf(item)},
            provider_status = ${item.status}, error_code = ${item.error?.code ?? null},
            updated_at = ${yield* now}
          WHERE id = ${current.id} AND status != 'disconnected'
          RETURNING id
        `
      if (updated.length === 0) return yield* fail('connection_disconnected')
      yield* storeProviderAccounts(
        current.id,
        yield* pluggy.listAccounts(item.id),
      )
      return yield* connection(current.id)
    })

  const createConnectToken = Effect.fn('OpenFinance.createConnectToken')(
    function* (input: { readonly ownerId: string }) {
      const connectionId = yield* crypto.randomUUIDv7
      const createdAt = yield* now
      yield* sql`
        INSERT INTO open_finance_connections (id, owner_id, status, created_at, updated_at)
        VALUES (${connectionId}, ${input.ownerId}, 'pending', ${createdAt}, ${createdAt})
      `
      const accessToken = yield* pluggy.createConnectToken({
        clientUserId: connectionId,
      })
      return { connectionId, accessToken }
    },
  )

  const reconnectToken = Effect.fn('OpenFinance.reconnectToken')(function* (
    connectionId: string,
  ) {
    const current = yield* connection(connectionId)
    if (current.status === 'disconnected')
      return yield* fail('connection_disconnected')
    return yield* pluggy.createConnectToken({
      clientUserId: current.id,
      itemId: current.itemId ?? undefined,
    })
  })

  const registerItem = Effect.fn('OpenFinance.registerItem')(function* (input: {
    readonly connectionId: string
    readonly itemId: string
  }) {
    const current = yield* connection(input.connectionId)
    if (current.status === 'disconnected')
      return yield* fail('connection_disconnected')
    // A token can create several items sharing one clientUserId; the first
    // registered item stays the connection's item.
    if (current.itemId !== null && current.itemId !== input.itemId)
      return yield* fail('item_already_registered')
    const item = yield* pluggy.getItem(input.itemId)
    // The widget reports the item id from the browser; only an item created
    // with this connection's clientUserId may attach to it.
    if (item.clientUserId !== current.id)
      return yield* fail('item_belongs_elsewhere')
    // Another registration may have pinned an item while Pluggy answered:
    // the first to pin wins, and the loser stores nothing.
    const pinned = yield* sql`
      UPDATE open_finance_connections SET item_id = ${item.id}, updated_at = ${yield* now}
      WHERE id = ${current.id} AND status != 'disconnected'
        AND (item_id IS NULL OR item_id = ${item.id})
      RETURNING id
    `
    if (pinned.length === 0) return yield* fail('item_already_registered')
    yield* applyItem(current, item)
    return yield* providerAccounts(current.id)
  })

  const refreshConnection = Effect.fn('OpenFinance.refreshConnection')(
    function* (connectionId: string) {
      const current = yield* connection(connectionId)
      if (current.status === 'disconnected')
        return yield* fail('connection_disconnected')
      if (current.itemId === null) return current
      return yield* applyItem(current, yield* pluggy.getItem(current.itemId))
    },
  )

  const linkAccount = Effect.fn('OpenFinance.linkAccount')(function* (input: {
    readonly providerAccountId: string
    readonly target: LinkTarget
    readonly historyMonths: HistoryMonths
  }) {
    const provider = yield* providerAccount(input.providerAccountId)
    if (provider.accountId !== null) return yield* fail('already_linked')
    const owner = yield* connection(provider.connectionId)
    if (owner.status === 'disconnected')
      return yield* fail('connection_disconnected')

    const account =
      'accountId' in input.target
        ? yield* accounts.get(input.target.accountId)
        : yield* accounts.open({
            ownerId: owner.ownerId,
            institutionName: owner.connectorName ?? 'Open Finance',
            name: input.target.name ?? provider.name,
            kind: input.target.kind,
            purpose: input.target.purpose,
            currency: provider.currency,
            ...(input.target.card ? { card: input.target.card } : {}),
          })
    const isCard = account.kind === 'credit_card'
    if (
      isCard !== (provider.type === 'CREDIT') ||
      account.currency !== provider.currency ||
      account.ownerId !== owner.ownerId
    ) {
      return yield* fail('incompatible_account', account.id)
    }

    const historyFrom = historyStart({
      today: yield* today,
      months: input.historyMonths,
      closingDay: account.card?.closingDay,
    })
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
            UPDATE open_finance_accounts SET account_id = ${account.id},
              history_from = ${historyFrom}, linked_at = ${yield* now}
            WHERE provider_account_id = ${provider.providerAccountId}
          `
        yield* log.append([
          {
            type: syncRequested,
            streamId: owner.id,
            payload: {
              connectionId: owner.id,
              providerAccountId: provider.providerAccountId,
            },
          },
        ])
      }),
    )
    return account
  })

  // One sync per provider account at a time: two overlapping syncs could
  // otherwise record an older response after a newer one.
  const accountLocks = new Map<string, Semaphore.Semaphore>()
  const lockFor = (providerAccountId: string) => {
    const existing = accountLocks.get(providerAccountId)
    if (existing) return existing
    const created = Semaphore.makeUnsafe(1)
    accountLocks.set(providerAccountId, created)
    return created
  }

  const syncUnlocked = Effect.fnUntraced(function* (providerAccountId: string) {
    const provider = yield* providerAccount(providerAccountId)
    if (provider.accountId === null || provider.historyFrom === null) {
      return yield* fail('not_linked')
    }
    const owner = yield* connection(provider.connectionId)
    if (owner.status === 'disconnected')
      return yield* fail('connection_disconnected')
    if (owner.itemId === null || owner.sourceId === null)
      return yield* fail('not_linked')
    const { accountId, historyFrom } = provider
    const sourceId = owner.sourceId

    const pluggyItem = yield* pluggy.getItem(owner.itemId)
    // As in `applyItem`: a disconnect completed meanwhile wins.
    const updated = yield* sql`
      UPDATE open_finance_connections SET status = ${connectionStatusOf(pluggyItem)},
        provider_status = ${pluggyItem.status}, error_code = ${pluggyItem.error?.code ?? null},
        updated_at = ${yield* now}
      WHERE id = ${owner.id} AND status != 'disconnected'
      RETURNING id
    `
    if (updated.length === 0) return yield* fail('connection_disconnected')
    if (!transactionsReady(pluggyItem)) {
      const waiting: SyncResult = {
        recorded: 0,
        unchanged: 0,
        removed: 0,
        skipped: 0,
        providerReady: false,
      }
      yield* log.append([
        {
          type: accountSynced,
          streamId: owner.id,
          payload: { providerAccountId, ...waiting },
        },
      ])
      return waiting
    }

    const stored = (yield* observations.current(accountId)).filter(
      (observation) => observation.sourceId === sourceId,
    )
    const latest = stored.reduce<string | null>(
      (found, observation) =>
        found === null || observation.bookedOn > found
          ? observation.bookedOn
          : found,
      null,
    )
    // Re-read from the overlap before the latest fact, or further back to the
    // oldest transaction still pending, so it is seen to settle or vanish.
    const oldestPending = stored
      .filter((observation) => observation.status === 'pending')
      .reduce<string | null>(
        (found, observation) =>
          found === null || observation.bookedOn < found
            ? observation.bookedOn
            : found,
        null,
      )
    // A transaction skipped for lacking an amount in the account currency is
    // re-read until it gains one or Pluggy stops reporting it.
    const oldestUnresolved = Option.match(
      yield* findOldestUnresolved(providerAccountId),
      { onNone: () => null, onSome: (row) => row.bookedOn },
    )
    const continuation =
      latest === null ? historyFrom : continuationStart(latest)
    const dateFrom = max(
      historyFrom,
      [oldestPending, oldestUnresolved].reduce<string>(
        (earliest, day) => (day !== null && day < earliest ? day : earliest),
        continuation,
      ),
    )
    const dateTo = yield* today

    const items = yield* pluggy.listAccounts(owner.itemId)
    const item = items.find((candidate) => candidate.id === providerAccountId)
    if (!item)
      return yield* fail('provider_account_not_found', providerAccountId)
    const fetched = yield* pluggy.listTransactions({
      accountId: providerAccountId,
      dateFrom,
      dateTo,
    })

    const reported: Array<ReportedTransaction> = []
    const running: Array<RunningLine> = []
    const unresolved: Array<{ id: string; bookedOn: string }> = []
    let skipped = 0
    for (const transaction of fetched) {
      const normalized = toReportedTransaction(item, transaction)
      if (Option.isNone(normalized)) {
        skipped++
        const day = bookedOn(transaction.date)
        if (day < historyFrom) continue
        unresolved.push({ id: transaction.id, bookedOn: day })
        // Its amount is unknown, so its day cannot be closed.
        if (transaction.status !== 'PENDING') {
          running.push({
            bookedOn: day,
            amountCents: null,
            balanceAfterCents: null,
          })
        }
        continue
      }
      if (normalized.value.bookedOn < historyFrom) continue
      reported.push(normalized.value)
      if (normalized.value.status === 'posted') {
        running.push({
          bookedOn: normalized.value.bookedOn,
          amountCents: normalized.value.amountCents,
          balanceAfterCents: runningBalanceCents(item, transaction),
        })
      }
    }

    // A pending transaction Pluggy stops reporting was replaced or dropped
    // by the bank. Presence is judged by the ids Pluggy returned, not by what
    // could be normalized. Posted ones are never inferred removed from
    // absence: a partial response must not erase facts.
    const seen = new Set(fetched.map((transaction) => transaction.id))
    const vanished = stored.filter(
      (observation) =>
        observation.status === 'pending' &&
        observation.bookedOn >= dateFrom &&
        !seen.has(observation.externalId),
    )
    for (const observation of vanished) {
      reported.push({
        externalId: observation.externalId,
        bookedOn: observation.bookedOn,
        amountCents: observation.amountCents,
        currency: observation.currency,
        description: observation.description,
        status: 'removed',
        raw: { reason: 'absent_from_provider' },
      })
    }

    const result = yield* observations.recordTransactions({
      sourceId,
      accountId,
      transactions: reported,
    })
    // Only after recording: a failed write must not forget what to re-read.
    // Every unresolved transaction from `dateFrom` on was covered by this
    // read: one still unresolved is kept as seen today, one now recorded is
    // done, and one absent is dropped only after a long absence.
    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (const transaction of reported) {
          yield* sql`
            DELETE FROM open_finance_unresolved
            WHERE provider_account_id = ${providerAccountId}
              AND provider_transaction_id = ${transaction.externalId}
          `
        }
        yield* sql`
          DELETE FROM open_finance_unresolved
          WHERE provider_account_id = ${providerAccountId} AND booked_on >= ${dateFrom}
            AND last_seen_on < ${addDays(dateTo, -unresolvedRetentionDays)}
        `
        for (const transaction of unresolved) {
          yield* sql`
            INSERT INTO open_finance_unresolved (provider_account_id, provider_transaction_id,
              booked_on, last_seen_on)
            VALUES (${providerAccountId}, ${transaction.id}, ${transaction.bookedOn}, ${dateTo})
            ON CONFLICT (provider_account_id, provider_transaction_id)
            DO UPDATE SET booked_on = excluded.booked_on, last_seen_on = excluded.last_seen_on
          `
        }
      }),
    )
    if (item.type === 'BANK') {
      // Pluggy's account balance is the available balance when accounts were
      // last collected: kept for reference, never used as a booked
      // checkpoint. An execution that did not refresh accounts reports an old
      // balance, which must not be dated today.
      // A fully successful execution has no `statusDetail`; its collection
      // time is then the item's `lastUpdatedAt`, or the account's.
      const accountsStatus = pluggyItem.statusDetail?.accounts
      if (accountsStatus?.isUpdated !== false) {
        const collectedAt =
          accountsStatus?.lastUpdatedAt ??
          pluggyItem.lastUpdatedAt ??
          item.updatedAt
        yield* observations.recordBalance({
          sourceId,
          accountId,
          balance: {
            kind: 'available',
            asOf: collectedAt ? bookedOn(collectedAt) : dateTo,
            balanceCents: toMinorUnits(item.balance, item.currencyCode),
            currency: item.currencyCode,
          },
        })
      }
      // Booked checkpoints come from the bank's running balances, for
      // complete days only: today may still receive movements.
      const checkpoints = endOfDayBalances(running)
      // A day this read covered that no longer closes on one balance (a line
      // without a running balance, or lines that disagree) withdraws the
      // checkpoint an earlier read inferred for it. Should a later read infer
      // the same balance again, it is already known and not re-recorded, so
      // the day stays without a checkpoint: a missing checkpoint is safe, a
      // stale one is not.
      const closed = new Set(checkpoints.map((checkpoint) => checkpoint.asOf))
      const covered = new Set(running.map((line) => line.bookedOn))
      const invalidatedAt = yield* now
      for (const previous of yield* findLatestCheckpoints({
        accountId,
        sourceId,
        from: dateFrom,
        to: dateTo,
      })) {
        if (
          previous.invalidated === 1 ||
          !covered.has(previous.asOf) ||
          closed.has(previous.asOf)
        )
          continue
        yield* sql`
          INSERT INTO open_finance_checkpoint_invalidations (balance_observation_id, account_id,
            source_id, as_of, invalidated_at)
          VALUES (${previous.id}, ${accountId}, ${sourceId}, ${previous.asOf}, ${invalidatedAt})
        `
      }
      for (const checkpoint of checkpoints) {
        if (checkpoint.asOf >= dateTo) continue
        yield* observations.recordBalance({
          sourceId,
          accountId,
          balance: {
            kind: 'booked',
            asOf: checkpoint.asOf,
            balanceCents: checkpoint.balanceCents,
            currency: item.currencyCode,
          },
        })
      }
    }
    const summary: SyncResult = {
      recorded: result.recorded.length - vanished.length,
      unchanged: result.unchanged,
      removed: vanished.length,
      skipped,
      providerReady: true,
    }
    yield* sql`
        UPDATE open_finance_connections SET last_synced_at = ${yield* now} WHERE id = ${owner.id}
      `
    yield* log.append([
      {
        type: accountSynced,
        streamId: owner.id,
        payload: { providerAccountId, ...summary },
      },
    ])
    return summary
  })

  const syncAccount = Effect.fn('OpenFinance.syncAccount')(
    (providerAccountId: string) =>
      lockFor(providerAccountId).withPermits(1)(
        syncUnlocked(providerAccountId),
      ),
  )

  const requestSync = Effect.fn('OpenFinance.requestSync')(function* (
    request: typeof SyncRequest.Type,
  ) {
    yield* connection(request.connectionId)
    yield* log.append([
      {
        type: syncRequested,
        streamId: request.connectionId,
        payload: {
          connectionId: request.connectionId,
          ...(request.providerAccountId
            ? { providerAccountId: request.providerAccountId }
            : {}),
        },
      },
    ])
  })

  /**
   * Booked checkpoints a later read withdrew. A reader of booked balances
   * from an open_finance source takes each day's latest observation and
   * treats the day as having no checkpoint when it is listed here.
   */
  const invalidatedCheckpoints = Effect.fn(
    'OpenFinance.invalidatedCheckpoints',
  )((accountId: string) => findInvalidatedCheckpoints(accountId))

  const disconnect = Effect.fn('OpenFinance.disconnect')(function* (
    connectionId: string,
  ) {
    const current = yield* connection(connectionId)
    if (current.itemId !== null) {
      // Revoking consent at Pluggy comes first; an item already gone is fine.
      yield* pluggy.deleteItem(current.itemId).pipe(
        Effect.catchIf(
          (error) => error.reason === 'not_found',
          () => Effect.void,
        ),
      )
    }
    yield* sql`
        UPDATE open_finance_connections SET status = 'disconnected', updated_at = ${yield* now}
        WHERE id = ${connectionId}
      `
  })

  return {
    createConnectToken,
    reconnectToken,
    registerItem,
    refreshConnection,
    linkAccount,
    syncAccount,
    requestSync,
    disconnect,
    connection,
    providerAccounts,
    invalidatedCheckpoints,
  }
})

export class OpenFinance extends Context.Service<
  OpenFinance,
  Effect.Success<typeof make>
>()('@spendle/server/openfinance/OpenFinance') {
  static readonly layer = Layer.effect(OpenFinance, make)
}
