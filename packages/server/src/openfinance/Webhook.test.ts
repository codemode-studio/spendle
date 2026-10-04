import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer'
import { assert, describe, it } from '@effect/vitest'
import * as DateTime from 'effect/DateTime'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as Ref from 'effect/Ref'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/sql/SqlClient'
import * as Stream from 'effect/Stream'
import * as Layer from 'effect/Layer'
import * as TestClock from 'effect/testing/TestClock'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import * as HttpRouter from 'effect/http/HttpRouter'
import * as HttpServer from 'effect/http/HttpServer'

import { EventLog } from '../events/EventLog.ts'
import { Accounts } from '../ledger/Accounts.ts'
import { Observations } from '../ledger/Observations.ts'
import {
  bank,
  connect,
  drain,
  FakePluggyState,
  openFinanceTest,
  tx,
} from '../testing/FakePluggy.ts'
import { OpenFinance, OpenFinanceError } from './OpenFinance.ts'
import { acceptWebhook, routes, webhookReceived } from './Webhook.ts'

const secret = 'whsec-0123456789abcdef0123456789abcdef'
const settings = Option.some({
  url: 'https://spendle.example/api/pluggy/webhook',
  secret: Redacted.make(secret),
})

const deliver = (body: unknown, authorization = `Bearer ${secret}`) =>
  acceptWebhook({ authorization, body: JSON.stringify(body) })

// Connects a linked bank account whose first sync has run.
const linkedBank = (transactions: Parameters<typeof tx>[] = []) =>
  Effect.gen(function* () {
    const connected = yield* connect({
      accounts: [bank],
      transactions: {
        'provider-bank': transactions.map((args) => tx(...args)),
      },
    })
    const account = yield* connected.openFinance.linkAccount({
      providerAccountId: 'provider-bank',
      target: { kind: 'checking', purpose: 'operating' },
      historyMonths: 3,
    })
    yield* drain
    return { ...connected, account }
  })

// The reason of an Open Finance failure, or the failure itself.
const reasonOf = (error: unknown) =>
  Schema.is(OpenFinanceError)(error) ? error.reason : error

const currentIds = (accountId: string) =>
  Effect.gen(function* () {
    const current = yield* (yield* Observations).current(accountId)
    return current.map((observation) => observation.externalId)
  })

describe('acceptWebhook', () => {
  it.effect(
    'stores an authenticated event once, however often Pluggy retries it',
    () =>
      Effect.gen(function* () {
        const event = {
          eventId: 'evt-1',
          event: 'item/updated',
          itemId: 'item-1',
        }
        const first = yield* deliver(event)
        const retry = yield* deliver(event)

        assert.deepStrictEqual(
          [first.status, first.body, retry.body],
          [
            202,
            { accepted: true, duplicate: false },
            { accepted: true, duplicate: true },
          ],
        )
        const stored = (yield* (yield* EventLog).readAfter(0, 10)).filter(
          (stored) => stored.type === webhookReceived,
        )
        assert.strictEqual(stored.length, 1)
      }).pipe(Effect.provide(openFinanceTest(settings))),
  )

  it.effect(
    'rejects a wrong secret, a malformed event and deliveries while disabled',
    () =>
      Effect.gen(function* () {
        const event = {
          eventId: 'evt-1',
          event: 'item/updated',
          itemId: 'item-1',
        }
        assert.strictEqual((yield* deliver(event, 'Bearer guess')).status, 401)
        assert.strictEqual(
          (yield* deliver({ event: 'item/updated' })).status,
          400,
        )
        assert.strictEqual(
          (yield* acceptWebhook({
            authorization: undefined,
            body: 'x'.repeat(70_000),
          })).status,
          401,
        )
        assert.strictEqual(yield* (yield* EventLog).latestSequence, 0)
      }).pipe(Effect.provide(openFinanceTest(settings))),
  )

  it.effect('answers 503 when webhooks are not configured', () =>
    Effect.gen(function* () {
      const result = yield* deliver({
        eventId: 'evt-1',
        event: 'item/updated',
        itemId: 'item-1',
      })
      assert.strictEqual(result.status, 503)
    }).pipe(Effect.provide(openFinanceTest())),
  )
})

