import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, describe, it } from '@effect/vitest'
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

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
})
