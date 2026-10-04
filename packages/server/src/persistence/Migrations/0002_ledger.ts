import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/sql/SqlClient'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE owners (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('person', 'company', 'household')),
      created_at TEXT NOT NULL
    )
  `
  yield* sql`
    CREATE TABLE institutions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL CHECK (length(trim(name)) > 0),
      -- Accent- and case-folded name, computed in code: SQLite's lower() is ASCII-only.
      name_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    )
  `

  yield* sql`
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES owners (id),
      institution_id TEXT NOT NULL REFERENCES institutions (id),
      name TEXT NOT NULL CHECK (length(trim(name)) > 0),
      kind TEXT NOT NULL CHECK (kind IN ('checking', 'savings', 'cash', 'investment', 'credit_card')),
      purpose TEXT NOT NULL CHECK (purpose IN ('operating', 'reserve', 'investment')),
      currency TEXT NOT NULL,
      created_at TEXT NOT NULL,
      archived_at TEXT
    )
  `
  yield* sql`
    CREATE TABLE credit_card_terms (
      account_id TEXT PRIMARY KEY REFERENCES accounts (id),
      closing_day INTEGER NOT NULL CHECK (closing_day BETWEEN 1 AND 31),
      due_day INTEGER NOT NULL CHECK (due_day BETWEEN 1 AND 31),
      limit_cents INTEGER,
      last_four TEXT
    )
  `

  yield* sql`
    CREATE TABLE sources (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('open_finance', 'file', 'manual')),
      external_ref TEXT NOT NULL,
      label TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (kind, external_ref)
    )
  `

  // Observations are facts as a source reported them. A changed report is a
  // new version; the triggers make edits, deletes and replacing inserts
  // impossible.
  yield* sql`
    CREATE TABLE transaction_observations (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES sources (id),
      account_id TEXT NOT NULL REFERENCES accounts (id),
      external_id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0),
      booked_on TEXT NOT NULL,
      amount_cents INTEGER NOT NULL CHECK (typeof(amount_cents) = 'integer'),
      currency TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'posted', 'removed')),
      raw TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      UNIQUE (source_id, account_id, external_id, version)
    )
  `
  yield* sql`CREATE INDEX transaction_observations_account ON transaction_observations (account_id, booked_on)`
  yield* sql`
    CREATE TRIGGER transaction_observations_no_update BEFORE UPDATE ON transaction_observations
    BEGIN SELECT RAISE(ABORT, 'transaction observations are immutable'); END
  `
  yield* sql`
    CREATE TRIGGER transaction_observations_no_delete BEFORE DELETE ON transaction_observations
    BEGIN SELECT RAISE(ABORT, 'transaction observations are immutable'); END
  `
  yield* sql`
    CREATE TRIGGER transaction_observations_no_replace BEFORE INSERT ON transaction_observations
    WHEN EXISTS (
      SELECT 1 FROM transaction_observations
      WHERE id = NEW.id OR (source_id = NEW.source_id AND account_id = NEW.account_id
        AND external_id = NEW.external_id AND version = NEW.version)
    )
    BEGIN SELECT RAISE(ABORT, 'transaction observations are immutable'); END
  `

  yield* sql`
    CREATE TABLE balance_observations (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES sources (id),
      account_id TEXT NOT NULL REFERENCES accounts (id),
      kind TEXT NOT NULL CHECK (kind IN ('booked', 'available', 'statement')),
      as_of TEXT NOT NULL,
      balance_cents INTEGER NOT NULL CHECK (typeof(balance_cents) = 'integer'),
      currency TEXT NOT NULL,
      observed_at TEXT NOT NULL
    )
  `
  yield* sql`CREATE INDEX balance_observations_day ON balance_observations (account_id, kind, as_of)`
  yield* sql`
    CREATE TRIGGER balance_observations_no_update BEFORE UPDATE ON balance_observations
    BEGIN SELECT RAISE(ABORT, 'balance observations are immutable'); END
  `
  yield* sql`
    CREATE TRIGGER balance_observations_no_delete BEFORE DELETE ON balance_observations
    BEGIN SELECT RAISE(ABORT, 'balance observations are immutable'); END
  `
  yield* sql`
    CREATE TRIGGER balance_observations_no_replace BEFORE INSERT ON balance_observations
    WHEN EXISTS (SELECT 1 FROM balance_observations WHERE id = NEW.id)
    BEGIN SELECT RAISE(ABORT, 'balance observations are immutable'); END
  `
})