describe('webhook reactions', () => {
  it.effect('passes the webhook URL when creating a connect token', () =>
    Effect.gen(function* () {
      yield* connect({ accounts: [], transactions: {} })
      const tokens = (yield* Ref.get(yield* FakePluggyState)).connectTokens
      assert.strictEqual(
        tokens[0]?.webhookUrl,
        'https://spendle.example/api/pluggy/webhook',
      )
    }).pipe(Effect.provide(openFinanceTest(settings))),
  )

  it.effect('syncs the account named in transactions/created', () =>
    Effect.gen(function* () {
      const { account, state } = yield* linkedBank([['market', '2026-09-28']])
      yield* Ref.update(state, (current) => ({
        ...current,
        transactions: {
          'provider-bank': [
            tx('market', '2026-09-28'),
            tx('pharmacy', '2026-10-04'),
          ],
        },
      }))

      yield* deliver({
        eventId: 'evt-2',
        event: 'transactions/created',
        itemId: 'item-1',
        accountId: 'provider-bank',
      })
      yield* drain

      assert.deepStrictEqual(yield* currentIds(account.id), [
        'market',
        'pharmacy',
      ])
    }).pipe(Effect.provide(openFinanceTest(settings))),
  )

  it.effect('removes the transactions listed in transactions/deleted', () =>
    Effect.gen(function* () {
      const { account } = yield* linkedBank([
        ['market', '2026-09-28'],
        ['duplicate', '2026-09-28'],
      ])

      yield* deliver({
        eventId: 'evt-3',
        event: 'transactions/deleted',
        itemId: 'item-1',
        accountId: 'provider-bank',
        transactionIds: ['duplicate', 'never-copied'],
      })
      yield* drain

      assert.deepStrictEqual(yield* currentIds(account.id), ['market'])
    }).pipe(Effect.provide(openFinanceTest(settings))),
  )

  // A connect token whose widget callback never reached the server.
  const pendingConnection = Effect.gen(function* () {
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
    return { openFinance, connectionId, state: yield* FakePluggyState }
  })

  it.effect(
    'attaches the item of item/created to the connection that created it',
    () =>
      Effect.gen(function* () {
        const { openFinance, connectionId, state } = yield* pendingConnection
        yield* Ref.update(state, (current) => ({
          ...current,
          clientUserId: connectionId,
          accounts: [bank],
        }))
        yield* deliver({
          eventId: 'evt-created',
          event: 'item/created',
          itemId: 'item-1',
        })
        yield* drain
        const connection = yield* openFinance.connection(connectionId)
        assert.deepStrictEqual(
          [connection.itemId, connection.status],
          ['item-1', 'active'],
        )
        assert.deepStrictEqual(
          (yield* openFinance.providerAccounts(connectionId)).map(
            (account) => account.providerAccountId,
          ),
          ['provider-bank'],
        )
      }).pipe(Effect.provide(openFinanceTest(settings))),
  )

  it.effect(
    'leaves pending connections alone for items created by someone else or gone',
    () =>
      Effect.gen(function* () {
        const { openFinance, connectionId, state } = yield* pendingConnection
        yield* Ref.update(state, (current) => ({
          ...current,
          clientUserId: 'someone-else',
          accounts: [bank],
          deleted: ['item-gone'],
        }))
        yield* deliver({
          eventId: 'evt-foreign',
          event: 'item/created',
          itemId: 'item-1',
        })
        yield* deliver({
          eventId: 'evt-gone',
          event: 'item/updated',
          itemId: 'item-gone',
        })
        yield* drain
        const connection = yield* openFinance.connection(connectionId)
        assert.deepStrictEqual(
          [connection.itemId, connection.status],
          [null, 'pending'],
        )
      }).pipe(Effect.provide(openFinanceTest(settings))),
  )

  it.effect(
    'does not attach an item deleted while its registration waited on Pluggy',
    () =>
      Effect.gen(function* () {
        const { openFinance, connectionId, state } = yield* pendingConnection
        // Pluggy has produced the item, but it reaches the registration only
        // after item/deleted was processed.
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        yield* Ref.update(state, (current) => ({
          ...current,
          clientUserId: connectionId,
          accounts: [bank],
          afterGetItem: Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
          ),
        }))
        const registration = yield* Effect.forkChild(
          openFinance.registerItem({ connectionId, itemId: 'item-1' }),
        )
        yield* Deferred.await(entered)
        yield* deliver({
          eventId: 'evt-gone',
          event: 'item/deleted',
          itemId: 'item-1',
        })
        yield* drain
        yield* Deferred.succeed(release, undefined)
        const failure = yield* Effect.flip(Fiber.join(registration))
        const connection = yield* openFinance.connection(connectionId)
        assert.deepStrictEqual(
          {
            failure: reasonOf(failure),
            itemId: connection.itemId,
            status: connection.status,
            accounts: yield* openFinance.providerAccounts(connectionId),
          },
          {
            failure: 'item_deleted',
            itemId: null,
            status: 'pending',
            accounts: [],
          },
        )
      }).pipe(Effect.provide(openFinanceTest(settings))),
  )

  it.effect('ignores events for items it does not know', () =>
    Effect.gen(function* () {
      yield* deliver({
        eventId: 'evt-5',
        event: 'item/updated',
        itemId: 'someone-elses-item',
      })
      yield* drain
    }).pipe(Effect.provide(openFinanceTest(settings))),
  )

  it.effect(
    'reads exactly the transactions Pluggy says changed, however old',
    () =>
      Effect.gen(function* () {
        const { account, state } = yield* linkedBank([
          ['old', '2026-08-15'],
          ['recent', '2026-10-03'],
        ])
        // 15 August is far outside the regular sync's overlap.
        yield* Ref.update(state, (current) => ({
          ...current,
          transactions: {
            'provider-bank': [
              tx('old', '2026-08-15', { amount: 99 }),
              tx('recent', '2026-10-03'),
              tx('late-arrival', '2026-08-20'),
            ],
          },
        }))
        yield* deliver({
          eventId: 'evt-upd',
          event: 'transactions/updated',
          itemId: 'item-1',
          accountId: 'provider-bank',
          transactionIds: ['old'],
        })
        yield* deliver({
          eventId: 'evt-new',
          event: 'transactions/created',
          itemId: 'item-1',
          accountId: 'provider-bank',
          transactionsCreatedAtFrom: '2026-10-04T10:00:00.000Z',
        })
        yield* drain
        const current = yield* (yield* Observations).current(account.id)
        assert.deepStrictEqual(
          current.map((observation) => [
            observation.externalId,
            observation.amountCents,
          ]),
          [
            ['old', -9900],
            ['late-arrival', -1000],
            ['recent', -1000],
          ],
        )
      }).pipe(Effect.provide(openFinanceTest(settings))),
  )

  it.effect(
    'judges again the checkpoints of the days an old changed transaction touched',
    () =>
      Effect.gen(function* () {
        const { openFinance, account, state } = yield* linkedBank([
          [
            'salary',
            '2026-08-14',
            { type: 'CREDIT', amount: 1000, balance: 1000 },
          ],
          ['market', '2026-08-15', { amount: 100, balance: 900 }],
          ['fee', '2026-08-20', { amount: 50, balance: 850 }],
        ])
        // The market purchase was R$150; the fee was booked a day later.
        yield* Ref.update(state, (current) => ({
          ...current,
          transactions: {
            'provider-bank': [
              tx('salary', '2026-08-14', {
                type: 'CREDIT',
                amount: 1000,
                balance: 1000,
              }),
              tx('market', '2026-08-15', { amount: 150, balance: 850 }),
              tx('fee', '2026-08-21', { amount: 50, balance: 800 }),
            ],
          },
        }))
        yield* deliver({
          eventId: 'evt-upd',
          event: 'transactions/updated',
          itemId: 'item-1',
          accountId: 'provider-bank',
          transactionIds: ['market', 'fee'],
        })
        yield* drain
        const sql = yield* SqlClient.SqlClient
        const booked = yield* sql<{ asOf: string; balanceCents: number }>`
          SELECT as_of AS asOf, balance_cents AS balanceCents FROM balance_observations
          WHERE account_id = ${account.id} AND kind = 'booked' ORDER BY as_of, rowid
        `
        assert.deepStrictEqual(
          {
            booked: booked.map((row) => [row.asOf, row.balanceCents]),
            invalidated: (yield* openFinance.invalidatedCheckpoints(
              account.id,
            )).map((checkpoint) => checkpoint.asOf),
          },
          {
            booked: [
              ['2026-08-14', 100000],
              ['2026-08-15', 90000],
              ['2026-08-15', 85000],
              ['2026-08-20', 85000],
              ['2026-08-21', 80000],
            ],
            invalidated: ['2026-08-20'],
          },
        )
      }).pipe(Effect.provide(openFinanceTest(settings))),
  )

  it.effect(
    'infers no checkpoint for a changed day holding a line it never copied',
    () =>
      Effect.gen(function* () {
        const { openFinance, account, state } = yield* linkedBank([
          [
            'salary',
            '2026-08-14',
            { type: 'CREDIT', amount: 1000, balance: 1000 },
          ],
          ['market', '2026-08-15', { amount: 100, balance: 900 }],
        ])
        // Pluggy also has a fee on that day that was never copied: the day
        // closed at R$830, not at the R$850 the market line alone suggests.
        yield* Ref.update(state, (current) => ({
          ...current,
          transactions: {
            'provider-bank': [
              tx('salary', '2026-08-14', {
                type: 'CREDIT',
                amount: 1000,
                balance: 1000,
              }),
              tx('market', '2026-08-15', { amount: 150, balance: 850 }),
              tx('fee', '2026-08-15', { amount: 20, balance: 830 }),
            ],
          },
        }))
        yield* deliver({
          eventId: 'evt-upd',
          event: 'transactions/updated',
          itemId: 'item-1',
          accountId: 'provider-bank',
          transactionIds: ['market'],
        })
        yield* drain
        const sql = yield* SqlClient.SqlClient
        const booked = yield* sql<{ asOf: string; balanceCents: number }>`
          SELECT as_of AS asOf, balance_cents AS balanceCents FROM balance_observations
          WHERE account_id = ${account.id} AND kind = 'booked' ORDER BY as_of, rowid
        `
        assert.deepStrictEqual(
          {
            booked: booked.map((row) => [row.asOf, row.balanceCents]),
            invalidated: (yield* openFinance.invalidatedCheckpoints(
              account.id,
            )).map((checkpoint) => checkpoint.asOf),
          },
          {
            booked: [
              ['2026-08-14', 100000],
              ['2026-08-15', 90000],
            ],
            invalidated: ['2026-08-15'],
          },
        )
      }).pipe(Effect.provide(openFinanceTest(settings))),
  )

  it.effect(
    'keeps processing after a deletion for an account it never copied',
    () =>
      Effect.gen(function* () {
        const { openFinance, connectionId } = yield* linkedBank()
        yield* deliver({
          eventId: 'evt-del',
          event: 'transactions/deleted',
          itemId: 'item-1',
          accountId: 'provider-unknown',
          transactionIds: ['x'],
        })
        yield* deliver({
          eventId: 'evt-gone',
          event: 'item/deleted',
          itemId: 'item-1',
        })
        yield* drain
        assert.strictEqual(
          (yield* openFinance.connection(connectionId)).status,
          'disconnected',
        )
      }).pipe(Effect.provide(openFinanceTest(settings))),
  )

  it.effect('drops a refresh Pluggy can no longer answer and keeps going', () =>
    Effect.gen(function* () {
      const { openFinance, connectionId, state } = yield* linkedBank([
        ['market', '2026-09-28'],
      ])
      yield* Ref.update(state, (current) => ({ ...current, gone: true }))
      yield* deliver({
        eventId: 'evt-stale',
        event: 'transactions/updated',
        itemId: 'item-1',
        accountId: 'provider-bank',
        transactionIds: ['market'],
      })
      yield* deliver({
        eventId: 'evt-after',
        event: 'item/deleted',
        itemId: 'item-1',
      })
      yield* drain
      assert.strictEqual(
        (yield* openFinance.connection(connectionId)).status,
        'disconnected',
      )
    }).pipe(Effect.provide(openFinanceTest(settings))),
  )

  it.effect(
    'marks a vanished item disconnected without deleting it at Pluggy',
    () =>
      Effect.gen(function* () {
        const { openFinance, connectionId, state } = yield* linkedBank([
          ['market', '2026-09-28'],
        ])
        // Deleting at Pluggy would fail for good (credentials revoked).
        yield* Ref.update(state, (current) => ({
          ...current,
          gone: true,
          deleteRefused: 'unauthorized' as const,
        }))
        yield* deliver({
          eventId: 'evt-stale',
          event: 'transactions/updated',
          itemId: 'item-1',
          accountId: 'provider-bank',
          transactionIds: ['market'],
        })
        yield* deliver({
          eventId: 'evt-after',
          event: 'item/deleted',
          itemId: 'item-1',
        })
        yield* drain
        assert.strictEqual(
          (yield* openFinance.connection(connectionId)).status,
          'disconnected',
        )
      }).pipe(Effect.provide(openFinanceTest(settings))),
  )

  it.effect(
    'marks a vanished item disconnected from a queued sync without deleting it at Pluggy',
    () =>
      Effect.gen(function* () {
        const { openFinance, connectionId, state } = yield* linkedBank([
          ['market', '2026-09-28'],
        ])
        yield* Ref.update(state, (current) => ({
          ...current,
          gone: true,
          deleteRefused: 'unauthorized' as const,
        }))
        yield* openFinance.requestSync({ connectionId })
        yield* drain
        assert.strictEqual(
          (yield* openFinance.connection(connectionId)).status,
          'disconnected',
        )
      }).pipe(Effect.provide(openFinanceTest(settings))),
  )

  it.effect(
    'keeps item/deleted over a refresh whose item Pluggy sent before it',
    () =>
      Effect.gen(function* () {
        const { openFinance, connectionId, account, state } = yield* linkedBank(
          [['market', '2026-09-28']],
        )
        yield* Ref.update(state, (current) => ({
          ...current,
          transactions: {
            'provider-bank': [
              tx('market', '2026-09-28'),
              tx('pharmacy', '2026-10-04'),
            ],
          },
        }))
        // Each read takes Pluggy's UPDATED item, then waits until item/deleted
        // was processed.
        const held = <A, E>(read: Effect.Effect<A, E>) =>
          Effect.gen(function* () {
            const entered = yield* Deferred.make<void>()
            const release = yield* Deferred.make<void>()
            yield* Ref.update(state, (current) => ({
              ...current,
              afterGetItem: Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
              ),
            }))
            const fiber = yield* Effect.forkChild(read)
            yield* Deferred.await(entered)
            return { fiber, release }
          })
        const refresh = yield* held(openFinance.refreshConnection(connectionId))
        const sync = yield* held(openFinance.syncAccount('provider-bank'))
        yield* deliver({
          eventId: 'evt-gone',
          event: 'item/deleted',
          itemId: 'item-1',
        })
        yield* drain
        yield* Deferred.succeed(refresh.release, undefined)
        yield* Deferred.succeed(sync.release, undefined)
        const failures = [
          yield* Effect.flip(Fiber.join(refresh.fiber)),
          yield* Effect.flip(Fiber.join(sync.fiber)),
        ]
        assert.deepStrictEqual(failures.map(reasonOf), [
          'connection_disconnected',
          'connection_disconnected',
        ])
        assert.strictEqual(
          (yield* openFinance.connection(connectionId)).status,
          'disconnected',
        )
        assert.deepStrictEqual(yield* currentIds(account.id), ['market'])
      }).pipe(Effect.provide(openFinanceTest(settings))),
  )

  // Holds `read` after Pluggy answered with a new transaction, processes
  // item/deleted, then lets it finish: it must fail and record nothing.
  const readAcrossDeletion = <A, E>(
    read: (
      openFinance: Effect.Success<ReturnType<typeof linkedBank>>['openFinance'],
    ) => Effect.Effect<A, E>,
  ) =>
    Effect.gen(function* () {
      const { openFinance, connectionId, account, state } = yield* linkedBank([
        ['market', '2026-09-28'],
      ])
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* Ref.update(state, (current) => ({
        ...current,
        transactions: {
          'provider-bank': [
            tx('market', '2026-09-28'),
            tx('pharmacy', '2026-10-04'),
          ],
        },
        gate: { entered, release },
      }))
      const fiber = yield* Effect.forkChild(read(openFinance))
      yield* Deferred.await(entered)
      yield* deliver({
        eventId: 'evt-gone',
        event: 'item/deleted',
        itemId: 'item-1',
      })
      yield* drain
      yield* Deferred.succeed(release, undefined)
      const failure = yield* Effect.flip(Fiber.join(fiber))
      assert.strictEqual(reasonOf(failure), 'connection_disconnected')
      assert.strictEqual(
        (yield* openFinance.connection(connectionId)).status,
        'disconnected',
      )
      assert.deepStrictEqual(yield* currentIds(account.id), ['market'])
    }).pipe(Effect.provide(openFinanceTest(settings)))

  it.effect(
    'writes nothing from a sync Pluggy answered before item/deleted',
    () =>
      readAcrossDeletion((openFinance) =>
        openFinance.syncAccount('provider-bank'),
      ),
  )

  it.effect(
    'writes nothing from changed transactions Pluggy sent before item/deleted',
    () =>
      readAcrossDeletion((openFinance) =>
        openFinance.refreshTransactions('provider-bank', { ids: ['pharmacy'] }),
      ),
  )

  it.effect('keeps a deletion that arrives while a sync is fetching', () =>
    Effect.gen(function* () {
      const { openFinance, account, state } = yield* linkedBank([
        ['market', '2026-09-28'],
      ])
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* Ref.update(state, (current) => ({
        ...current,
        gate: { entered, release },
      }))
      // The sync takes Pluggy's answer, which still lists the transaction.
      const sync = yield* Effect.forkChild(
        openFinance.syncAccount('provider-bank'),
      )
      yield* Deferred.await(entered)
      const removal = yield* Effect.forkChild(
        openFinance.removeTransactions('provider-bank', ['market']),
      )
      // Let the removal run as far as it can: to the end without the lock,
      // or until it waits for the sync with it.
      for (let turn = 0; turn < 100; turn++) {
        if (removal.pollUnsafe() !== undefined) break
        yield* Effect.yieldNow
      }
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(sync)
      yield* Fiber.join(removal)
      assert.deepStrictEqual(yield* currentIds(account.id), [])
    }).pipe(Effect.provide(openFinanceTest(settings))),
  )

  it.effect('accepts events whose error has no code', () =>
    Effect.gen(function* () {
      const result = yield* deliver({
        eventId: 'evt-payment',
        event: 'scheduled_payment/error',
        error: { title: 'Falhou', description: 'Saldo insuficiente' },
      })
      assert.strictEqual(result.status, 202)
      yield* drain
    }).pipe(Effect.provide(openFinanceTest(settings))),
  )

  it.effect('accepts connector events, which carry no item', () =>
    Effect.gen(function* () {
      const result = yield* deliver({
        eventId: 'evt-conn',
        event: 'connector/status_updated',
        data: { connectorId: 1, status: 'UNSTABLE' },
      })
      assert.strictEqual(result.status, 202)
      yield* drain
    }).pipe(Effect.provide(openFinanceTest(settings))),
  )

  // The booked checkpoints of an account, in recording order, and the days
  // whose checkpoint is withdrawn.
  const checkpointsOf = (accountId: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const booked = yield* sql<{ asOf: string; balanceCents: number }>`
        SELECT as_of AS asOf, balance_cents AS balanceCents FROM balance_observations
        WHERE account_id = ${accountId} AND kind = 'booked' ORDER BY as_of, rowid
      `
      return {
        booked: booked.map((row) => [row.asOf, row.balanceCents]),
        invalidated: (yield* (yield* OpenFinance).invalidatedCheckpoints(
          accountId,
        )).map((checkpoint) => checkpoint.asOf),
      }
    })

  it.effect(
    'withdraws the old day of a correction without a converted amount until it converts',
    () =>
      Effect.gen(function* () {
        const salary = tx('salary', '2026-08-14', {
          type: 'CREDIT',
          amount: 1000,
          balance: 1000,
        })
        const { account, state } = yield* linkedBank([
          [
            'salary',
            '2026-08-14',
            { type: 'CREDIT', amount: 1000, balance: 1000 },
          ],
          ['market', '2026-08-15', { amount: 100, balance: 900 }],
        ])
        // Pluggy corrects the purchase to Aug 16 in dollars, not yet converted.
        const setMarket = (market: ReturnType<typeof tx>) =>
          Ref.update(state, (current) => ({
            ...current,
            transactions: { 'provider-bank': [salary, market] },
          }))
        yield* setMarket(
          tx('market', '2026-08-16', {
            currencyCode: 'USD',
            amount: 30,
            amountInAccountCurrency: null,
            balance: null,
          }),
        )
        yield* deliver({
          eventId: 'evt-unconverted',
          event: 'transactions/updated',
          itemId: 'item-1',
          accountId: 'provider-bank',
          transactionIds: ['market'],
        })
        yield* drain
        const sql = yield* SqlClient.SqlClient
        const unresolvedOf = sql<{ id: string; bookedOn: string }>`
          SELECT provider_transaction_id AS id, booked_on AS bookedOn
          FROM open_finance_unresolved ORDER BY id
        `
        const factsOf = Effect.map(
          (yield* Observations).current(account.id),
          (current) =>
            current.map((observation) => [
              observation.externalId,
              observation.bookedOn,
              observation.amountCents,
            ]),
        )
        assert.deepStrictEqual(
          {
            facts: yield* factsOf,
            unresolved: [...(yield* unresolvedOf)],
            ...(yield* checkpointsOf(account.id)),
          },
          {
            facts: [
              ['salary', '2026-08-14', 100000],
              ['market', '2026-08-15', -10000],
            ],
            unresolved: [{ id: 'market', bookedOn: '2026-08-16' }],
            booked: [
              ['2026-08-14', 100000],
              ['2026-08-15', 90000],
            ],
            invalidated: ['2026-08-15'],
          },
        )

        // Pluggy converts it: R$150. A foreign line carries no running
        // balance in the account currency, so Aug 16 gets no checkpoint.
        yield* setMarket(
          tx('market', '2026-08-16', {
            currencyCode: 'USD',
            amount: 30,
            amountInAccountCurrency: 150,
            balance: 850,
          }),
        )
        yield* deliver({
          eventId: 'evt-converted',
          event: 'transactions/updated',
          itemId: 'item-1',
          accountId: 'provider-bank',
          transactionIds: ['market'],
        })
        yield* drain
        assert.deepStrictEqual(
          {
            facts: yield* factsOf,
            unresolved: [...(yield* unresolvedOf)],
            ...(yield* checkpointsOf(account.id)),
          },
          {
            facts: [
              ['salary', '2026-08-14', 100000],
              ['market', '2026-08-16', -15000],
            ],
            unresolved: [],
            booked: [
              ['2026-08-14', 100000],
              ['2026-08-15', 90000],
            ],
            invalidated: ['2026-08-15'],
          },
        )
      }).pipe(Effect.provide(openFinanceTest(settings))),
  )

  it.effect(
    'withdraws the checkpoint of a day whose transaction Pluggy deleted',
    () =>
      Effect.gen(function* () {
        const { openFinance, account, connectionId, state } = yield* linkedBank(
          [
            [
              'salary',
              '2026-08-14',
              { type: 'CREDIT', amount: 1000, balance: 1000 },
            ],
            ['market', '2026-08-15', { amount: 100, balance: 900 }],
            ['recent', '2026-10-03'],
          ],
        )
        yield* Ref.update(state, (current) => ({
          ...current,
          transactions: {
            'provider-bank': (
              current.transactions['provider-bank'] ?? []
            ).filter((transaction) => transaction.id !== 'market'),
          },
        }))
        yield* deliver({
          eventId: 'evt-del',
          event: 'transactions/deleted',
          itemId: 'item-1',
          accountId: 'provider-bank',
          transactionIds: ['market'],
        })
        yield* drain
        // A later incremental sync does not bring it back.
        yield* openFinance.requestSync({ connectionId })
        yield* drain
        assert.deepStrictEqual(
          {
            ids: yield* currentIds(account.id),
            ...(yield* checkpointsOf(account.id)),
          },
          {
            ids: ['salary', 'recent'],
            booked: [
              ['2026-08-14', 100000],
              ['2026-08-15', 90000],
            ],
            invalidated: ['2026-08-15'],
          },
        )
      }).pipe(Effect.provide(openFinanceTest(settings))),
  )

  // After Pluggy removed item-1, the person connects the same bank again as
  // item-2 and links its account to the ledger account they already had.
  const relinkAfter = <A, E, R>(
    removeItem: (
      openFinance: OpenFinance['Service'],
      connectionId: string,
    ) => Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const { openFinance, account, connectionId, state } = yield* linkedBank([
        ['market', '2026-09-28'],
      ])
      yield* removeItem(openFinance, connectionId)
      yield* drain
      const owner = (yield* openFinance.connection(connectionId)).ownerId
      const replacement = yield* openFinance.createConnectToken({
        ownerId: owner,
      })
      yield* Ref.update(state, (current) => ({
        ...current,
        gone: false,
        clientUserId: replacement.connectionId,
        accounts: [{ ...bank, id: 'provider-bank-2' }],
      }))
      yield* openFinance.registerItem({
        connectionId: replacement.connectionId,
        itemId: 'item-2',
      })
      const relinked = yield* openFinance.linkAccount({
        providerAccountId: 'provider-bank-2',
        target: { accountId: account.id },
        historyMonths: 3,
      })
      assert.deepStrictEqual(
        {
          relinked: relinked.id,
          previous: (yield* openFinance.providerAccounts(connectionId)).map(
            (provider) => provider.accountId,
          ),
        },
        { relinked: account.id, previous: [account.id] },
      )
    })

  it.effect('frees the ledger account of an item Pluggy deleted', () =>
    relinkAfter(() =>
      deliver({
        eventId: 'evt-gone',
        event: 'item/deleted',
        itemId: 'item-1',
      }),
    ).pipe(Effect.provide(openFinanceTest(settings))),
  )

  it.effect('frees the ledger account of an item Pluggy no longer has', () =>
    relinkAfter((openFinance, connectionId) =>
      Effect.gen(function* () {
        const state = yield* FakePluggyState
        yield* Ref.update(state, (current) => ({ ...current, gone: true }))
        yield* openFinance.requestSync({ connectionId })
      }),
    ).pipe(Effect.provide(openFinanceTest(settings))),
  )
})

