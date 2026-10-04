import * as Context from 'effect/Context'
import * as DateTime from 'effect/DateTime'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Ref from 'effect/Ref'
import * as TestClock from 'effect/testing/TestClock'

import * as Reactor from '../events/Reactor.ts'
import { Accounts } from '../ledger/Accounts.ts'
import { OpenFinance } from '../openfinance/OpenFinance.ts'
import type {
  PluggyAccount,
  PluggyItem,
  PluggyTransaction,
} from '../openfinance/PluggyApi.ts'
import { PluggyClient, PluggyError } from '../openfinance/PluggyClient.ts'
import * as SyncReactor from '../openfinance/SyncReactor.ts'
import * as Webhook from '../openfinance/Webhook.ts'
import { WebhookConfig } from '../openfinance/WebhookConfig.ts'
import type { WebhookSettings } from '../openfinance/WebhookConfig.ts'
import { LedgerTest } from './layers.ts'

export interface FakePluggyData {
  readonly clientUserId: string
  readonly accounts: ReadonlyArray<PluggyAccount>
  readonly transactions: Readonly<
    Record<string, ReadonlyArray<PluggyTransaction>>
  >
  /** Calls the code made, for assertions. */
  readonly deleted: ReadonlyArray<string>
  readonly webhooks: ReadonlyArray<string>
  /** Pluggy's item status; UPDATED unless a test says otherwise. */
  readonly itemStatus?: string
  readonly statusDetail?: PluggyItem['statusDetail']
  /** Accounts of a given item; others list `accounts`. */
  readonly itemAccounts?: Readonly<Record<string, ReadonlyArray<PluggyAccount>>>
  /** Runs before Pluggy answers `getItem`, to hold responses back. */
  readonly beforeGetItem?: Effect.Effect<void>
  /** Runs after Pluggy produced the item, delaying its delivery. */
  readonly afterGetItem?: Effect.Effect<void>
  /** The item's top-level `lastUpdatedAt`. */
  readonly itemLastUpdatedAt?: string
  /** Pluggy removed the item on its side: every read answers 404. */
  readonly gone?: boolean
  /**
   * Holds transaction reads after their response is taken: `entered`
   * completes when a read is waiting, `release` lets it return.
   */
  readonly gate?: {
    readonly entered: Deferred.Deferred<void>
    readonly release: Deferred.Deferred<void>
  }
  readonly connectTokens: ReadonlyArray<{
    readonly clientUserId: string
    readonly webhookUrl?: string | undefined
  }>
}

/** The mutable Pluggy state behind the fake client. */
export class FakePluggyState extends Context.Service<
  FakePluggyState,
  Ref.Ref<FakePluggyData>
>()('@spendle/server/testing/FakePluggy/FakePluggyState') {}

export const bank: PluggyAccount = {
  id: 'provider-bank',
  type: 'BANK',
  name: 'Conta Corrente',
  number: '0001/12345-6',
  balance: 1000,
  currencyCode: 'BRL',
}

export const card: PluggyAccount = {
  id: 'provider-card',
  type: 'CREDIT',
  name: 'Ultravioleta',
  number: '5555 **** **** 1889',
  balance: 250,
  currencyCode: 'BRL',
}

export const tx = (
  id: string,
  date: string,
  fields: Partial<PluggyTransaction> = {},
): PluggyTransaction => ({
  id,
  accountId: 'provider-bank',
  date: `${date}T15:00:00.000Z`,
  description: id,
  type: 'DEBIT',
  amount: 10,
  currencyCode: 'BRL',
  ...fields,
})

