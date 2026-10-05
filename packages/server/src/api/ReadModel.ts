import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'

import { AccountLink, Balance } from './definition/Accounts.ts'

const BalanceRow = Schema.Struct({
  accountId: Schema.String,
  ...Balance.fields,
})

const LinkRow = Schema.Struct({
  accountId: Schema.String,
  ...AccountLink.fields,
})

/**
 * Reads shaped for the web app that join several modules' tables. Writes
 * never go through here; each module keeps its own.
 */
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  // Per account and kind, the latest report still standing: each source's
  // latest report of a day, unless a later read withdrew it.
  const findBalances = SqlSchema.findAll({
    Request: Schema.Void,
    Result: BalanceRow,
    execute: () => sql`
      WITH standing AS (
        SELECT b.account_id, b.kind, b.as_of, b.balance_cents, b.source_id,
          s.kind AS source_kind, b.rowid AS seq
        FROM balance_observations b
        JOIN sources s ON s.id = b.source_id
        WHERE b.rowid = (
            SELECT max(l.rowid) FROM balance_observations l
            WHERE l.account_id = b.account_id AND l.source_id = b.source_id
              AND l.kind = b.kind AND l.as_of = b.as_of
          )
          AND COALESCE((SELECT i.withdrawn FROM open_finance_checkpoint_invalidations i
            WHERE i.balance_observation_id = b.id ORDER BY i.rowid DESC LIMIT 1), 0) = 0
      ),
      ranked AS (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY account_id, kind ORDER BY as_of DESC, seq DESC
        ) AS rank
        FROM standing
      )
      SELECT account_id AS accountId, kind, as_of AS asOf, balance_cents AS balanceCents,
        source_id AS sourceId, source_kind AS sourceKind
      FROM ranked WHERE rank = 1
      ORDER BY account_id, kind
    `,
  })

  const findLinks = SqlSchema.findAll({
    Request: Schema.Void,
    Result: LinkRow,
    execute: () => sql`
      SELECT account_id AS accountId, connection_id AS connectionId,
        provider_account_id AS providerAccountId, history_from AS historyFrom
      FROM open_finance_accounts
      WHERE account_id IS NOT NULL AND unlinked_at IS NULL
    `,
  })

  /** Latest balances and live Open Finance link of every account. */
  const accountState = Effect.gen(function* () {
    const [balances, links] = yield* Effect.all([
      findBalances(undefined),
      findLinks(undefined),
    ])
    const balancesOf = new Map<string, Array<Balance>>()
    for (const { accountId, ...balance } of balances) {
      const list = balancesOf.get(accountId) ?? []
      list.push(balance)
      balancesOf.set(accountId, list)
    }
    const linkOf = new Map(
      links.map(({ accountId, ...link }) => [accountId, link]),
    )
    return {
      balances: (accountId: string) => balancesOf.get(accountId) ?? [],
      link: (accountId: string) => linkOf.get(accountId) ?? null,
    }
  }).pipe(Effect.withSpan('ReadModel.accountState'))

  return { accountState }
})

export class ReadModel extends Context.Service<
  ReadModel,
  Effect.Success<typeof make>
>()('@spendle/server/api/ReadModel') {
  static readonly layer = Layer.effect(ReadModel, make)
}
