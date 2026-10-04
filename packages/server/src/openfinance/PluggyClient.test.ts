import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientResponse from 'effect/http/HttpClientResponse'
import * as TestClock from 'effect/testing/TestClock'

import { PluggyClient } from './PluggyClient.ts'

type Route = (
  url: URL,
  method: string,
  headers: Record<string, string>,
) => Response | undefined

// Scripted HTTP responses, to exercise how the client pages and waits.
const fakePluggy = (route: Route) =>
  Effect.gen(function* () {
    const client = HttpClient.make((request, url) =>
      Effect.sync(() => {
        const response =
          route(url, request.method, request.headers) ??
          new Response('{}', { status: 404 })
        return HttpClientResponse.fromWeb(request, response)
      }),
    )
    const pluggy = yield* PluggyClient.make({
      baseUrl: 'https://pluggy.test',
      credentials: Option.some({
        clientId: 'id',
        clientSecret: Redacted.make('secret'),
      }),
    }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, client)))
    return { pluggy }
  })

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status })

describe('PluggyClient', () => {
  it.effect('follows transaction cursors to the last page', () =>
    Effect.gen(function* () {
      const tx = (id: string) => ({
        id,
        accountId: 'acc',
        date: '2026-09-15T15:00:00.000Z',
        description: id,
        type: 'DEBIT',
        amount: 1,
        currencyCode: 'BRL',
      })
      const { pluggy } = yield* fakePluggy((url) => {
        if (url.pathname === '/auth') return json({ apiKey: 'key' })
        const after = url.searchParams.get('after')
        if (after === null)
          return json({ results: [tx('a')], next: '/v2/transactions?after=c1' })
        if (after === 'c1') return json({ results: [tx('b')], next: null })
      })

      const all = yield* pluggy.listTransactions({
        accountId: 'acc',
        dateFrom: '2026-07-01',
        dateTo: '2026-10-04',
      })
      assert.deepStrictEqual(
        all.map((transaction) => transaction.id),
        ['a', 'b'],
      )
    }),
  )

  // Pluggy signals the window with Retry-After on resources and
  // RateLimit-Reset on /auth; either way nothing is sent before it ends.
  for (const { limited, header } of [
    { limited: '/items/item-1', header: 'Retry-After' },
    { limited: '/auth', header: 'RateLimit-Reset' },
  ]) {
    it.effect(`waits for the rate-limit window on ${limited}`, () =>
      Effect.gen(function* () {
        let attempts = 0
        const { pluggy } = yield* fakePluggy((url) => {
          if (url.pathname === limited && ++attempts === 1)
            return new Response('{}', {
              status: 429,
              headers: { [header]: '30' },
            })
          if (url.pathname === '/auth') return json({ apiKey: 'key' })
          return json({
            id: 'item-1',
            status: 'UPDATED',
            connector: { id: 1, name: 'Nubank' },
          })
        })

        const fiber = yield* Effect.forkChild(pluggy.getItem('item-1'))
        yield* TestClock.adjust('29 seconds')
        assert.strictEqual(attempts, 1)
        yield* TestClock.adjust('2 seconds')
        const item = yield* Fiber.join(fiber)
        assert.deepStrictEqual([item.id, attempts], ['item-1', 2])
      }),
    )
  }

  it.effect(
    'subscribes the webhook once and updates the existing subscription after',
    () =>
      Effect.gen(function* () {
        let subscriptions: ReadonlyArray<{
          id: string
          url: string
          event: string
        }> = []
        const { pluggy, calls } = yield* fakePluggy((url, method) => {
          if (url.pathname === '/auth') return json({ apiKey: 'key' })
          if (url.pathname === '/webhooks' && method === 'GET')
            return json({ results: subscriptions })
          if (url.pathname === '/webhooks' && method === 'POST') {
            subscriptions = [
              {
                id: 'wh-1',
                url: 'https://spendle.example/api/pluggy/webhook',
                event: 'all',
              },
            ]
            return json(subscriptions[0])
          }
          if (url.pathname === '/webhooks/wh-1' && method === 'PATCH')
            return json(subscriptions[0])
        })
        const webhook = {
          url: 'https://spendle.example/api/pluggy/webhook',
          secret: Redacted.make('whsec'),
        }

        yield* pluggy.ensureWebhook(webhook)
        yield* pluggy.ensureWebhook(webhook)

        assert.deepStrictEqual(
          (yield* calls).filter((call) => !call.startsWith('POST /auth')),
          [
            'GET /webhooks key',
            'POST /webhooks key',
            'GET /webhooks key',
            'PATCH /webhooks/wh-1 key',
          ],
        )
      }),
  )

  it.effect('creates the subscription when Pluggy lists none with a 204', () =>
    Effect.gen(function* () {
      const { pluggy, calls } = yield* fakePluggy((url, method) => {
        if (url.pathname === '/auth') return json({ apiKey: 'key' })
        if (url.pathname === '/webhooks' && method === 'GET')
          return new Response(null, { status: 204 })
        if (url.pathname === '/webhooks' && method === 'POST')
          return json({ id: 'wh-1' })
      })
      yield* pluggy.ensureWebhook({
        url: 'https://spendle.example/api/pluggy/webhook',
        secret: Redacted.make('s'),
      })
      assert.deepStrictEqual(
        (yield* calls).filter((call) => !call.startsWith('POST /auth')),
        ['GET /webhooks key', 'POST /webhooks key'],
      )
    }),
  )

  it.effect('reports a missing configuration without calling Pluggy', () =>
    Effect.gen(function* () {
      const pluggy = yield* PluggyClient.make({
        baseUrl: 'https://pluggy.test',
        credentials: Option.none(),
      }).pipe(
        Effect.provide(
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die('Pluggy must not be called')),
          ),
        ),
      )
      const error = yield* pluggy.getItem('item-1').pipe(Effect.flip)
      assert.strictEqual(error.reason, 'not_configured')
    }),
  )
})
