import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/sql/SqlClient'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  // Movements the person marks as one-off (a stove, a phone): they count in
  // their month but stay out of the averages that estimate later months.
  // Keyed by observations like notes (see `ledger/Followed.ts`), so a mark
  // follows the movement through merges; clearing it deletes the key.
  yield* sql`
    CREATE TABLE entry_one_offs (
      key TEXT PRIMARY KEY,
      marked_at TEXT NOT NULL
    )
  `
  yield* sql`
    CREATE TABLE entry_one_off_endpoints (
      key TEXT NOT NULL REFERENCES entry_one_offs (key) ON DELETE CASCADE,
      source_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      external_id TEXT NOT NULL,
      PRIMARY KEY (key, source_id, account_id, external_id)
    )
  `
})