describe('webhook route', () => {
  // Serves the route in memory with the test services behind it.
  const withRoute = <A, E>(
    use: (
      fetch: (request: Request) => Promise<Response>,
    ) => Effect.Effect<A, E>,
  ) =>
    Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          routes.pipe(
            Layer.provideMerge(openFinanceTest(settings)),
            Layer.provideMerge(HttpServer.layerServices),
          ),
        ),
      ),
      ({ dispose }) => Effect.promise(dispose),
    ).pipe(
      Effect.flatMap(({ handler }) => use((request) => handler(request))),
      Effect.scoped,
    )

  it.live('rejects an unauthenticated caller without reading its body', () =>
    withRoute((fetch) => {
      let pulled = false
      // With no buffer, the stream is pulled only when someone reads it.
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulled = true
            controller.close()
          },
        },
        { highWaterMark: 0 },
      )
      return Effect.promise(() =>
        fetch(
          new Request('http://spendle.test/api/pluggy/webhook', {
            method: 'POST',
            headers: { authorization: 'Bearer guess' },
            body,
            duplex: 'half',
          } as RequestInit),
        ),
      ).pipe(
        Effect.map((response) =>
          assert.deepStrictEqual([response.status, pulled], [401, false]),
        ),
      )
    }),
  )

  it.live('stops reading a streamed body past the limit', () =>
    withRoute((fetch) => {
      const chunk = new TextEncoder().encode('x'.repeat(16 * 1024))
      let sent = 0
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          sent++
          if (sent > 20) controller.close()
          else controller.enqueue(chunk)
        },
      })
      return Effect.promise(() =>
        fetch(
          new Request('http://spendle.test/api/pluggy/webhook', {
            method: 'POST',
            headers: { authorization: `Bearer ${secret}` },
            body,
            duplex: 'half',
          } as RequestInit),
        ),
      ).pipe(Effect.map((response) => assert.strictEqual(response.status, 413)))
    }),
  )

  it.live(
    'answers 413 over a real connection to a chunked body past the drain cap',
    () =>
      Effect.gen(function* () {
        const chunk = new TextEncoder().encode('x'.repeat(16 * 1024))
        // 2 MiB, twice the amount the route reads before giving up.
        const response = yield* HttpClient.execute(
          HttpClientRequest.post('/api/pluggy/webhook').pipe(
            HttpClientRequest.setHeader('authorization', `Bearer ${secret}`),
            HttpClientRequest.bodyStream(
              Stream.fromIterable(Array.from({ length: 128 }, () => chunk)),
            ),
          ),
        )
        assert.strictEqual(response.status, 413)
      }).pipe(
        Effect.provide(
          HttpRouter.serve(routes, { disableListenLog: true }).pipe(
            Layer.provideMerge(openFinanceTest(settings)),
            Layer.provideMerge(NodeHttpServer.layerTest),
          ),
        ),
      ),
  )

  it.live(
    'answers 413 over a real connection to a chunked body past the limit',
    () =>
      Effect.gen(function* () {
        const chunk = new TextEncoder().encode('x'.repeat(16 * 1024))
        // A streamed body has no Content-Length: Node receives it chunked.
        const response = yield* HttpClient.execute(
          HttpClientRequest.post('/api/pluggy/webhook').pipe(
            HttpClientRequest.setHeader('authorization', `Bearer ${secret}`),
            HttpClientRequest.bodyStream(
              Stream.fromIterable([chunk, chunk, chunk, chunk, chunk]),
            ),
          ),
        )
        assert.strictEqual(response.status, 413)
      }).pipe(
        Effect.provide(
          HttpRouter.serve(routes, { disableListenLog: true }).pipe(
            Layer.provideMerge(openFinanceTest(settings)),
            Layer.provideMerge(NodeHttpServer.layerTest),
          ),
        ),
      ),
  )
})
