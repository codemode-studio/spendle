import * as Config from 'effect/Config'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'

export interface ServerConfigShape {
  readonly databasePath: string
  readonly port: number
}

// Resolves to `<repo>/data/v2`, beside the v1 database and inside the gitignored `data/`.
const defaultDatabaseUrl = new URL(
  '../../../data/v2/spendle.sqlite',
  import.meta.url,
)

export class ServerConfig extends Context.Service<
  ServerConfig,
  ServerConfigShape
>()('@spendle/server/config/ServerConfig') {
  static readonly layer = Layer.effect(
    ServerConfig,
    Effect.gen(function* () {
      const path = yield* Path.Path
      const defaultDatabasePath = yield* path.fromFileUrl(defaultDatabaseUrl)
      const databasePath = yield* Config.String('SPENDLE_DATABASE_PATH').pipe(
        Config.withDefault(defaultDatabasePath),
      )
      const port = yield* Config.Port('SPENDLE_SERVER_PORT').pipe(
        Config.withDefault(4100),
      )
      // `:memory:` is SQLite's in-memory database, not a file to resolve.
      return ServerConfig.of({
        databasePath:
          databasePath === ':memory:'
            ? databasePath
            : path.resolve(databasePath),
        port,
      })
    }),
  )

  static readonly layerTest = (overrides: Partial<ServerConfigShape> = {}) =>
    Layer.succeed(ServerConfig, {
      databasePath: ':memory:',
      port: 0,
      ...overrides,
    })
}
