import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, describe, it } from '@effect/vitest'
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import { ApiConfig } from './api/ApiConfig.ts'
import { ServerConfig } from './config.ts'

const configWith = (env: Record<string, string>) =>
  ServerConfig.layer.pipe(
    Layer.provide(NodeServices.layer),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
  )

describe('ServerConfig', () => {
  it.effect('keeps SQLite in-memory databases in memory', () =>
    Effect.gen(function* () {
      const { databasePath } = yield* ServerConfig
      assert.strictEqual(databasePath, ':memory:')
    }).pipe(Effect.provide(configWith({ SPENDLE_DATABASE_PATH: ':memory:' }))),
  )

  it.effect('resolves a relative database path to an absolute one', () =>
    Effect.gen(function* () {
      const { databasePath } = yield* ServerConfig
      assert.isTrue(
        databasePath.startsWith('/') &&
          databasePath.endsWith('/db/spendle.sqlite'),
      )
    }).pipe(
      Effect.provide(
        configWith({ SPENDLE_DATABASE_PATH: 'db/spendle.sqlite' }),
      ),
    ),
  )

  it.effect('listens on loopback unless told otherwise', () =>
    Effect.gen(function* () {
      const { host } = yield* ServerConfig
      assert.strictEqual(host, '127.0.0.1')
    }).pipe(Effect.provide(configWith({}))),
  )
})

describe('ApiConfig', () => {
  const apiConfigWith = (env: Record<string, string>) =>
    ApiConfig.layer.pipe(
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
    )

  it.effect('refuses a token short enough to guess', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        Effect.provide(
          Effect.service(ApiConfig),
          apiConfigWith({ SPENDLE_API_TOKEN: 'short' }),
        ),
      )
      assert.strictEqual(error._tag, 'ApiConfigError')
    }),
  )
})
