import * as Context from 'effect/Context'
import * as Crypto from 'effect/Crypto'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'

import { max } from '../domain/LocalDate.ts'
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
  toMinorUnits,
  toReportedTransaction,
} from './Normalize.ts'
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
      yield* sql`
          UPDATE open_finance_connections SET item_id = ${item.id}, source_id = ${source.id},
            connector_name = ${item.connector.name}, status = ${connectionStatusOf(item)},
            provider_status = ${item.status}, error_code = ${item.error?.code ?? null},
            updated_at = ${yield* now}
          WHERE id = ${current.id}
        `
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
    const item = yield* pluggy.getItem(input.itemId)
    // The widget reports the item id from the browser; only an item created
    // with this connection's clientUserId may attach to it.
    if (item.clientUserId !== current.id)
      return yield* fail('item_belongs_elsewhere')
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

  const syncAccount = Effect.fn('OpenFinance.syncAccount')(function* (
    providerAccountId: string,
  ) {
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
    const dateFrom =
      latest === null
        ? historyFrom
        : max(historyFrom, continuationStart(latest))
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
    let skipped = 0
    for (const transaction of fetched) {
      const normalized = toReportedTransaction(item, transaction)
      if (Option.isNone(normalized)) skipped++
      else if (normalized.value.bookedOn >= historyFrom)
        reported.push(normalized.value)
    }

    // A pending transaction Pluggy stops reporting was replaced or dropped
    // by the bank. Posted ones are never inferred removed from absence: a
    // partial response must not erase facts.
    const seen = new Set(reported.map((transaction) => transaction.externalId))
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
    if (item.type === 'BANK') {
      yield* observations.recordBalance({
        sourceId,
        accountId,
        balance: {
          kind: 'booked',
          asOf: dateTo,
          balanceCents: toMinorUnits(item.balance, item.currencyCode),
          currency: item.currencyCode,
        },
      })
    }
    const summary: SyncResult = {
      recorded: result.recorded.length - vanished.length,
      unchanged: result.unchanged,
      removed: vanished.length,
      skipped,
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
  }
})

export class OpenFinance extends Context.Service<
  OpenFinance,
  Effect.Success<typeof make>
>()('@spendle/server/openfinance/OpenFinance') {
  static readonly layer = Layer.effect(OpenFinance, make)
}
