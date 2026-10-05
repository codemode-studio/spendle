import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import * as SqlClient from 'effect/sql/SqlClient'

import { ServerConfig } from '../config.ts'
import * as Sqlite from './Sqlite.ts'

const pragma = (name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql.unsafe<Record<string, unknown>>(`PRAGMA ${name}`)
    return rows[0]?.[name]
  })

describe('Sqlite', () => {
  it.effect('enforces foreign keys and records applied migrations', () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* pragma('foreign_keys'), 1)

      const sql = yield* SqlClient.SqlClient
      const tables = yield* sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
      `
      assert.strictEqual(tables.length, 1)
    }).pipe(Effect.provide(Sqlite.layerMemory)),
  )

  it.effect('creates the database directory and opens it in WAL mode', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped()
      const databasePath = path.join(dir, 'nested', 'spendle.sqlite')

      const journalMode = yield* pragma('journal_mode').pipe(
        Effect.provide(
          Sqlite.layer.pipe(
            Layer.provide(ServerConfig.layerTest({ databasePath })),
          ),
        ),
      )

      assert.strictEqual(journalMode, 'wal')
      assert.isTrue(yield* fs.exists(databasePath))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})
