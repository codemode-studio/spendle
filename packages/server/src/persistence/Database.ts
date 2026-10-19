import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as SqlClient from 'effect/sql/SqlClient'

import { runMigrations } from './Migrations.ts'

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

/**
 * Configures and migrates the database behind `client`: a file here, or a
 * Durable Object's storage when the server runs on Cloudflare.
 */
export const layerClient = <E, R>(
  client: Layer.Layer<SqlClient.SqlClient, E, R>,
) => setup.pipe(Layer.provideMerge(client))
