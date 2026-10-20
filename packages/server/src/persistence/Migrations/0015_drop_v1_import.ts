import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/sql/SqlClient'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  // The V1 migration is gone, and with it the maps and waiting decisions it
  // kept. Tables that reference `v1_import_movements` go first. What it
  // brought over stays, still labelled `v1_import` where a row records its
  // origin.
  yield* sql`DROP TABLE IF EXISTS v1_import_category_decisions`
  yield* sql`DROP TABLE IF EXISTS v1_import_relation_decisions`
  yield* sql`DROP TABLE IF EXISTS v1_import_recurrence_links`
  yield* sql`DROP TABLE IF EXISTS v1_import_ledger_decisions`
  yield* sql`DROP TABLE IF EXISTS v1_import_movements`
  yield* sql`DROP TABLE IF EXISTS v1_import_map`
  yield* sql`DROP TABLE IF EXISTS v1_import_planning_map`
  yield* sql`DROP TABLE IF EXISTS v1_import_ledger_map`
})
