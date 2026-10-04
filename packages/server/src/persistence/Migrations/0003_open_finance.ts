import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/sql/SqlClient'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  // One row per Pluggy item. Its id is the item's clientUserId, which is how a
  // returning item is proven to belong to the connection that requested it.
  yield* sql`
    CREATE TABLE open_finance_connections (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES owners (id),
      item_id TEXT UNIQUE,
      source_id TEXT REFERENCES sources (id),
      connector_name TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'attention', 'disconnected')),
      provider_status TEXT,
      error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_synced_at TEXT
    )
  `

  // Accounts as Pluggy describes them. The provider's name and type stay here;
  // a linked ledger account keeps the name and type the person chose.
  yield* sql`
    CREATE TABLE open_finance_accounts (
      provider_account_id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL REFERENCES open_finance_connections (id),
      type TEXT NOT NULL CHECK (type IN ('BANK', 'CREDIT')),
      subtype TEXT,
      name TEXT NOT NULL,
      last_four TEXT,
      currency TEXT NOT NULL,
      account_id TEXT UNIQUE REFERENCES accounts (id),
      history_from TEXT,
      linked_at TEXT,
      updated_at TEXT NOT NULL
    )
  `

  // Transactions read without an amount in the account currency (a foreign
  // purchase not yet converted). Syncs re-read back to the oldest one until
  // it can be recorded or Pluggy has not reported it for a while: Pluggy may
  // omit a transaction from one response and return it in the next.
  yield* sql`
    CREATE TABLE open_finance_unresolved (
      provider_account_id TEXT NOT NULL REFERENCES open_finance_accounts (provider_account_id),
      provider_transaction_id TEXT NOT NULL,
      booked_on TEXT NOT NULL,
      last_seen_on TEXT NOT NULL,
      PRIMARY KEY (provider_account_id, provider_transaction_id)
    )
  `

  // Booked checkpoints inferred from running balances that a later read no
  // longer supports: the day gained a line without a running balance, or its
  // lines stopped agreeing on one closing balance. The balance observation
  // stays immutable; this row records that it was withdrawn. Readers of
  // booked checkpoints from an open_finance source must take the day's latest
  // observation and treat the day as having no checkpoint when that
  // observation is listed here (never falling back to an older one).
  yield* sql`
    CREATE TABLE open_finance_checkpoint_invalidations (
      balance_observation_id TEXT PRIMARY KEY REFERENCES balance_observations (id),
      account_id TEXT NOT NULL REFERENCES accounts (id),
      source_id TEXT NOT NULL REFERENCES sources (id),
      as_of TEXT NOT NULL,
      invalidated_at TEXT NOT NULL
    )
  `
  yield* sql`
    CREATE TRIGGER open_finance_checkpoint_invalidations_no_update
    BEFORE UPDATE ON open_finance_checkpoint_invalidations
    BEGIN SELECT RAISE(ABORT, 'checkpoint invalidations are immutable'); END
  `
  yield* sql`
    CREATE TRIGGER open_finance_checkpoint_invalidations_no_delete
    BEFORE DELETE ON open_finance_checkpoint_invalidations
    BEGIN SELECT RAISE(ABORT, 'checkpoint invalidations are immutable'); END
  `
})
