import * as SqliteClient from '@effect/sql-sqlite-node/SqliteClient'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import * as SqlClient from 'effect/sql/SqlClient'

import { ServerConfig } from '../config.ts'
import { runMigrations } from './Migrations.ts'

// The client opens one serialized connection with WAL and a busy timeout.
// Foreign keys and recursive triggers are per-connection settings, so they
// are enabled here. Recursive triggers make the implicit delete of an
// `INSERT OR REPLACE` fire delete triggers, which guard immutable facts.
const setup = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`PRAGMA foreign_keys = ON`
    yield* sql`PRAGMA recursive_triggers = ON`
    yield* runMigrations
  }),
)

const makeLayer = (filename: string) =>
  setup.pipe(
    Layer.provideMerge(
      SqliteClient.layer({
        filename,
        spanAttributes: { 'db.name': 'spendle' },
      }),
    ),
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
