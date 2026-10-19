import * as SqliteClient from '@effect/sql-sqlite-node/SqliteClient'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'

import { ServerConfig } from '../config.ts'
import { layerClient } from './Database.ts'

// The Node client opens one serialized connection with WAL and a busy timeout.
const makeLayer = (filename: string) =>
  layerClient(
    SqliteClient.layer({
      filename,
      spanAttributes: { 'db.name': 'spendle' },
    }),
  )

/** Opens (creating its directory) and migrates the database at `filename`. */
export const layerFile = (filename: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      if (filename !== ':memory:') {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        yield* fs.makeDirectory(path.dirname(filename), { recursive: true })
      }
      return makeLayer(filename)
    }),
  )

/** Opens the database at `ServerConfig.databasePath` and migrates it. */
export const layer = Layer.unwrap(
  Effect.map(ServerConfig, ({ databasePath }) => layerFile(databasePath)),
)

/** A fresh, migrated in-memory database. Each build is isolated. */
export const layerMemory = makeLayer(':memory:')
