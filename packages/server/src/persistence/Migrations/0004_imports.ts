import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/sql/SqlClient'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  // The uploaded file is kept as evidence. Its content hash identifies it, so
  // the same file uploaded twice is one import.
  yield* sql`
    CREATE TABLE import_files (
      id TEXT PRIMARY KEY,
      sha256 TEXT NOT NULL UNIQUE,
      account_id TEXT NOT NULL REFERENCES accounts (id),
      source_id TEXT NOT NULL REFERENCES sources (id),
      file_name TEXT NOT NULL,
      format TEXT NOT NULL CHECK (format IN ('ofx', 'csv', 'pdf')),
      content BLOB NOT NULL,
      period_start TEXT,
      period_end TEXT,
      -- A card bill's printed deadline, and whether its closing balance counts
      -- only the period's charges (payments it prints settled earlier bills).
      due_on TEXT,
      charges_only INTEGER NOT NULL DEFAULT 0 CHECK (charges_only IN (0, 1)),
      -- Whether that balance is an amount due printed as zero when credit
      -- exceeds it, rather than a signed balance.
      floors_at_zero INTEGER NOT NULL DEFAULT 0 CHECK (floors_at_zero IN (0, 1)),
      line_count INTEGER NOT NULL,
      rejected_rows INTEGER NOT NULL,
      imported_at TEXT NOT NULL
    )
  `
})
