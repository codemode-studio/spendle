import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/sql/SqlClient'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  // A person's verdict on a pairing, keyed by `kind:outflowId+inflowId`.
  // Decisions are durable; relations below are recomputed from them.
  // `revision` orders them: when merged entries make two decisions about the
  // same pair, the latest wins.
  yield* sql`
    CREATE TABLE relation_decisions (
      key TEXT PRIMARY KEY,
      decision TEXT NOT NULL CHECK (decision IN ('confirmed', 'rejected')),
      decided_at TEXT NOT NULL,
      revision INTEGER NOT NULL UNIQUE
    )
  `
  // The observations each side's entry had when the person decided, so the
  // decision follows them when entries merge under another id.
  yield* sql`
    CREATE TABLE relation_decision_endpoints (
      key TEXT NOT NULL REFERENCES relation_decisions (key) ON DELETE CASCADE,
      side TEXT NOT NULL CHECK (side IN ('outflow', 'inflow')),
      source_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      external_id TEXT NOT NULL,
      PRIMARY KEY (key, side, source_id, account_id, external_id)
    )
  `
  yield* sql`
    CREATE TABLE relations (
      key TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('internal_transfer', 'card_payment')),
      outflow_entry_id TEXT NOT NULL UNIQUE,
      inflow_entry_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('suggested', 'confirmed', 'conflict')),
      origin TEXT NOT NULL CHECK (origin IN ('auto', 'person')),
      score INTEGER NOT NULL,
      reasons TEXT NOT NULL
    )
  `
  // The last event sequence relations reflect, so a burst of entry changes
  // rebuilds them once.
  yield* sql`
    CREATE TABLE reconciliation_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      sequence INTEGER NOT NULL
    )
  `
})
