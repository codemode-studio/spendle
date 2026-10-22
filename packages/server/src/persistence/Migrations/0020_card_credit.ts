import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/sql/SqlClient'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  // The card's limit and what is left of it, as the provider last reported
  // them: the provider's state, like the account's name, not a ledger fact.
  yield* sql`ALTER TABLE open_finance_accounts ADD COLUMN credit_limit_cents INTEGER`
  yield* sql`ALTER TABLE open_finance_accounts ADD COLUMN available_credit_cents INTEGER`
  yield* sql`ALTER TABLE open_finance_accounts ADD COLUMN credit_as_of TEXT`
})
