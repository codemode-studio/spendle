import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/sql/SqlClient'

// V1's asset classes with their ids, so positions imported from V1 keep them.
const assetClasses: ReadonlyArray<
  readonly [id: string, name: string, color: string, sortOrder: number]
> = [
  ['fixed-income', 'Renda fixa', '#0f766e', 10],
  ['stocks', 'Ações', '#b7791f', 20],
  ['crypto', 'Criptomoedas', '#c2413b', 30],
  ['unclassified', 'Não classificado', '#64748b', 999],
]

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  // A person's note on a movement. Like a category decision, it keeps the
  // observations the entry had when noted, so it follows the movement
  // through merges and pending-to-posted updates. `revision` orders notes:
  // when merged entries carry two, the latest shows.
  yield* sql`
    CREATE TABLE entry_notes (
      key TEXT PRIMARY KEY,
      note TEXT NOT NULL CHECK (length(trim(note)) BETWEEN 1 AND 500),
      noted_at TEXT NOT NULL,
      revision INTEGER NOT NULL UNIQUE
    )
  `
  yield* sql`
    CREATE TABLE entry_note_endpoints (
      key TEXT NOT NULL REFERENCES entry_notes (key) ON DELETE CASCADE,
      source_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      external_id TEXT NOT NULL,
      PRIMARY KEY (key, source_id, account_id, external_id)
    )
  `

  // A person withdrawing a balance they informed, or putting it back. The
  // balance observation stays; the latest row for it decides, as for
  // Open Finance invalidations.
  yield* sql`
    CREATE TABLE manual_checkpoint_withdrawals (
      balance_observation_id TEXT NOT NULL REFERENCES balance_observations (id),
      withdrawn INTEGER NOT NULL CHECK (withdrawn IN (0, 1)),
      recorded_at TEXT NOT NULL
    )
  `
  yield* sql`
    CREATE INDEX manual_checkpoint_withdrawals_observation
    ON manual_checkpoint_withdrawals (balance_observation_id)
  `
  yield* sql`
    CREATE TRIGGER manual_checkpoint_withdrawals_no_update
    BEFORE UPDATE ON manual_checkpoint_withdrawals
    BEGIN SELECT RAISE(ABORT, 'checkpoint withdrawals are immutable'); END
  `
  yield* sql`
    CREATE TRIGGER manual_checkpoint_withdrawals_no_delete
    BEFORE DELETE ON manual_checkpoint_withdrawals
    BEGIN SELECT RAISE(ABORT, 'checkpoint withdrawals are immutable'); END
  `

  // Configuration only the person changes.
  yield* sql`
    CREATE TABLE investment_asset_classes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      color TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 100,
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
    )
  `
  for (const [id, name, color, sortOrder] of assetClasses) {
    yield* sql`
      INSERT INTO investment_asset_classes (id, name, color, sort_order)
      VALUES (${id}, ${name}, ${color}, ${sortOrder})
    `
  }

  // A holding the person keeps at a brokerage account, in its currency.
  // `opening_cents` is what was contributed before any movement V2 sees.
  yield* sql`
    CREATE TABLE investment_positions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts (id),
      asset_class_id TEXT NOT NULL REFERENCES investment_asset_classes (id),
      name TEXT NOT NULL CHECK (length(trim(name)) > 0),
      symbol TEXT,
      reserve INTEGER NOT NULL DEFAULT 0 CHECK (reserve IN (0, 1)),
      opening_cents INTEGER NOT NULL DEFAULT 0 CHECK (typeof(opening_cents) = 'integer'),
      created_at TEXT NOT NULL,
      archived_at TEXT
    )
  `
  yield* sql`CREATE INDEX investment_positions_account ON investment_positions (account_id)`

  // The person putting a movement into a position. Keyed by the entry's
  // observations, like category decisions, so it follows the movement.
  yield* sql`
    CREATE TABLE investment_movement_decisions (
      key TEXT PRIMARY KEY,
      position_id TEXT NOT NULL REFERENCES investment_positions (id),
      origin TEXT NOT NULL CHECK (origin IN ('person', 'v1_import')),
      decided_at TEXT NOT NULL,
      revision INTEGER NOT NULL UNIQUE
    )
  `
  yield* sql`
    CREATE TABLE investment_movement_endpoints (
      key TEXT NOT NULL REFERENCES investment_movement_decisions (key) ON DELETE CASCADE,
      source_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      external_id TEXT NOT NULL,
      PRIMARY KEY (key, source_id, account_id, external_id)
    )
  `

  // What the person says a position is worth on a day. A later valuation
  // of the same day corrects it; rows are never changed.
  yield* sql`
    CREATE TABLE investment_valuations (
      id TEXT PRIMARY KEY,
      position_id TEXT NOT NULL REFERENCES investment_positions (id),
      as_of TEXT NOT NULL,
      amount_cents INTEGER NOT NULL CHECK (typeof(amount_cents) = 'integer' AND amount_cents >= 0),
      origin TEXT NOT NULL CHECK (origin IN ('person', 'v1_import')),
      recorded_at TEXT NOT NULL
    )
  `
  yield* sql`CREATE INDEX investment_valuations_position ON investment_valuations (position_id, as_of)`
  yield* sql`
    CREATE TRIGGER investment_valuations_no_update BEFORE UPDATE ON investment_valuations
    BEGIN SELECT RAISE(ABORT, 'valuations are immutable'); END
  `
  yield* sql`
    CREATE TRIGGER investment_valuations_no_delete BEFORE DELETE ON investment_valuations
    BEGIN SELECT RAISE(ABORT, 'valuations are immutable'); END
  `

  // What `migrate-v1` brought for these features, so a second run changes
  // nothing: positions, manual transactions and checkpoints it created.
  yield* sql`
    CREATE TABLE v1_import_ledger_map (
      kind TEXT NOT NULL CHECK (kind IN ('position', 'asset_class', 'manual_transaction', 'checkpoint', 'valuation')),
      v1_id TEXT NOT NULL,
      v2_id TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      PRIMARY KEY (kind, v1_id)
    )
  `
  // A V1 note or investment classification, applied when its movement maps
  // to exactly one entry. `value` is the note or the V2 position id.
  yield* sql`
    CREATE TABLE v1_import_ledger_decisions (
      kind TEXT NOT NULL CHECK (kind IN ('note', 'investment_movement')),
      v1_id TEXT NOT NULL,
      v1_transaction_id TEXT NOT NULL REFERENCES v1_import_movements (v1_transaction_id),
      value TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'superseded', 'refused')),
      entry_id TEXT,
      detail TEXT,
      resolved_at TEXT,
      PRIMARY KEY (kind, v1_id)
    )
  `
})
