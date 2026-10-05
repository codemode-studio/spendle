import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/sql/SqlClient'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  // What a balance statement prints as paid in advance of its own charges
  // (Inter's "Valor antecipado", less the credits it counts), when it prints
  // it. An amount due floored at zero does not tell which printed payments
  // were an advance and which paid the previous bill; this figure does.
  yield* sql`ALTER TABLE import_files ADD COLUMN advance_cents INTEGER CHECK (advance_cents >= 0)`
})
