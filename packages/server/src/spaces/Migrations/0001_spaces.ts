import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/sql/SqlClient'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  // A family space and the database file that holds all of its data,
  // relative to the data directory unless absolute.
  yield* sql`
    CREATE TABLE spaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      database_file TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    )
  `

  // Each signed-in email belongs to exactly one space, stored lowercase.
  yield* sql`
    CREATE TABLE space_members (
      email TEXT PRIMARY KEY,
      space_id TEXT NOT NULL REFERENCES spaces (id),
      role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
      added_at TEXT NOT NULL
    )
  `
  yield* sql`CREATE INDEX space_members_space ON space_members (space_id)`

  // Pluggy deliveries, stored before anything else so a delivery that cannot
  // be routed yet (Pluggy or a space unavailable, data not claimed) is kept
  // and retried. `routed_at` is set once every space it belongs to has it.
  yield* sql`
    CREATE TABLE webhook_inbox (
      event_id TEXT PRIMARY KEY,
      item_id TEXT,
      payload TEXT NOT NULL,
      received_at TEXT NOT NULL,
      routed_at TEXT
    )
  `
  yield* sql`CREATE INDEX webhook_inbox_pending ON webhook_inbox (routed_at)`
})
