import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/sql/SqlClient'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  // Exchange rates fetched from public sources, kept so reads need not ask
  // again. Rebuildable: emptying both tables only makes the next read fetch
  // the rates anew. `rate_micros` is reais per unit × 1 000 000 on
  // `rate_date`, the day the source published it.
  yield* sql`
    CREATE TABLE exchange_rates (
      currency TEXT NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
      rate_date TEXT NOT NULL CHECK (rate_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
      rate_micros INTEGER NOT NULL CHECK (rate_micros > 0),
      source TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      PRIMARY KEY (currency, rate_date)
    )
  `
  // The period each currency was fetched for, so days without a rate
  // (weekends, holidays) are not asked for again; `checked_at` is when the
  // latest days were last asked for, in epoch milliseconds.
  yield* sql`
    CREATE TABLE exchange_rate_coverage (
      currency TEXT PRIMARY KEY CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
      covered_from TEXT NOT NULL,
      covered_through TEXT NOT NULL,
      checked_at INTEGER NOT NULL
    )
  `
})
