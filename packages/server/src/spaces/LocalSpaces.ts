import * as SqliteClient from '@effect/sql-sqlite-node/SqliteClient'
import * as Context from 'effect/Context'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as LayerMap from 'effect/LayerMap'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as SqlClient from 'effect/sql/SqlClient'

import { ServerConfig } from '../config.ts'
import * as Sqlite from '../persistence/Sqlite.ts'
import { SpaceApp, spaceLive } from './Space.ts'
import { SpaceDirectory, makeWith } from './SpaceDirectory.ts'
import {
  SpaceGateway,
  hasConnection,
  holdsItem,
  storeWebhook,
  unavailable,
} from './SpaceGateway.ts'

// Spaces on this machine: the control database and one database file per
// space in the data directory, each space built in this process. On
// Cloudflare each space is a Durable Object instead (`src/durable`), so
// nothing here may be imported from there.

/** The control database: a file in the data directory, or in memory. */
export const directory = Layer.effect(
  SpaceDirectory,
  Effect.gen(function* () {
    const { dataDirectory, databasePath: legacyPath } = yield* ServerConfig
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const inMemory = dataDirectory === ':memory:'

    if (!inMemory) yield* fs.makeDirectory(dataDirectory, { recursive: true })
    // A private client: the space services read `SqlClient` from their own
    // database, so this one never enters the shared context.
    const client = yield* Layer.build(
      SqliteClient.layer({
        filename: inMemory
          ? ':memory:'
          : path.join(dataDirectory, 'control.sqlite'),
        spanAttributes: { 'db.name': 'spendle-control' },
      }),
    )
    return yield* makeWith(
      Context.get(client, SqlClient.SqlClient),
      inMemory
        ? Option.none()
        : Option.some({ dataDirectory, legacyPath, fs, path }),
    )
  }),
)

/**
 * Builds `layer` with a memo map of its own. LayerMap shares one memo map
 * across keys, so module-level layers (`Accounts.layer`, `EventLog.layer`)
 * would otherwise be built once, over the first space's database, and reused
 * by every other space.
 */
const isolated = <A, E, R>(layer: Layer.Layer<A, E, R>) =>
  Layer.fromBuild((_shared, scope) =>
    Layer.buildWithMemoMap(layer, Layer.makeMemoMapUnsafe(), scope),
  )

/**
 * Each space's services, built on first use and kept: its reactors keep
 * working on events (webhooks, syncs) while nobody is signed in.
 */
export class SpaceApps extends LayerMap.Service<SpaceApps>()(
  '@spendle/server/spaces/Space/SpaceApps',
  {
    lookup: (spaceId: string) =>
      Layer.unwrap(
        Effect.gen(function* () {
          const directory = yield* SpaceDirectory
          const space = yield* directory.space(spaceId)
          if (Option.isNone(space)) {
            return yield* Effect.die(`Unknown space ${spaceId}`)
          }
          return isolated(
            spaceLive(Sqlite.layerFile(directory.databasePath(space.value))),
          )
        }),
      ),
    idleTimeToLive: Duration.infinity,
  },
) {}

/**
 * Runs `effect` with a space's services. A space that fails to build (its
 * database locked or unreadable) is dropped from the map, so the next use
 * builds it again instead of repeating the failure until a restart.
 */
export const withSpace = <A, E, R>(
  spaceId: string,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.void.pipe(
    Effect.provide(SpaceApps.get(spaceId)),
    Effect.tapCause(() => SpaceApps.invalidate(spaceId)),
    Effect.andThen(effect.pipe(Effect.provide(SpaceApps.get(spaceId)))),
  )

/** Builds every known space at startup so their reactors run from the start. */
export const warmSpaces = Layer.effectDiscard(
  Effect.gen(function* () {
    const directory = yield* SpaceDirectory
    const spaces = yield* directory.list
    yield* Effect.forEach(
      spaces,
      (space) =>
        withSpace(space.id, Effect.void).pipe(
          Effect.catchCause((cause) =>
            Effect.logError(`Space ${space.id} failed to start`, cause),
          ),
        ),
      { discard: true },
    )
  }),
)

/** The gateway to spaces built in this process. */
export const gateway = Layer.effect(
  SpaceGateway,
  Effect.gen(function* () {
    const spaceApps = yield* SpaceApps
    const ask = <A, E, R>(spaceId: string, question: Effect.Effect<A, E, R>) =>
      withSpace(spaceId, question).pipe(
        unavailable(spaceId),
        Effect.provideService(SpaceApps, spaceApps),
      )
    return SpaceGateway.of({
      serve: (spaceId) =>
        ask(
          spaceId,
          SpaceApp.useSync((app) => app),
        ).pipe(Effect.flatMap((handle) => handle)),
      holdsItem: (spaceId, itemId) => ask(spaceId, holdsItem(itemId)),
      hasConnection: (spaceId, connectionId) =>
        ask(spaceId, hasConnection(connectionId)),
      storeWebhook: (spaceId, body) => ask(spaceId, storeWebhook(body)),
    })
  }),
)
