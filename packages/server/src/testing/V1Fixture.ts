import * as SqliteClient from '@effect/sql-sqlite-node/SqliteClient'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/sql/SqlClient'

/**
 * Synthetic V1 databases for migration tests, built with V1's own Drizzle
 * migrations (`drizzle/` at the repository root) so they have exactly the
 * schema the V1 app writes. Never point a test at a real V1 database.
 */

const drizzle = new URL('../../../../drizzle/', import.meta.url)

const Journal = Schema.fromJsonString(
  Schema.Struct({
    entries: Schema.Array(Schema.Struct({ tag: Schema.String })),
  }),
)

// SQL functions V1 registers for data backfills; on an empty database
// those statements change nothing, and the client here cannot register them.
const backfill =
  /\b(?:normalize_description|merchant_signature|knowledge_pattern)\s*\(/

const migrate = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const sql = yield* SqlClient.SqlClient
  const dir = yield* path.fromFileUrl(drizzle)
  const journal = yield* Schema.decodeEffect(Journal)(
    yield* fs.readFileString(path.join(dir, 'meta', '_journal.json')),
  )
  for (const { tag } of journal.entries) {
    const text = yield* fs.readFileString(path.join(dir, `${tag}.sql`))
    for (const statement of text.split('--> statement-breakpoint')) {
      if (statement.trim() === '' || backfill.test(statement)) continue
      yield* sql.unsafe(statement)
    }
  }
})

type Row = Record<string, string | number | null>

/** Writes rows into the synthetic V1 database. */
export interface V1Writer {
  readonly insert: (table: string, row: Row) => Effect.Effect<void>
  /** Inserts or replaces: V1's migrations already seed a few categories. */
  readonly upsert: (table: string, row: Row) => Effect.Effect<void>
}

const writer: Effect.Effect<V1Writer, never, SqlClient.SqlClient> = Effect.map(
  SqlClient.SqlClient,
  (sql): V1Writer => ({
    insert: (table, row) =>
      sql`INSERT INTO ${sql(table)} ${sql.insert(row)}`.pipe(
        Effect.asVoid,
        Effect.orDie,
      ),
    upsert: (table, row) =>
      sql`INSERT OR REPLACE INTO ${sql(table)} ${sql.insert(row)}`.pipe(
        Effect.asVoid,
        Effect.orDie,
      ),
  }),
)

/**
 * A V1 database file in `dir` with V1's schema, filled by `seed`. The
 * connection closes before the path is returned, as V1 would leave it.
 */
export const makeV1Database = <E, R>(
  dir: string,
  seed: (v1: V1Writer) => Effect.Effect<void, E, R>,
  name = 'v1.sqlite',
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const filename = path.join(dir, name)
    yield* Effect.gen(function* () {
      yield* migrate
      yield* seed(yield* writer)
    }).pipe(Effect.provide(SqliteClient.layer({ filename }).pipe(Layer.orDie)))
    return filename
  })

/** Adds rows to an existing synthetic V1 database. */
export const writeV1 = <E, R>(
  filename: string,
  seed: (v1: V1Writer) => Effect.Effect<void, E, R>,
) =>
  Effect.gen(function* () {
    yield* seed(yield* writer)
  }).pipe(Effect.provide(SqliteClient.layer({ filename }).pipe(Layer.orDie)))
