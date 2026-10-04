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
  // it can be recorded or Pluggy no longer reports it.
  yield* sql`
    CREATE TABLE open_finance_unresolved (
      provider_account_id TEXT NOT NULL REFERENCES open_finance_accounts (provider_account_id),
      provider_transaction_id TEXT NOT NULL,
      booked_on TEXT NOT NULL,
      PRIMARY KEY (provider_account_id, provider_transaction_id)
    )
  `
})
