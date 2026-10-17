import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/sql/SqlClient'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  // When a space first received a write. A space nobody ever wrote to holds
  // nothing a person decided, so its member can move to another space.
  yield* sql`ALTER TABLE spaces ADD COLUMN written_at TEXT`
  // Claimed databases hold the data people had before spaces.
  yield* sql`UPDATE spaces SET written_at = created_at WHERE database_file NOT LIKE 'spaces/%'`
})
