import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'

/**
 * Person annotations keyed by observations, the way category decisions are
 * (see `categories/FollowDecisions.ts`): each key keeps the observation
 * identities its entry had when the person acted, in an endpoints table
 * with `key, source_id, account_id, external_id`. The annotation follows
 * those observations into whatever entry holds them now, so it survives
 * merges, pending-to-posted updates and an entry losing its first source.
 */
export type EndpointsTable =
  'entry_note_endpoints' | 'investment_movement_endpoints'

const Holder = Schema.Struct({ key: Schema.String, entryId: Schema.String })

/**
 * The current entries holding each key's observations. A withdrawn
 * observation points to the entry it last belonged to, or the one that
 * entry merged into (see `Entries.resolveAccount`).
 */
export const holders = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  table: EndpointsTable,
) {
  const rows = yield* SqlSchema.findAll({
    Request: Schema.Void,
    Result: Holder,
    execute: () => sql`
      SELECT DISTINCT p.key, e.id AS entryId
      FROM ${sql(table)} p
      LEFT JOIN entry_evidence v ON v.source_id = p.source_id AND v.account_id = p.account_id
        AND v.external_id = p.external_id
      LEFT JOIN entry_identity i ON i.source_id = p.source_id AND i.account_id = p.account_id
        AND i.external_id = p.external_id
      JOIN ledger_entries e ON e.id = coalesce(v.entry_id, i.entry_id)
    `,
  })(undefined)
  const entriesOf = new Map<string, Array<string>>()
  for (const row of rows) {
    const list = entriesOf.get(row.key) ?? []
    list.push(row.entryId)
    entriesOf.set(row.key, list)
  }
  return entriesOf as ReadonlyMap<string, ReadonlyArray<string>>
})

/** Keys whose observations now sit in this entry alone. */
export const covering = (
  entriesOf: ReadonlyMap<string, ReadonlyArray<string>>,
  entryId: string,
) =>
  [...entriesOf]
    .filter(([, ids]) => ids.length === 1 && ids[0] === entryId)
    .map(([key]) => key)

/** Adds the entry's current observations to the key; endpoints are only ever added. */
export const addEndpoints = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  table: EndpointsTable,
  key: string,
  entryId: string,
) {
  yield* sql`
    INSERT OR IGNORE INTO ${sql(table)} (key, source_id, account_id, external_id)
    SELECT ${key}, source_id, account_id, external_id
    FROM entry_evidence WHERE entry_id = ${entryId}
  `
})
