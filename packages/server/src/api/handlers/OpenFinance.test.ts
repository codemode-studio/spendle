import { assert, describe, it } from '@effect/vitest'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Ref from 'effect/Ref'
import * as TestClock from 'effect/testing/TestClock'

import { Observations } from '../../ledger/Observations.ts'
import { apiClient, apiTest } from '../../testing/ApiTest.ts'
import {
  bank,
  card,
  drain,
  FakePluggyState,
  tx,
} from '../../testing/FakePluggy.ts'

// The widget flow through the API: token, Pluggy creates the item, callback.
const connectThroughApi = Effect.gen(function* () {
  yield* TestClock.setTime(
    DateTime.toEpochMillis(DateTime.makeUnsafe('2026-10-04T15:00:00Z')),
  )
  const client = yield* apiClient()
  const owner = yield* client.owners.create({
    payload: { name: 'Donald', kind: 'person' },
  })
  const { connectionId, accessToken } =
    yield* client.openFinance.createConnectToken({
      payload: { ownerId: owner.id },
    })
  yield* Ref.update(yield* FakePluggyState, (current) => ({
    ...current,
    clientUserId: connectionId,
    accounts: [bank, card],
    transactions: {
      'provider-bank': [
        tx('salary', '2026-09-05', { type: 'CREDIT', amount: 5000 }),
        tx('market', '2026-09-10', { amount: 320.5 }),
      ],
    },
  }))
  const providerAccounts = yield* client.openFinance.registerItem({
    params: { connectionId },
    payload: { itemId: 'item-1' },
  })
  return { client, owner, connectionId, accessToken, providerAccounts }
})

