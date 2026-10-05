import * as SqliteClient from '@effect/sql-sqlite-node/SqliteClient'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'

import { Categories } from '../categories/Categories.ts'
import { Categorizer } from '../categories/Categorizer.ts'
import { Classifier } from '../categories/Classifier.ts'
import { KnowledgeStore } from '../categories/KnowledgeStore.ts'
import { ServerConfig } from '../config.ts'
import { EventLog } from '../events/EventLog.ts'
import { Investments } from '../investments/Investments.ts'
import { Quotes } from '../investments/Quotes.ts'
import { Accounts } from '../ledger/Accounts.ts'
import { Entries } from '../ledger/Entries.ts'
import { ManualEntries } from '../ledger/Manual.ts'
import { Notes } from '../ledger/Notes.ts'
import { Observations } from '../ledger/Observations.ts'
import * as Sqlite from '../persistence/Sqlite.ts'
import { AssistantModel } from '../planning/AssistantModel.ts'
import { PlanningServices } from '../planning/Services.ts'
import { Cards } from '../reconciliation/Cards.ts'
import { Reconciliation } from '../reconciliation/Reconciliation.ts'
import { V1PlanningImport } from './PlanningImport.ts'
import { readV1 } from './V1Database.ts'
import { V1Import } from './V1Import.ts'

/** What the migration writes through, over the V2 database in `ServerConfig`. The model stays off. */
export const MigrationLive = Layer.mergeAll(
  V1Import.layer,
  V1PlanningImport.layer,
).pipe(
  Layer.provideMerge(Layer.mergeAll(ManualEntries.layer, Investments.layer)),
  // The migration never shows values, so it needs no quotes.
  Layer.provideMerge(Layer.mergeAll(Notes.layer, Quotes.fixed({}))),
  Layer.provideMerge(
    PlanningServices.pipe(Layer.provideMerge(AssistantModel.disabled)),
  ),
  Layer.provideMerge(
    Layer.mergeAll(
      Categorizer.layer,
      Reconciliation.layer,
      Entries.layer,
      Cards.layer,
    ),
  ),
  Layer.provideMerge(KnowledgeStore.layer),
  Layer.provideMerge(Categories.layer),
  Layer.provideMerge(Classifier.disabled),
  Layer.provideMerge(Observations.layer),
  Layer.provideMerge(Accounts.layer),
  Layer.provideMerge(EventLog.layer),
  Layer.provideMerge(Sqlite.layer),
)

/**
 * Migrates the V1 database at `from` into the V2 database at
 * `databasePath`. A dry run migrates a scratch copy of the V2 database
 * instead (taken with SQLite's backup, so a running server's latest
 * writes are in it) and leaves the real one untouched.
 */
export const migrateV1 = Effect.fn('migrateV1')(function* (input: {
  readonly from: string
  readonly databasePath: string
  readonly dryRun: boolean
}) {
  const snapshot = yield* readV1(input.from)
  const target = input.dryRun
    ? yield* scratchCopy(input.databasePath)
    : input.databasePath
  return yield* Effect.gen(function* () {
    const summary = yield* (yield* V1Import).run(snapshot)
    const planning = yield* (yield* V1PlanningImport).run(snapshot)
    return { ...summary, planning }
  }).pipe(
    Effect.provide(
      MigrationLive.pipe(
        Layer.provide(ServerConfig.layerTest({ databasePath: target })),
      ),
    ),
  )
}, Effect.scoped)

const scratchCopy = Effect.fnUntraced(function* (databasePath: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = yield* fs.makeTempDirectoryScoped({
    prefix: 'spendle-v1-dry-run-',
  })
  const scratch = path.join(dir, 'spendle.sqlite')
  if (databasePath !== ':memory:' && (yield* fs.exists(databasePath))) {
    yield* Effect.gen(function* () {
      yield* (yield* SqliteClient.SqliteClient).backup(scratch)
    }).pipe(
      Effect.provide(
        SqliteClient.layer({
          filename: databasePath,
          readonly: true,
          disableWAL: true,
        }).pipe(Layer.orDie),
      ),
    )
  }
  return scratch
})
