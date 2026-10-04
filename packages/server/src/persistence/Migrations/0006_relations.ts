import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/sql/SqlClient'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  // A person's verdict on a pairing, keyed by `kind:outflowId+inflowId`.
  // Decisions are durable; relations below are recomputed from them.
  yield* sql`
    CREATE TABLE relation_decisions (
      key TEXT PRIMARY KEY,
      decision TEXT NOT NULL CHECK (decision IN ('confirmed', 'rejected')),
      decided_at TEXT NOT NULL
    )
  `
  yield* sql`
    CREATE TABLE relations (
      key TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('internal_transfer', 'card_payment')),
      outflow_entry_id TEXT NOT NULL UNIQUE,
      inflow_entry_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('suggested', 'confirmed')),
      origin TEXT NOT NULL CHECK (origin IN ('auto', 'person')),
      score INTEGER NOT NULL,
      reasons TEXT NOT NULL
    )
  `
})
