import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'

import { makeV1Database, writeV1 } from '../testing/V1Fixture.ts'
import { seedV1 } from '../testing/V1Scenario.ts'
import { migrateV1 } from './Migrate.ts'

describe('migrateV1', () => {
  it.effect('writes nothing on a dry run', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped()
      const v1 = yield* makeV1Database(dir, seedV1)
      const databasePath = path.join(dir, 'v2', 'spendle.sqlite')
      const v1Bytes = yield* fs.readFile(v1)

      const preview = yield* migrateV1({ from: v1, databasePath, dryRun: true })
      assert.strictEqual(preview.accounts.migrated, 3)
      assert.isFalse(yield* fs.exists(databasePath))

      yield* migrateV1({ from: v1, databasePath, dryRun: false })
      // V1 is only ever read.
      assert.deepStrictEqual(yield* fs.readFile(v1), v1Bytes)
      yield* writeV1(v1, (writer) =>
        writer.insert('accounts', {
          id: 'new',
          ownership_scope_id: 'home',
          name: 'Conta nova',
        }),
      )
      const bytes = yield* fs.readFile(databasePath)

      const next = yield* migrateV1({ from: v1, databasePath, dryRun: true })

      assert.deepStrictEqual(next.accounts, {
        migrated: 1,
        already: 3,
        skipped: 0,
      })
      assert.deepStrictEqual(yield* fs.readFile(databasePath), bytes)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})
