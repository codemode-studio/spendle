import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as Ref from 'effect/Ref'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientResponse from 'effect/http/HttpClientResponse'
import * as TestClock from 'effect/testing/TestClock'

import { PluggyClient } from './PluggyClient.ts'

type Route = (
  url: URL,
  method: string,
  headers: Record<string, string>,
) => Response | undefined

// A Pluggy stand-in: routes requests and records `METHOD /path?query X-API-KEY`.
const fakePluggy = (route: Route) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([])
    const client = HttpClient.make((request, url) =>
      Effect.gen(function* () {
        const key = request.headers['x-api-key'] ?? '-'
        yield* Ref.update(calls, (all) => [
          ...all,
          `${request.method} ${url.pathname}${url.search} ${key}`,
        ])
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
    return { pluggy, calls: Ref.get(calls) }
  })

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status })

describe('PluggyClient', () => {
  it.effect('authenticates once and reuses the API key', () =>
    Effect.gen(function* () {
      let keys = 0
      const { pluggy, calls } = yield* fakePluggy((url) => {
        if (url.pathname === '/auth') return json({ apiKey: `key-${++keys}` })
        if (url.pathname === '/items/item-1')
          return json({
            id: 'item-1',
            status: 'UPDATED',
            connector: { id: 1, name: 'Nubank' },
          })
      })

      yield* pluggy.getItem('item-1')
      yield* pluggy.getItem('item-1')

      assert.deepStrictEqual(yield* calls, [
        'POST /auth -',
        'GET /items/item-1 key-1',
        'GET /items/item-1 key-1',
      ])
    }),
  )

  it.effect('re-authenticates once when the API key is rejected', () =>
    Effect.gen(function* () {
      let keys = 0
      const { pluggy, calls } = yield* fakePluggy((url, _method, headers) => {
        if (url.pathname === '/auth') return json({ apiKey: `key-${++keys}` })
        if (headers['x-api-key'] === 'key-1') return json({}, 401)
        return json({ results: [] })
      })

      assert.deepStrictEqual(yield* pluggy.listAccounts('item-1'), [])
      assert.deepStrictEqual(yield* calls, [
        'POST /auth -',
        'GET /accounts?itemId=item-1 key-1',
        'POST /auth -',
        'GET /accounts?itemId=item-1 key-2',
      ])
    }),
  )

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

  it.effect('waits for the rate-limit window before retrying', () =>
    Effect.gen(function* () {
      let calls = 0
      const { pluggy } = yield* fakePluggy((url) => {
        if (url.pathname === '/auth') return json({ apiKey: 'key' })
        calls++
        if (calls === 1)
          return new Response('{}', {
            status: 429,
            headers: { 'Retry-After': '30' },
          })
        return json({
          id: 'item-1',
          status: 'UPDATED',
          connector: { id: 1, name: 'Nubank' },
        })
      })

      const fiber = yield* Effect.forkChild(pluggy.getItem('item-1'))
      yield* TestClock.adjust('29 seconds')
      assert.strictEqual(calls, 1)
      yield* TestClock.adjust('2 seconds')
      const item = yield* Fiber.join(fiber)
      assert.deepStrictEqual([item.id, calls], ['item-1', 2])
    }),
  )

  it.effect('waits for the rate-limit window before authenticating again', () =>
    Effect.gen(function* () {
      let auths = 0
      const { pluggy } = yield* fakePluggy((url) => {
        if (url.pathname === '/auth') {
          auths++
          if (auths === 1)
            return new Response('{}', {
              status: 429,
              headers: { 'RateLimit-Reset': '30' },
            })
          return json({ apiKey: 'key' })
        }
        return json({
          id: 'item-1',
          status: 'UPDATED',
          connector: { id: 1, name: 'Nubank' },
        })
      })

      const fiber = yield* Effect.forkChild(pluggy.getItem('item-1'))
      yield* TestClock.adjust('29 seconds')
      assert.strictEqual(auths, 1)
      yield* TestClock.adjust('2 seconds')
      const item = yield* Fiber.join(fiber)
      assert.deepStrictEqual([item.id, auths], ['item-1', 2])
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