describe('Open Finance API', () => {
  it.effect('connects an item, links an account and copies its history', () =>
    Effect.gen(function* () {
      const { client, connectionId, accessToken, providerAccounts } =
        yield* connectThroughApi
      const account = yield* client.openFinance.link({
        params: { providerAccountId: 'provider-bank' },
        payload: {
          target: { kind: 'checking', purpose: 'operating' },
          historyMonths: 3,
        },
      })
      yield* drain
      const connections = yield* client.openFinance.connections()
      const linked = yield* client.openFinance.providerAccounts({
        params: { connectionId },
      })
      const copied = yield* (yield* Observations).current(account.id)

      assert.deepStrictEqual(
        {
          accessToken,
          offered: providerAccounts.map((found) => found.type),
          status: connections.map((found) => found.status),
          synced: connections[0]?.lastSyncedAt !== null,
          link: account.link?.providerAccountId,
          feeds: linked.find(
            (found) => found.providerAccountId === 'provider-bank',
          )?.accountId,
          copied: copied.map((found) => found.amountCents).sort(),
        },
        {
          accessToken: 'connect-token',
          offered: ['BANK', 'CREDIT'],
          status: ['active'],
          synced: true,
          link: 'provider-bank',
          feeds: account.id,
          copied: [-32050, 500000],
        },
      )
    }).pipe(Effect.provide(apiTest())),
  )

  it.effect(
    'counts the balance Pluggy reports as cash unless the person informed one that day',
    () =>
      Effect.gen(function* () {
        // The bank sends no running balance, so no day yields a booked one.
        const { client } = yield* connectThroughApi
        const account = yield* client.openFinance.link({
          params: { providerAccountId: 'provider-bank' },
          payload: {
            target: { kind: 'checking', purpose: 'operating' },
            historyMonths: 3,
          },
        })
        yield* drain
        const cash = Effect.gen(function* () {
          const october = yield* client.dashboard.month({ query: {} })
          const september = yield* client.dashboard.month({
            query: { month: '2026-09' },
          })
          return [
            october.cashFlow.cashCents,
            september.cashFlow.openingCashCents,
          ]
        })
        const reported = yield* cash
        yield* client.manual.recordCheckpoint({
          params: { accountId: account.id },
          payload: { asOf: '2026-10-04', balanceCents: 90_000 },
        })
        yield* drain
        const informed = yield* cash

        assert.deepStrictEqual(
          { reported, informed },
          {
            // Pluggy's R$ 1.000, then September walked back from it.
            reported: [100_000, 100_000 - 500_000 + 32_050],
            informed: [90_000, 90_000 - 500_000 + 32_050],
          },
        )
      }).pipe(Effect.provide(apiTest())),
  )

  it.effect('unlinks a provider account and links it again', () =>
    Effect.gen(function* () {
      const { client, connectionId } = yield* connectThroughApi
      const account = yield* client.openFinance.link({
        params: { providerAccountId: 'provider-bank' },
        payload: {
          target: { kind: 'checking', purpose: 'operating' },
          historyMonths: 3,
        },
      })
      yield* drain
      const twice = yield* client.openFinance
        .link({
          params: { providerAccountId: 'provider-bank' },
          payload: { target: { accountId: account.id }, historyMonths: 3 },
        })
        .pipe(Effect.flip)
      yield* client.openFinance.unlink({
        params: { providerAccountId: 'provider-bank' },
      })
      const unlinked = yield* client.accounts.get({
        params: { accountId: account.id },
      })
      const notLinked = yield* client.openFinance
        .unlink({ params: { providerAccountId: 'provider-bank' } })
        .pipe(Effect.flip)
      const relinked = yield* client.openFinance.link({
        params: { providerAccountId: 'provider-bank' },
        payload: { target: { accountId: account.id }, historyMonths: 6 },
      })
      yield* client.openFinance.sync({ params: { connectionId }, payload: {} })
      yield* drain

      assert.deepStrictEqual(
        {
          twice: [twice._tag, 'reason' in twice ? twice.reason : null],
          unlinked: unlinked.link,
          notLinked: 'reason' in notLinked ? notLinked.reason : null,
          relinked: relinked.link?.historyFrom,
          copied: (yield* (yield* Observations).current(account.id)).length,
        },
        {
          twice: ['Conflict', 'already_linked'],
          unlinked: null,
          notLinked: 'not_linked',
          relinked: '2026-04-01',
          copied: 2,
        },
      )
    }).pipe(Effect.provide(apiTest())),
  )

  it.effect('disconnects a connection and frees its accounts', () =>
    Effect.gen(function* () {
      const { client, connectionId } = yield* connectThroughApi
      const account = yield* client.openFinance.link({
        params: { providerAccountId: 'provider-bank' },
        payload: {
          target: { kind: 'checking', purpose: 'operating' },
          historyMonths: 3,
        },
      })
      yield* client.openFinance.disconnect({ params: { connectionId } })
      const connection = yield* client.openFinance.connection({
        params: { connectionId },
      })
      const freed = yield* client.accounts.get({
        params: { accountId: account.id },
      })
      const sync = yield* client.openFinance
        .refresh({ params: { connectionId } })
        .pipe(Effect.flip)
      assert.deepStrictEqual(
        [connection.status, freed.link, sync._tag],
        ['disconnected', null, 'Conflict'],
      )
    }).pipe(Effect.provide(apiTest())),
  )

  it.effect('reuses an abandoned request and removes it without a trace', () =>
    Effect.gen(function* () {
      const client = yield* apiClient()
      const owner = yield* client.owners.create({
        payload: { name: 'Donald', kind: 'person' },
      })
      const request = { payload: { ownerId: owner.id } }
      // The person closed the widget before choosing a bank, then tried again.
      const first = yield* client.openFinance.createConnectToken(request)
      const again = yield* client.openFinance.createConnectToken(request)
      const pending = yield* client.openFinance.connections()
      yield* client.openFinance.disconnect({
        params: { connectionId: again.connectionId },
      })
      const after = yield* client.openFinance.connections()
      assert.deepStrictEqual(
        {
          reused: again.connectionId === first.connectionId,
          pending: pending.map((connection) => connection.status),
          after: after.length,
        },
        { reused: true, pending: ['pending'], after: 0 },
      )
    }).pipe(Effect.provide(apiTest())),
  )

  it.effect('answers 404 for an unknown owner or connection', () =>
    Effect.gen(function* () {
      const client = yield* apiClient()
      const owner = yield* client.openFinance
        .createConnectToken({ payload: { ownerId: 'nobody' } })
        .pipe(Effect.flip)
      const connection = yield* client.openFinance
        .registerItem({
          params: { connectionId: 'nope' },
          payload: { itemId: 'item-1' },
        })
        .pipe(Effect.flip)
      assert.deepStrictEqual(
        [owner, connection].map((error) => [
          error._tag,
          'reason' in error ? error.reason : null,
        ]),
        [
          ['NotFound', 'owner_not_found'],
          ['NotFound', 'connection_not_found'],
        ],
      )
    }).pipe(Effect.provide(apiTest())),
  )
})
