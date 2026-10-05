import * as SqliteMigrator from '@effect/sql-sqlite-node/SqliteMigrator'

import EventLog from './Migrations/0001_event_log.ts'
import Ledger from './Migrations/0002_ledger.ts'
import OpenFinance from './Migrations/0003_open_finance.ts'
import Imports from './Migrations/0004_imports.ts'

// Keys are `<id>_<name>`; each migration runs once, in id order. Import every
// migration statically so the server never depends on files beside the bundle.
// Never edit a merged migration; add a new one.
export const migrations = {
  '0001_event_log': EventLog,
  '0002_ledger': Ledger,
  '0003_open_finance': OpenFinance,
  '0004_imports': Imports,
}

export const runMigrations = SqliteMigrator.run({
  loader: SqliteMigrator.fromRecord(migrations),
})
