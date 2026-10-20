import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/sql/SqlClient'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  // Confirmations that no longer hold their entries, kept beside relations by
  // the same rebuild so reading them needs no matching. A projection: the
  // state reset below makes the next rebuild fill it.
  yield* sql`
    CREATE TABLE relation_orphans (
      key TEXT PRIMARY KEY,
      reason TEXT NOT NULL CHECK (reason IN (
        'entry_missing', 'entry_split', 'overlapping_confirmation'
      )),
      missing TEXT NOT NULL,
      reserved TEXT NOT NULL
    )
  `
  yield* sql`DELETE FROM reconciliation_state`
})
