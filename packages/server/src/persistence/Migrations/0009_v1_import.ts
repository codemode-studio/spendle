import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/sql/SqlClient'

// What `migrate-v1` brought over from the V1 database, so a second run
// changes nothing and decisions wait for the facts they are about.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  // Which V2 record each V1 record became. Once mapped, a record is the
  // person's to edit in V2; later runs leave it alone.
  yield* sql`
    CREATE TABLE v1_import_map (
      kind TEXT NOT NULL CHECK (kind IN ('owner', 'account', 'card', 'category')),
      v1_id TEXT NOT NULL,
      v2_id TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      PRIMARY KEY (kind, v1_id)
    )
  `

  // A V1 transaction a decision is about, as V2 can recognise it once the
  // same movement is observed again: account, day, amount and folded
  // description, with whether V1 had any other transaction sharing them.
  yield* sql`
    CREATE TABLE v1_import_movements (
      v1_transaction_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts (id),
      booked_on TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      description_key TEXT NOT NULL,
      description TEXT NOT NULL,
      unique_by_description INTEGER NOT NULL CHECK (unique_by_description IN (0, 1)),
      unique_by_amount INTEGER NOT NULL CHECK (unique_by_amount IN (0, 1))
    )
  `

  // A person's V1 category for a transaction, applied as a V2 decision
  // (origin `v1_import`) when its movement maps to exactly one entry.
  // `superseded`: the person already decided that entry in V2.
  // `refused`: V2 does not accept the category (see `detail`).
  yield* sql`
    CREATE TABLE v1_import_category_decisions (
      v1_transaction_id TEXT PRIMARY KEY REFERENCES v1_import_movements (v1_transaction_id),
      category_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'superseded', 'refused')),
      entry_id TEXT,
      detail TEXT,
      resolved_at TEXT
    )
  `

  // A person's V1 verdict on a transfer, card payment or refund, applied
  // through reconciliation when both sides map to entries.
  yield* sql`
    CREATE TABLE v1_import_relation_decisions (
      v1_group_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('internal_transfer', 'card_payment', 'refund')),
      decision TEXT NOT NULL CHECK (decision IN ('confirmed', 'rejected')),
      outflow_v1_transaction_id TEXT NOT NULL REFERENCES v1_import_movements (v1_transaction_id),
      inflow_v1_transaction_id TEXT NOT NULL REFERENCES v1_import_movements (v1_transaction_id),
      status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'superseded', 'refused')),
      relation_key TEXT,
      detail TEXT,
      resolved_at TEXT
    )
  `
})
