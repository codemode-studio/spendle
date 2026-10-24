import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/sql/SqlClient'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  // The person's monthly spending cap for a category, from `from_month` on
  // until a later row changes it; a null `cents` removes the cap from that
  // month. Setting a month's cap again replaces it.
  yield* sql`
    CREATE TABLE category_caps (
      category_id TEXT NOT NULL REFERENCES categories (id),
      from_month TEXT NOT NULL CHECK (from_month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
      cents INTEGER CHECK (cents IS NULL OR (typeof(cents) = 'integer' AND cents >= 0)),
      set_at TEXT NOT NULL,
      PRIMARY KEY (category_id, from_month)
    )
  `
})
