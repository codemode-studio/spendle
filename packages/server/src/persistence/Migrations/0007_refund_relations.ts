import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/sql/SqlClient'

// Relations are a projection of entries and decisions, so the table is
// recreated to accept refunds and refilled by the next rebuild. A purchase
// may be given back by several refunds, so outflows are no longer unique;
// the matcher keeps every other entry in one relation at most.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`DROP TABLE relations`
  yield* sql`
    CREATE TABLE relations (
      key TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('internal_transfer', 'card_payment', 'refund')),
      outflow_entry_id TEXT NOT NULL,
      inflow_entry_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('suggested', 'confirmed', 'conflict')),
      origin TEXT NOT NULL CHECK (origin IN ('auto', 'person')),
      score INTEGER NOT NULL,
      reasons TEXT NOT NULL
    )
  `
  yield* sql`CREATE INDEX relations_outflow ON relations (outflow_entry_id)`
  yield* sql`DELETE FROM reconciliation_state`
})
