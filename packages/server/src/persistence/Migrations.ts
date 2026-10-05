import * as SqliteMigrator from '@effect/sql-sqlite-node/SqliteMigrator'

// Keys are `<id>_<name>`; each migration runs once, in id order. Import every
// migration statically so the server never depends on files beside the bundle.
export const migrations = {}

export const runMigrations = SqliteMigrator.run({
  loader: SqliteMigrator.fromRecord(migrations),
})
