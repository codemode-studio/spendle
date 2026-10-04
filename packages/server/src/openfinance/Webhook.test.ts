import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as Ref from 'effect/Ref'

import { EventLog } from '../events/EventLog.ts'
import { Observations } from '../ledger/Observations.ts'
import {
  bank,
  connect,
  drain,
  FakePluggyState,
  openFinanceTest,
  tx,
} from '../testing/FakePluggy.ts'
import { acceptWebhook, webhookReceived } from './Webhook.ts'

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

  it.effect('disconnects on item/deleted without calling Pluggy again', () =>
    Effect.gen(function* () {
      const { openFinance, connectionId, state } = yield* linkedBank()

      yield* deliver({
        eventId: 'evt-4',
        event: 'item/deleted',
        itemId: 'item-1',
      })
      yield* drain

      assert.strictEqual(
        (yield* openFinance.connection(connectionId)).status,
        'disconnected',
      )
      assert.deepStrictEqual((yield* Ref.get(state)).deleted, [])
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
})
