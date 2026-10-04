import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/sql/SqlClient'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE domain_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      correlation_id TEXT,
      occurred_at TEXT NOT NULL
    )
  `
  yield* sql`CREATE INDEX domain_events_stream ON domain_events (stream_id, sequence)`

  yield* sql`
    CREATE TABLE reactor_cursors (
      reactor TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )
  `
})
