import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/sql/SqlClient'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  // People call it paying the bill, from either side of the payment.
  yield* sql`
    UPDATE categories SET name = 'Pagamento de fatura' WHERE id = 'card_payment'
  `
})