const makeFake = (state: Ref.Ref<FakePluggyData>) =>
  PluggyClient.of({
    createConnectToken: (input) =>
      Ref.update(state, (current) => ({
        ...current,
        connectTokens: [
          ...current.connectTokens,
          { clientUserId: input.clientUserId, webhookUrl: input.webhookUrl },
        ],
      })).pipe(Effect.as('connect-token')),
    ensureWebhook: ({ url }) =>
      Ref.update(state, (current) => ({
        ...current,
        webhooks: [...current.webhooks, url],
      })),
    getItem: (itemId) =>
      Effect.gen(function* () {
        yield* (yield* Ref.get(state)).beforeGetItem ?? Effect.void
        const current = yield* Ref.get(state)
        // A deleted item is gone, as Pluggy answers 404 for it.
        if (current.deleted.includes(itemId)) {
          return yield* new PluggyError({
            operation: 'getItem',
            reason: 'not_found',
            status: 404,
          })
        }
        const item: PluggyItem = {
          id: itemId,
          status: current.itemStatus ?? 'UPDATED',
          clientUserId: current.clientUserId,
          connector: { id: 1, name: 'Nubank' },
          statusDetail: current.statusDetail,
          lastUpdatedAt: current.itemLastUpdatedAt,
        }
        yield* current.afterGetItem ?? Effect.void
        return item
      }),
    deleteItem: (itemId) =>
      Ref.update(state, (current) => ({
        ...current,
        deleted: [...current.deleted, itemId],
      })),
    listAccounts: (itemId) =>
      Effect.flatMap(Ref.get(state), (current) =>
        current.gone
          ? Effect.fail(
              new PluggyError({
                operation: 'listAccounts',
                reason: 'not_found',
                status: 404,
              }),
            )
          : Effect.succeed(current.itemAccounts?.[itemId] ?? current.accounts),
      ),
    listTransactions: (query) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(state)
        if (current.gone)
          return yield* new PluggyError({
            operation: 'listTransactions',
            reason: 'not_found',
            status: 404,
          })
        const all = current.transactions[query.accountId] ?? []
        const result =
          'ids' in query
            ? all.filter((transaction) => query.ids.includes(transaction.id))
            : // The fake does not model creation time: everything counts as new.
              'createdAtFrom' in query
              ? all
              : all.filter(
                  (transaction) =>
                    transaction.date.slice(0, 10) >= query.dateFrom &&
                    transaction.date.slice(0, 10) <= query.dateTo,
                )
        if (current.gate) {
          yield* Deferred.succeed(current.gate.entered, undefined)
          yield* Deferred.await(current.gate.release)
        }
        return result
      }),
  })

/** Open Finance over the in-memory ledger and a fake Pluggy, without reactors: tests drive the work. */
export const openFinanceManualTest = (
  webhook: Option.Option<WebhookSettings> = Option.none(),
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const state = yield* Ref.make<FakePluggyData>({
        clientUserId: '',
        accounts: [],
        transactions: {},
        deleted: [],
        webhooks: [],
        connectTokens: [],
      })
      return OpenFinance.layer.pipe(
        Layer.provideMerge(Reactor.Reactors.layer),
        Layer.provideMerge(Layer.succeed(PluggyClient, makeFake(state))),
        Layer.provideMerge(Layer.succeed(FakePluggyState, state)),
        Layer.provideMerge(WebhookConfig.layerTest(webhook)),
        Layer.provideMerge(LedgerTest),
      )
    }),
  )

/** Open Finance over the in-memory ledger, a fake Pluggy, and the sync and webhook reactors. */
export const openFinanceTest = (
  webhook: Option.Option<WebhookSettings> = Option.none(),
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const state = yield* Ref.make<FakePluggyData>({
        clientUserId: '',
        accounts: [],
        transactions: {},
        deleted: [],
        webhooks: [],
        connectTokens: [],
      })
      return Layer.mergeAll(SyncReactor.layer, Webhook.reactor).pipe(
        Layer.provideMerge(OpenFinance.layer),
        Layer.provideMerge(Reactor.Reactors.layer),
        Layer.provideMerge(Layer.succeed(PluggyClient, makeFake(state))),
        Layer.provideMerge(Layer.succeed(FakePluggyState, state)),
        Layer.provideMerge(WebhookConfig.layerTest(webhook)),
        Layer.provideMerge(LedgerTest),
      )
    }),
  )

/** Connects item `item-1` with the given Pluggy data, as the widget flow would, on 2026-10-04. */
export const connect = (
  data: Pick<
    FakePluggyData,
    | 'accounts'
    | 'transactions'
    | 'statusDetail'
    | 'itemAccounts'
    | 'itemLastUpdatedAt'
  >,
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(
      DateTime.toEpochMillis(DateTime.makeUnsafe('2026-10-04T15:00:00Z')),
    )
    const openFinance = yield* OpenFinance
    const owner = yield* (yield* Accounts).createOwner({
      name: 'Donald',
      kind: 'person',
    })
    const { connectionId } = yield* openFinance.createConnectToken({
      ownerId: owner.id,
    })
    const state = yield* FakePluggyState
    yield* Ref.update(state, (current) => ({
      ...current,
      ...data,
      clientUserId: connectionId,
    }))
    yield* openFinance.registerItem({ connectionId, itemId: 'item-1' })
    return { openFinance, connectionId, state }
  })

export const drain = Effect.gen(function* () {
  yield* (yield* Reactor.Reactors).drain
})
