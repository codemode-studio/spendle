import * as SqliteClient from '@effect/sql-sqlite-node/SqliteClient'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import * as SqlClient from 'effect/sql/SqlClient'

import { ServerConfig } from '../config.ts'
import { runMigrations } from './Migrations.ts'

// The client opens one serialized connection with WAL and a busy timeout.
// Foreign keys are a per-connection setting, so they are enabled here.
const setup = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`PRAGMA foreign_keys = ON`
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

/** Opens the database at `ServerConfig.databasePath` and migrates it. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const { databasePath } = yield* ServerConfig
    if (databasePath !== ':memory:') {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true })
    }
    return makeLayer(databasePath)
  }),
)

/** A fresh, migrated in-memory database. Each build is isolated. */
export const layerMemory = makeLayer(':memory:')
