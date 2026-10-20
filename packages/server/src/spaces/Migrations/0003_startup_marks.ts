import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/sql/SqlClient'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  // Which deployment last finished each startup task (`events/Startup.ts`),
  // so a Durable Object waking from hibernation skips work its deployment
  // already did.
  yield* sql`
    CREATE TABLE startup_marks (
      task TEXT PRIMARY KEY,
      deployment TEXT NOT NULL
    )
  `
})
