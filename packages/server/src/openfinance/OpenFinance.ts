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

import { addDays, max, today } from '../domain/LocalDate.ts'
import { EventLog } from '../events/EventLog.ts'
import {
  Accounts,
  AccountKind,
  AccountPurpose,
  CardTerms,
  OwnerNotFound,
} from '../ledger/Accounts.ts'
import { Observations } from '../ledger/Observations.ts'
import type {
  ReportedTransaction,
  TransactionObservation,
} from '../ledger/Observations.ts'
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
import { WebhookConfig } from './WebhookConfig.ts'

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
      'item_deleted',
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

/**
 * How long a pending transaction removed for being absent from a response
 * keeps its day re-read, counted from its removal. Pluggy may omit a
 * transaction temporarily and return it later, often already posted.
 */
const absentPendingRetentionDays = 30

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
  // With webhooks on, each item is created pointing at our endpoint.
  const webhookUrl = Option.map(
    yield* WebhookConfig,
    (settings) => settings.url,
  ).pipe(Option.getOrUndefined)
  const accounts = yield* Accounts
  const observations = yield* Observations

  const now = Effect.map(DateTime.now, DateTime.formatIso)
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

  const findOldestAbsentPending = SqlSchema.findOneOption({
    Request: Schema.Struct({
      providerAccountId: Schema.String,
      removedSince: Schema.String,
    }),
    Result: Schema.Struct({ bookedOn: Schema.String }),
    execute: ({ providerAccountId, removedSince }) => sql`
        SELECT booked_on AS bookedOn FROM open_finance_absent_pending
        WHERE provider_account_id = ${providerAccountId} AND removed_on >= ${removedSince}
        ORDER BY booked_on LIMIT 1
      `,
  })

  // Unresolved transactions a sync's date range does not reach: known ones a
  // correction moved before the history start or past today.
  const findUnresolvedOutside = SqlSchema.findAll({
    Request: Schema.Struct({
      providerAccountId: Schema.String,
      from: Schema.String,
      to: Schema.String,
    }),
    Result: Schema.Struct({ id: Schema.String }),
    execute: ({ providerAccountId, from, to }) => sql`
        SELECT provider_transaction_id AS id FROM open_finance_unresolved
        WHERE provider_account_id = ${providerAccountId}
          AND (booked_on < ${from} OR booked_on > ${to})
      `,
  })

  const findUnresolvedDays = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({ bookedOn: Schema.String }),
    execute: (providerAccountId) => sql`
        SELECT DISTINCT booked_on AS bookedOn FROM open_finance_unresolved
        WHERE provider_account_id = ${providerAccountId}
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
      balanceCents: Schema.Int,
      invalidated: Schema.Number,
    }),
    execute: ({ accountId, sourceId, from, to }) => sql`
        SELECT b.id, b.as_of AS asOf, b.balance_cents AS balanceCents,
          COALESCE((SELECT i.withdrawn FROM open_finance_checkpoint_invalidations i
            WHERE i.balance_observation_id = b.id ORDER BY i.rowid DESC LIMIT 1), 0)
            AS invalidated
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
        SELECT i.balance_observation_id AS balanceObservationId, i.source_id AS sourceId,
          i.as_of AS asOf
        FROM open_finance_checkpoint_invalidations i
        WHERE i.account_id = ${accountId} AND i.withdrawn = 1
          AND i.rowid = (
            SELECT max(l.rowid) FROM open_finance_checkpoint_invalidations l
            WHERE l.balance_observation_id = i.balance_observation_id
          )
        ORDER BY i.as_of, i.balance_observation_id
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
  const findConnections = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Connection,
    execute: () => sql`
        SELECT id, owner_id AS ownerId, item_id AS itemId, source_id AS sourceId,
          connector_name AS connectorName, status, provider_status AS providerStatus,
          error_code AS errorCode, last_synced_at AS lastSyncedAt
        FROM open_finance_connections ORDER BY created_at DESC, id DESC
      `,
  })
  /** Every connection, newest first, disconnected ones included as history. */
  const connections = findConnections(undefined).pipe(
    Effect.withSpan('OpenFinance.connections'),
  )

  // Writes what Pluggy answered only if the connection was not disconnected
  // meanwhile: an item/deleted or disconnect that landed while Pluggy
  // answered wins. The check and the writes share one transaction, so a
  // disconnect cannot slip between them.
  const whileConnected = <A, E, R>(
    connectionId: string,
    write: Effect.Effect<A, E, R>,
  ) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const live = yield* sql`
          SELECT 1 FROM open_finance_connections
          WHERE id = ${connectionId} AND status != 'disconnected'
        `
        if (live.length === 0) return yield* fail('connection_disconnected')
        return yield* write
      }),
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
      const listed = yield* pluggy.listAccounts(item.id)
      yield* whileConnected(
        current.id,
        storeProviderAccounts(current.id, listed),
      )
      return yield* connection(current.id)
    })

  const createConnectToken = Effect.fn('OpenFinance.createConnectToken')(
    function* (input: { readonly ownerId: string }) {
      const owner = yield* sql`SELECT 1 FROM owners WHERE id = ${input.ownerId}`
      if (owner.length === 0)
        return yield* new OwnerNotFound({ ownerId: input.ownerId })
      // A request the person abandoned in the widget is tried again rather
      // than left behind as another connection that never reached a bank.
      const unfinished = yield* sql<{ id: string }>`
        SELECT id FROM open_finance_connections
        WHERE owner_id = ${input.ownerId} AND status = 'pending' AND item_id IS NULL
        ORDER BY created_at, id LIMIT 1
      `
      const connectionId = unfinished[0]?.id ?? (yield* crypto.randomUUIDv7)
      if (unfinished.length === 0) {
        const createdAt = yield* now
        yield* sql`
          INSERT INTO open_finance_connections (id, owner_id, status, created_at, updated_at)
          VALUES (${connectionId}, ${input.ownerId}, 'pending', ${createdAt}, ${createdAt})
        `
      }
      const accessToken = yield* pluggy.createConnectToken({
        clientUserId: connectionId,
        webhookUrl,
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
      webhookUrl,
    })
  })

  // Attaches a fetched item to the connection, once known to be its own.
  const attachItem = Effect.fnUntraced(function* (
    current: Connection,
    item: PluggyItem,
  ) {
    // The widget reports the item id from the browser; only an item created
    // with this connection's clientUserId may attach to it.
    if (item.clientUserId !== current.id)
      return yield* fail('item_belongs_elsewhere')
    // Another registration may have pinned an item while Pluggy answered:
    // the first to pin wins, and the loser stores nothing. Pluggy may also
    // have deleted the item meanwhile; the deletion and the pin are each one
    // statement, so either the pin sees the deletion or the deletion sees
    // the pinned item and disconnects the connection.
    const pinned = yield* sql`
      UPDATE open_finance_connections SET item_id = ${item.id}, updated_at = ${yield* now}
      WHERE id = ${current.id} AND status != 'disconnected'
        AND (item_id IS NULL OR item_id = ${item.id})
        AND NOT EXISTS (SELECT 1 FROM open_finance_deleted_items WHERE item_id = ${item.id})
      RETURNING id
    `
    if (pinned.length === 0) {
      const deleted = yield* sql`
        SELECT 1 FROM open_finance_deleted_items WHERE item_id = ${item.id}
      `
      // The connection never held the deleted item, so it stays pending:
      // another item from the same connect token can still attach to it.
      return yield* fail(
        deleted.length > 0 ? 'item_deleted' : 'item_already_registered',
        deleted.length > 0 ? item.id : undefined,
      )
    }
    yield* applyItem(current, item)
    return yield* providerAccounts(current.id)
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
    return yield* attachItem(current, yield* pluggy.getItem(input.itemId))
  })

  /**
   * Attaches an item Pluggy reported by webhook to the pending connection
   * whose connect token created it, when the widget callback never arrived.
   * The connection is the item's `clientUserId`; an item of no pending
   * connection here is left alone. Returns the connection it attached to.
   */
  const adoptItem = Effect.fn('OpenFinance.adoptItem')(function* (
    itemId: string,
  ) {
    const item = yield* pluggy.getItem(itemId)
    if (!item.clientUserId) return Option.none<string>()
    const pending = yield* findConnection(item.clientUserId)
    if (
      Option.isNone(pending) ||
      pending.value.status !== 'pending' ||
      pending.value.itemId !== null
    )
      return Option.none<string>()
    yield* attachItem(pending.value, item)
    return Option.some(pending.value.id)
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
        // A ledger account takes one live link; a disconnected connection's
        // link no longer holds it.
        const held = yield* sql`
            SELECT 1 FROM open_finance_accounts
            WHERE account_id = ${account.id} AND unlinked_at IS NULL
          `
        if (held.length > 0) return yield* fail('already_linked', account.id)
        // A disconnect may have completed since the checks above.
        const linked = yield* sql`
            UPDATE open_finance_accounts SET account_id = ${account.id},
              history_from = ${historyFrom}, linked_at = ${yield* now}
            WHERE provider_account_id = ${provider.providerAccountId}
              AND account_id IS NULL
              AND EXISTS (SELECT 1 FROM open_finance_connections c
                WHERE c.id = connection_id AND c.status != 'disconnected')
            RETURNING provider_account_id
          `
        if (linked.length === 0) return yield* fail('connection_disconnected')
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

  /**
   * Booked checkpoints are a function of the current facts. A day yields one
   * only when every posted transaction this source holds for it carries a
   * running balance from this response, none of its transactions is still
   * unresolved, and those lines agree on one closing balance; today never
   * does, as it may still receive movements. Judged are the days this read
   * covered and the days a returned transaction left or joined, recorded or
   * not. A judged day that yields none withdraws the checkpoint an earlier
   * read inferred for it, even when no posted line remains on it; a later
   * complete read that infers the withdrawn balance again reinstates it. A
   * missing checkpoint is safe, a stale one is not. `only`
   * restricts the judged days to those a read covered completely;
   * `incompleteDays` yield no checkpoint, as unresolved ones.
   */
  const reconcileCheckpoints = Effect.fnUntraced(function* (input: {
    readonly accountId: string
    readonly sourceId: string
    readonly providerAccountId: string
    readonly currency: string
    readonly dateFrom: string
    readonly dateTo: string
    readonly stored: ReadonlyArray<TransactionObservation>
    /** Every transaction this response returned, convertible or not, by its reported day. */
    readonly reported: ReadonlyArray<{
      readonly externalId: string
      readonly bookedOn: string
    }>
    readonly runningBalances: ReadonlyMap<
      string,
      { readonly bookedOn: string; readonly balanceAfterCents: number | null }
    >
    readonly only?: ReadonlySet<string>
    readonly incompleteDays?: ReadonlySet<string>
  }) {
    const { accountId, sourceId, dateFrom, dateTo } = input
    const inWindow = (day: string) => day >= dateFrom && day < dateTo
    const allowed = (day: string) => input.only?.has(day) ?? true
    const posted = (yield* observations.current(accountId)).filter(
      (observation) =>
        observation.sourceId === sourceId && observation.status === 'posted',
    )
    const previousDay = new Map(
      input.stored.map((observation) => [
        observation.externalId,
        observation.bookedOn,
      ]),
    )
    const judged = new Set<string>()
    // A transaction returned on another day than its stored fact moves away
    // from that day even when it cannot be recorded (an unconvertible
    // correction): both days are judged, and the old fact stays as it is.
    for (const transaction of input.reported) {
      judged.add(transaction.bookedOn)
      const previous = previousDay.get(transaction.externalId)
      if (previous !== undefined) judged.add(previous)
    }
    for (const observation of posted)
      if (inWindow(observation.bookedOn)) judged.add(observation.bookedOn)
    for (const day of judged) if (!allowed(day)) judged.delete(day)
    const earliest = [...judged].reduce(
      (found, day) => (day < found ? day : found),
      dateFrom,
    )
    const previousCheckpoints = (yield* findLatestCheckpoints({
      accountId,
      sourceId,
      from: earliest,
      to: addDays(dateTo, 1),
    })).filter(
      (checkpoint) =>
        allowed(checkpoint.asOf) &&
        (inWindow(checkpoint.asOf) || judged.has(checkpoint.asOf)),
    )
    for (const checkpoint of previousCheckpoints) judged.add(checkpoint.asOf)
    const unresolvedDays = new Set([
      ...(yield* findUnresolvedDays(input.providerAccountId)).map(
        (row) => row.bookedOn,
      ),
      ...(input.incompleteDays ?? []),
    ])

    const closings = new Map<string, number>()
    for (const day of judged) {
      if (day >= dateTo || unresolvedDays.has(day)) continue
      const lines = posted
        .filter((observation) => observation.bookedOn === day)
        .map((observation): RunningLine => {
          const line = input.runningBalances.get(observation.externalId)
          return {
            bookedOn: day,
            amountCents: observation.amountCents,
            balanceAfterCents:
              line?.bookedOn === day ? line.balanceAfterCents : null,
          }
        })
      const [checkpoint] = endOfDayBalances(lines)
      if (checkpoint) closings.set(day, checkpoint.balanceCents)
    }

    const invalidatedAt = yield* now
    const mark = (
      previous: (typeof previousCheckpoints)[number],
      withdrawn: 0 | 1,
    ) =>
      sql`
        INSERT INTO open_finance_checkpoint_invalidations (balance_observation_id, withdrawn,
          account_id, source_id, as_of, invalidated_at)
        VALUES (${previous.id}, ${withdrawn}, ${accountId}, ${sourceId}, ${previous.asOf}, ${invalidatedAt})
      `
    for (const previous of previousCheckpoints) {
      const closing = closings.get(previous.asOf)
      // A complete read that confirms a withdrawn balance reinstates it: the
      // ledger would not record the same balance again.
      if (previous.invalidated === 1 && closing === previous.balanceCents)
        yield* mark(previous, 0)
      else if (previous.invalidated === 0 && closing === undefined)
        yield* mark(previous, 1)
    }
    for (const [asOf, balanceCents] of [...closings].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      yield* observations.recordBalance({
        sourceId,
        accountId,
        balance: {
          kind: 'booked',
          asOf,
          balanceCents,
          currency: input.currency,
        },
      })
    }
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
    const dateTo = yield* today
    // A future-dated line (an instalment a webhook copied) must not carry the
    // continuation past today, where no read could reach current days.
    const latest = stored
      .filter((observation) => observation.bookedOn <= dateTo)
      .reduce<string | null>(
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
    // A pending transaction removed for being absent from an earlier response
    // is re-read until it returns or its retention passes: once removed it is
    // no longer among the current observations above.
    const absentRemovedSince = addDays(dateTo, -absentPendingRetentionDays)
    const oldestAbsentPending = Option.match(
      yield* findOldestAbsentPending({
        providerAccountId,
        removedSince: absentRemovedSince,
      }),
      { onNone: () => null, onSome: (row) => row.bookedOn },
    )
    const continuation =
      latest === null ? historyFrom : continuationStart(latest)
    const dateFrom = max(
      historyFrom,
      [oldestPending, oldestUnresolved, oldestAbsentPending].reduce<string>(
        (earliest, day) => (day !== null && day < earliest ? day : earliest),
        continuation,
      ),
    )

    const items = yield* pluggy.listAccounts(owner.itemId)
    const item = items.find((candidate) => candidate.id === providerAccountId)
    if (!item)
      return yield* fail('provider_account_not_found', providerAccountId)
    const inRange = yield* pluggy.listTransactions({
      accountId: providerAccountId,
      dateFrom,
      dateTo,
    })
    // An unresolved transaction outside the range is re-read by id, so a
    // known one moved before the history start or past today still gains its
    // amount, and its previous fact is not taken for absent.
    const inRangeIds = new Set(inRange.map((transaction) => transaction.id))
    const strayIds = (yield* findUnresolvedOutside({
      providerAccountId,
      from: dateFrom,
      to: dateTo,
    }))
      .map((row) => row.id)
      .filter((id) => !inRangeIds.has(id))
    const strays =
      strayIds.length > 0
        ? (yield* pluggy.listTransactions({
            accountId: providerAccountId,
            ids: strayIds,
          })).filter((transaction) => !inRangeIds.has(transaction.id))
        : []
    const fetched = [...inRange, ...strays]
    // A card's closed bills say what the bank billed and when, which the
    // transactions alone do not: it may bill a charge on a later bill than
    // its date suggests, and the history leaves out the first bill's
    // earlier charges.
    const bills =
      item.type === 'CREDIT' ? yield* pluggy.listBills(providerAccountId) : []
    // Known means ever observed, removed or not: one inferred removed and
    // returned on another day is restored wherever Pluggy moved it.
    const known = yield* observations.observedIds({ sourceId, accountId })

    const reported: Array<ReportedTransaction> = []
    // The running balance this response gave each posted transaction.
    const runningBalances = new Map<
      string,
      { readonly bookedOn: string; readonly balanceAfterCents: number | null }
    >()
    const unresolved: Array<{ id: string; bookedOn: string }> = []
    let skipped = 0
    for (const transaction of fetched) {
      // The history start gates only transactions never seen before; a
      // known one is updated wherever Pluggy moves it.
      const day = bookedOn(transaction.date)
      if (day < historyFrom && !known.has(transaction.id)) continue
      const normalized = toReportedTransaction(item, transaction)
      if (Option.isNone(normalized)) {
        skipped++
        unresolved.push({ id: transaction.id, bookedOn: day })
        continue
      }
      reported.push(normalized.value)
      // A line read by id carries a running balance, but its day was not
      // read whole: it backs no closing balance.
      if (
        normalized.value.status === 'posted' &&
        inRangeIds.has(transaction.id)
      ) {
        runningBalances.set(normalized.value.externalId, {
          bookedOn: normalized.value.bookedOn,
          balanceAfterCents: runningBalanceCents(item, transaction),
        })
      }
    }

    // A pending transaction Pluggy stops reporting within the range read was
    // replaced or dropped by the bank. Presence is judged by the ids Pluggy returned, not by what
    // could be normalized. Posted ones are never inferred removed from
    // absence: a partial response must not erase facts.
    const seen = new Set(fetched.map((transaction) => transaction.id))
    const vanished = stored.filter(
      (observation) =>
        observation.status === 'pending' &&
        observation.bookedOn >= dateFrom &&
        observation.bookedOn <= dateTo &&
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

    // Everything this read concluded is written at once, after all provider
    // I/O: should any write fail, the transaction facts roll back too, and
    // the retry sees the same changes again instead of finding them stored
    // and leaving the days they left unjudged. Nothing from this read is
    // written once the connection is disconnected.
    return yield* whileConnected(
      owner.id,
      Effect.gen(function* () {
        const result = yield* observations.recordTransactions({
          sourceId,
          accountId,
          transactions: reported,
        })
        // Every unresolved transaction was covered by this read, by range or
        // by id: one still unresolved is kept as seen today, one now
        // recorded is done, and one absent is dropped only after a long
        // absence.
        for (const transaction of reported) {
          yield* sql`
            DELETE FROM open_finance_unresolved
            WHERE provider_account_id = ${providerAccountId}
              AND provider_transaction_id = ${transaction.externalId}
          `
        }
        yield* sql`
          DELETE FROM open_finance_unresolved
          WHERE provider_account_id = ${providerAccountId}
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
        // A transaction removed for absence and reported again is no longer
        // awaited; one removed now is awaited from today; past retention it is
        // dropped.
        for (const id of seen) {
          yield* sql`
            DELETE FROM open_finance_absent_pending
            WHERE provider_account_id = ${providerAccountId}
              AND provider_transaction_id = ${id}
          `
        }
        yield* sql`
          DELETE FROM open_finance_absent_pending
          WHERE provider_account_id = ${providerAccountId}
            AND removed_on < ${absentRemovedSince}
        `
        for (const observation of vanished) {
          yield* sql`
            INSERT INTO open_finance_absent_pending (provider_account_id,
              provider_transaction_id, booked_on, removed_on)
            VALUES (${providerAccountId}, ${observation.externalId}, ${observation.bookedOn}, ${dateTo})
            ON CONFLICT (provider_account_id, provider_transaction_id)
            DO UPDATE SET booked_on = excluded.booked_on, removed_on = excluded.removed_on
          `
        }
        // Pluggy's account balance is the balance when accounts were last
        // collected: a bank account's available balance, or the limit a
        // card has in use, which the ledger signs as debt. It is the
        // account's actual balance for cash and forecasts, never a booked
        // checkpoint for balance proofs. An execution that did not refresh
        // accounts reports an old balance, which must not be dated today.
        // A fully successful execution has no `statusDetail`; its collection
        // time is then the item's `lastUpdatedAt`, or the account's.
        const accountsStatus = pluggyItem.statusDetail?.accounts
        if (accountsStatus?.isUpdated !== false) {
          const collectedAt =
            accountsStatus?.lastUpdatedAt ??
            pluggyItem.lastUpdatedAt ??
            item.updatedAt
          const asOf = collectedAt ? bookedOn(collectedAt) : dateTo
          const balanceCents = toMinorUnits(item.balance, item.currencyCode)
          yield* observations.recordBalance({
            sourceId,
            accountId,
            balance: {
              kind: 'available',
              asOf,
              balanceCents:
                item.type === 'CREDIT' ? 0 - balanceCents : balanceCents,
              currency: item.currencyCode,
            },
          })
          if (item.type === 'CREDIT') {
            const cents = (amount: number | null | undefined) =>
              typeof amount === 'number'
                ? toMinorUnits(amount, item.currencyCode)
                : null
            yield* sql`
              UPDATE open_finance_accounts
              SET credit_limit_cents = ${cents(item.creditData?.creditLimit)},
                available_credit_cents = ${cents(item.creditData?.availableCreditLimit)},
                credit_as_of = ${asOf}
              WHERE provider_account_id = ${providerAccountId}
            `
          }
        }
        const observedAt = yield* now
        for (const bill of bills) {
          // Without its closing a bill cannot be told from the cycles.
          if (!bill.billClosingDate) continue
          const currency = bill.totalAmountCurrencyCode ?? item.currencyCode
          // Bill dates are calendar days written as UTC midnight, not
          // instants: São Paulo time would move them to the day before.
          yield* sql`
            INSERT OR IGNORE INTO card_bill_observations (source_id, account_id,
              bill_id, closing_on, due_on, total_cents, currency, observed_at)
            VALUES (${sourceId}, ${accountId}, ${bill.id}, ${bill.billClosingDate.slice(0, 10)},
              ${bill.dueDate.slice(0, 10)}, ${toMinorUnits(bill.totalAmount, currency)},
              ${currency}, ${observedAt})
          `
        }
        if (item.type === 'BANK') {
          yield* reconcileCheckpoints({
            accountId,
            sourceId,
            providerAccountId,
            currency: item.currencyCode,
            dateFrom,
            dateTo,
            stored,
            reported: fetched.map((transaction) => ({
              externalId: transaction.id,
              bookedOn: bookedOn(transaction.date),
            })),
            runningBalances,
          })
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
      }),
    )
  })

  /**
   * The person stops copying a provider account into its ledger account.
   * What was already copied stays as facts of that account; syncs of the
   * provider account stop until it is linked again, to this or another
   * ledger account. Waits for a running sync of it to finish.
   */
  const unlinkAccount = Effect.fn('OpenFinance.unlinkAccount')(
    (providerAccountId: string) =>
      lockFor(providerAccountId).withPermits(1)(
        sql.withTransaction(
          Effect.gen(function* () {
            const provider = yield* providerAccount(providerAccountId)
            if (provider.accountId === null) return yield* fail('not_linked')
            const owner = yield* connection(provider.connectionId)
            if (owner.status === 'disconnected')
              return yield* fail('connection_disconnected')
            yield* sql`
              UPDATE open_finance_accounts SET account_id = NULL, history_from = NULL,
                linked_at = NULL, updated_at = ${yield* now}
              WHERE provider_account_id = ${providerAccountId}
            `
            // Re-read bookkeeping belongs to the link that ends here.
            yield* sql`
              DELETE FROM open_finance_unresolved WHERE provider_account_id = ${providerAccountId}
            `
            yield* sql`
              DELETE FROM open_finance_absent_pending WHERE provider_account_id = ${providerAccountId}
            `
          }),
        ),
      ),
  )

  const syncAccount = Effect.fn('OpenFinance.syncAccount')(
    (providerAccountId: string) =>
      lockFor(providerAccountId).withPermits(1)(
        syncUnlocked(providerAccountId),
      ),
  )

  /**
   * Reads specific transactions Pluggy says were created or updated,
   * wherever they fall in time: a change to an old transaction is outside
   * the regular sync's overlap. The account's history start still applies to
   * transactions never seen before; known ones are always updated. A bank
   * account's checkpoints on the days those transactions left or joined are
   * judged again from a read of those whole days: the changed transactions
   * alone cannot establish a day's closing balance.
   */
  const refreshTransactions = Effect.fn('OpenFinance.refreshTransactions')(
    (
      providerAccountId: string,
      query:
        | { readonly ids: ReadonlyArray<string> }
        | { readonly createdAtFrom: string },
    ) =>
      lockFor(providerAccountId).withPermits(1)(
        Effect.gen(function* () {
          const found = yield* findProviderAccount(providerAccountId)
          if (
            Option.isNone(found) ||
            found.value.accountId === null ||
            found.value.historyFrom === null
          )
            return 0
          const provider = found.value
          const accountId = found.value.accountId
          const historyFrom = found.value.historyFrom
          const owner = yield* connection(provider.connectionId)
          if (
            owner.status === 'disconnected' ||
            owner.itemId === null ||
            owner.sourceId === null
          )
            return 0
          const sourceId = owner.sourceId
          const item = (yield* pluggy.listAccounts(owner.itemId)).find(
            (candidate) => candidate.id === providerAccountId,
          )
          if (!item) return 0
          const fetched = yield* pluggy.listTransactions({
            accountId: providerAccountId,
            ...query,
          })
          const stored = (yield* observations.current(accountId)).filter(
            (observation) => observation.sourceId === sourceId,
          )
          const storedDay = new Map(
            stored.map((observation) => [
              observation.externalId,
              observation.bookedOn,
            ]),
          )
          // The history start gates only transactions never observed; one
          // removed before is restored wherever Pluggy moved it.
          const observed = yield* observations.observedIds({
            sourceId,
            accountId,
          })
          const dateTo = yield* today
          const reported: Array<ReportedTransaction> = []
          // Every returned transaction in scope, recordable or not, by the
          // day Pluggy now reports it on.
          const returned: Array<{ externalId: string; bookedOn: string }> = []
          // One without an amount in the account currency is skipped, as in
          // a sync: its stored fact stays as it is, it is re-read until it
          // gains one, and the days it left and joined yield no checkpoint
          // meanwhile.
          const unresolved: Array<{ id: string; bookedOn: string }> = []
          const incompleteDays = new Set<string>()
          for (const transaction of fetched) {
            const day = bookedOn(transaction.date)
            const known = storedDay.get(transaction.id)
            if (day < historyFrom && !observed.has(transaction.id)) continue
            returned.push({ externalId: transaction.id, bookedOn: day })
            const normalized = toReportedTransaction(item, transaction)
            if (Option.isNone(normalized)) {
              incompleteDays.add(day)
              if (known !== undefined) incompleteDays.add(known)
              // Known ones are tracked wherever they moved: a sync re-reads
              // those outside its range by id.
              unresolved.push({ id: transaction.id, bookedOn: day })
              continue
            }
            reported.push(normalized.value)
          }

          // The days these transactions are on or were on, before today;
          // only bank accounts carry checkpoints.
          const affected = new Set<string>()
          if (item.type === 'BANK')
            for (const transaction of returned) {
              affected.add(transaction.bookedOn)
              const previous = storedDay.get(transaction.externalId)
              if (previous !== undefined) affected.add(previous)
            }
          const days = [...affected].filter((day) => day < dateTo).sort()
          const first = days[0]
          const last = days[days.length - 1]
          const wholeDays =
            first !== undefined && last !== undefined
              ? yield* pluggy.listTransactions({
                  accountId: providerAccountId,
                  dateFrom: first,
                  dateTo: last,
                })
              : []
          const judged = new Set(days)
          const runningBalances = new Map<
            string,
            {
              readonly bookedOn: string
              readonly balanceAfterCents: number | null
            }
          >()
          // A judged day with a line that cannot be compared with the stored
          // facts yields no checkpoint.
          const postedLines: Array<ReportedTransaction> = []
          for (const transaction of wholeDays) {
            const normalized = toReportedTransaction(item, transaction)
            if (Option.isNone(normalized)) {
              incompleteDays.add(bookedOn(transaction.date))
              continue
            }
            if (normalized.value.status !== 'posted') continue
            postedLines.push(normalized.value)
            runningBalances.set(normalized.value.externalId, {
              bookedOn: normalized.value.bookedOn,
              balanceAfterCents: runningBalanceCents(item, transaction),
            })
          }

          const result = yield* whileConnected(
            owner.id,
            Effect.gen(function* () {
              const recorded = yield* observations.recordTransactions({
                sourceId,
                accountId,
                transactions: reported,
              })
              for (const transaction of reported) {
                yield* sql`
                  DELETE FROM open_finance_unresolved
                  WHERE provider_account_id = ${providerAccountId}
                    AND provider_transaction_id = ${transaction.externalId}
                `
              }
              for (const transaction of unresolved) {
                yield* sql`
                  INSERT INTO open_finance_unresolved (provider_account_id,
                    provider_transaction_id, booked_on, last_seen_on)
                  VALUES (${providerAccountId}, ${transaction.id}, ${transaction.bookedOn}, ${dateTo})
                  ON CONFLICT (provider_account_id, provider_transaction_id)
                  DO UPDATE SET booked_on = excluded.booked_on,
                    last_seen_on = excluded.last_seen_on
                `
              }
              if (first === undefined || last === undefined) return recorded
              // The day's stored facts are complete only when they hold
              // every posted line of the full-day read as Pluggy reports it
              // now. A line never copied, settled since, or whose stored
              // amount, currency or day differs (a correction not delivered
              // yet) would pair a stale amount with a newer running balance.
              const held = new Map(
                (yield* observations.current(accountId))
                  .filter(
                    (observation) =>
                      observation.sourceId === sourceId &&
                      observation.status === 'posted',
                  )
                  .map((observation) => [observation.externalId, observation]),
              )
              for (const line of postedLines) {
                const fact = held.get(line.externalId)
                if (
                  fact === undefined ||
                  fact.bookedOn !== line.bookedOn ||
                  fact.amountCents !== line.amountCents ||
                  fact.currency !== line.currency
                ) {
                  incompleteDays.add(line.bookedOn)
                  if (fact !== undefined) incompleteDays.add(fact.bookedOn)
                }
              }
              yield* reconcileCheckpoints({
                accountId,
                sourceId,
                providerAccountId,
                currency: item.currencyCode,
                dateFrom: first,
                dateTo: addDays(last, 1),
                stored,
                reported: returned,
                runningBalances,
                only: judged,
                incompleteDays,
              })
              return recorded
            }),
          )
          return result.recorded.length
        }),
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

  /**
   * Marks a connection disconnected and releases its links' ledger accounts,
   * which stay linkable through another connection; account_id is kept as
   * history. Shared by every way a connection ends: the person's disconnect
   * and Pluggy's own deletion of the item.
   */
  const disconnectLocally = Effect.fnUntraced(function* (connectionId: string) {
    const disconnectedAt = yield* now
    yield* sql`
      UPDATE open_finance_connections SET status = 'disconnected',
        updated_at = ${disconnectedAt}
      WHERE id = ${connectionId} AND status != 'disconnected'
    `
    yield* sql`
      UPDATE open_finance_accounts SET unlinked_at = ${disconnectedAt}
      WHERE connection_id = ${connectionId} AND account_id IS NOT NULL
        AND unlinked_at IS NULL
    `
  })

  const disconnect = Effect.fn('OpenFinance.disconnect')(function* (
    connectionId: string,
  ) {
    // A request that never reached a bank holds nothing to keep as history:
    // it goes away. One whose item was pinned meanwhile is disconnected.
    const removed = yield* sql`
      DELETE FROM open_finance_connections
      WHERE id = ${connectionId} AND item_id IS NULL AND status != 'disconnected'
      RETURNING id
    `
    if (removed.length > 0) return
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
    yield* sql.withTransaction(disconnectLocally(connectionId))
  })

  const findConnectionByItem = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ id: Schema.String }),
    execute: (itemId) =>
      sql`SELECT id FROM open_finance_connections WHERE item_id = ${itemId}`,
  })

  /** The connection that owns a Pluggy item, if any. */
  const connectionByItem = Effect.fn('OpenFinance.connectionByItem')(function* (
    itemId: string,
  ) {
    const found = yield* findConnectionByItem(itemId)
    return yield* Option.match(found, {
      onNone: () => Effect.succeed(Option.none<Connection>()),
      onSome: ({ id }) => Effect.map(connection(id), Option.some),
    })
  })

  /** Pluggy deleted the item (consent revoked or expired); nothing to delete remotely. */
  const markItemDeleted = Effect.fn('OpenFinance.markItemDeleted')(function* (
    connectionId: string,
  ) {
    yield* sql.withTransaction(disconnectLocally(connectionId))
  })

  /**
   * Pluggy deleted the item (item/deleted). The deletion is kept even when no
   * connection holds the item yet, so a registration still waiting on Pluggy
   * cannot attach it afterwards; a connection that holds it is disconnected.
   */
  const itemDeleted = Effect.fn('OpenFinance.itemDeleted')(function* (
    itemId: string,
  ) {
    const deletedAt = yield* now
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          INSERT INTO open_finance_deleted_items (item_id, deleted_at)
          VALUES (${itemId}, ${deletedAt})
          ON CONFLICT (item_id) DO NOTHING
        `
        const holder = yield* findConnectionByItem(itemId)
        if (Option.isSome(holder)) yield* disconnectLocally(holder.value.id)
      }),
    )
  })

  /**
   * Records Pluggy's deletion of transactions as removed versions. Unknown ids
   * are ignored: Pluggy may delete transactions outside the copied window.
   */
  const removeTransactions = Effect.fn('OpenFinance.removeTransactions')(
    function* (
      providerAccountId: string,
      transactionIds: ReadonlyArray<string>,
    ) {
      // Under the sync lock, so an in-flight sync cannot write back what
      // Pluggy deleted while it was fetching.
      return yield* lockFor(providerAccountId).withPermits(1)(
        removeLocked(providerAccountId, transactionIds),
      )
    },
  )
  const removeLocked = Effect.fnUntraced(function* (
    providerAccountId: string,
    transactionIds: ReadonlyArray<string>,
  ) {
    // A deletion for an account that was never copied removes nothing.
    const found = yield* findProviderAccount(providerAccountId)
    if (Option.isNone(found)) {
      yield* Effect.logInfo(
        `No copied account for Pluggy account ${providerAccountId}; nothing to remove`,
      )
      return 0
    }
    const provider = found.value
    const owner = yield* connection(provider.connectionId)
    if (provider.accountId === null || owner.sourceId === null) return 0
    const sourceId = owner.sourceId
    const ids = new Set(transactionIds)
    const doomed = (yield* observations.current(provider.accountId)).filter(
      (observation) =>
        observation.sourceId === sourceId && ids.has(observation.externalId),
    )
    const accountId = provider.accountId
    const days = [
      ...new Set(doomed.map((observation) => observation.bookedOn)),
    ].sort()
    // The removal and the withdrawal of the checkpoints it falsifies land
    // together. A checkpoint inferred with the deleted line no longer holds
    // for its day; the next complete read of that day that infers the same
    // balance reinstates it.
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const result = yield* observations.recordTransactions({
          sourceId,
          accountId,
          transactions: doomed.map((observation) => ({
            externalId: observation.externalId,
            bookedOn: observation.bookedOn,
            amountCents: observation.amountCents,
            currency: observation.currency,
            description: observation.description,
            status: 'removed' as const,
            raw: { reason: 'deleted_by_provider' },
          })),
        })
        const first = days[0]
        const last = days[days.length - 1]
        if (first !== undefined && last !== undefined)
          yield* reconcileCheckpoints({
            accountId,
            sourceId,
            providerAccountId,
            currency: provider.currency,
            dateFrom: first,
            dateTo: addDays(last, 1),
            stored: doomed,
            reported: doomed,
            // No read of these days backs a closing balance.
            runningBalances: new Map(),
            only: new Set(days),
          })
        return result.recorded.length
      }),
    )
  })

  return {
    refreshTransactions,
    connectionByItem,
    adoptItem,
    markItemDeleted,
    itemDeleted,
    removeTransactions,
    createConnectToken,
    reconnectToken,
    registerItem,
    refreshConnection,
    linkAccount,
    unlinkAccount,
    syncAccount,
    requestSync,
    disconnect,
    connection,
    connections,
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
