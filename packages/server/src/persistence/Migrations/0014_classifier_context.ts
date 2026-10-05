import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/sql/SqlClient'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  // A hash of the person's decisions the model saw as examples with the
  // question (`categories/Examples.ts`); empty when it saw none. One answer
  // per merchant, direction and model version is kept: when the examples an
  // item would get change, it is asked again and the answer replaced.
  yield* sql`ALTER TABLE model_classifications ADD COLUMN context TEXT NOT NULL DEFAULT ''`
})
