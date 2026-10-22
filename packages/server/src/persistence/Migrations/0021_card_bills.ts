import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/sql/SqlClient'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  // The bills a provider reports for a card, as the bank closed them. A bill
  // reported again with other figures is a new observation; the latest
  // speaks for it. `bill_id` is the id the card's transactions carry.
  yield* sql`
    CREATE TABLE card_bill_observations (
      source_id TEXT NOT NULL REFERENCES sources (id),
      account_id TEXT NOT NULL REFERENCES accounts (id),
      bill_id TEXT NOT NULL,
      closing_on TEXT NOT NULL,
      due_on TEXT NOT NULL,
      -- What the bill asks, positive when owed.
      total_cents INTEGER NOT NULL CHECK (typeof(total_cents) = 'integer'),
      currency TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      PRIMARY KEY (source_id, account_id, bill_id, closing_on, due_on, total_cents, currency)
    )
  `
  yield* sql`
    CREATE TRIGGER card_bill_observations_no_update BEFORE UPDATE ON card_bill_observations
    BEGIN SELECT RAISE(ABORT, 'card bill observations are immutable'); END
  `
})
