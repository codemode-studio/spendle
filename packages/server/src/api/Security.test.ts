import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'

import { apiClient, apiTest, rawJson } from '../testing/ApiTest.ts'

const token = 'a-local-token-long-enough-to-count-0123456789'

describe('API access', () => {
  it.effect('accepts any local caller when no token is configured', () =>
    Effect.gen(function* () {
      const owners = yield* (yield* apiClient()).owners.list()
      assert.deepStrictEqual(owners, [])
    }).pipe(Effect.provide(apiTest())),
  )

  it.effect('requires the configured bearer token on /api/v2', () =>
    Effect.gen(function* () {
      const missing = yield* rawJson(HttpClientRequest.get('/api/v2/owners'))
      const wrong = yield* rawJson(
        HttpClientRequest.get('/api/v2/owners').pipe(
          HttpClientRequest.bearerToken('guess'),
        ),
      )
      const owners = yield* (yield* apiClient(token)).owners.list()
      // Health answers without a token, so a supervisor can probe it.
      yield* (yield* apiClient()).health()

      const refused = {
        status: 401,
        body: { _tag: 'Unauthorized', reason: 'invalid_token', detail: null },
      }
      assert.deepStrictEqual([missing, wrong, owners], [refused, refused, []])
    }).pipe(Effect.provide(apiTest({ token }))),
  )

  it.effect('checks the token before reading a malformed body', () =>
    Effect.gen(function* () {
      const response = yield* rawJson(
        HttpClientRequest.post('/api/v2/owners').pipe(
          HttpClientRequest.bodyJsonUnsafe({ name: 42 }),
        ),
      )
      assert.strictEqual(response.status, 401)
    }).pipe(Effect.provide(apiTest({ token }))),
  )

  it.effect('publishes the OpenAPI document', () =>
    Effect.gen(function* () {
      const { status, body } = yield* rawJson(
        HttpClientRequest.get('/api/v2/openapi.json'),
      )
      assert.strictEqual(status, 200)
      assert.isTrue(
        Object.keys((body as { paths: object }).paths).includes(
          '/api/v2/entries',
        ),
      )
    }).pipe(Effect.provide(apiTest())),
  )
})

describe('API definition', () => {
  // The web app bundles these modules: server code must not leak into them.
  it.effect('imports only effect and its own modules', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = path.join(
        yield* path.fromFileUrl(new URL('.', import.meta.url)),
        'definition',
      )
      const foreign: Array<string> = []
      for (const file of yield* fs.readDirectory(directory)) {
        const source = yield* fs.readFileString(path.join(directory, file))
        for (const [, specifier] of source.matchAll(/from '([^']+)'/g)) {
          if (
            !specifier!.startsWith('effect/') &&
            !/^\.\/[A-Za-z]+\.ts$/.test(specifier!)
          )
            foreign.push(`${file}: ${specifier}`)
        }
      }
      assert.deepStrictEqual(foreign, [])
    }).pipe(Effect.provide(NodeServices.layer)),
  )
})
