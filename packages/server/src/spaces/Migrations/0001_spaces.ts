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
})
