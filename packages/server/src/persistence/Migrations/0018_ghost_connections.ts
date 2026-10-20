import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/sql/SqlClient'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  // Requests removed before they reached a bank were kept as disconnected
  // connections with nothing in them; removing one now deletes it.
  yield* sql`
    DELETE FROM open_finance_connections
    WHERE status = 'disconnected' AND item_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM open_finance_accounts a
        WHERE a.connection_id = open_finance_connections.id)
  `
})
