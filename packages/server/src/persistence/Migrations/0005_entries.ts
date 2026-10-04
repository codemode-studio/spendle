import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/sql/SqlClient'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  // A projection of observations: rebuilt per account whenever they change.
  yield* sql`
    CREATE TABLE ledger_entries (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts (id),
      booked_on TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      currency TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'posted'))
    )
  `
  yield* sql`CREATE INDEX ledger_entries_account ON ledger_entries (account_id, booked_on)`
  yield* sql`
    CREATE TABLE entry_evidence (
      source_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      external_id TEXT NOT NULL,
      entry_id TEXT NOT NULL REFERENCES ledger_entries (id) ON DELETE CASCADE,
      PRIMARY KEY (source_id, account_id, external_id)
    )
  `
  yield* sql`CREATE INDEX entry_evidence_entry ON entry_evidence (entry_id)`
  // The last event sequence each account's entries reflect, so a burst of
  // observations resolves the account once.
  yield* sql`
    CREATE TABLE entry_resolution (
      account_id TEXT PRIMARY KEY REFERENCES accounts (id),
      sequence INTEGER NOT NULL
    )
  `
})
