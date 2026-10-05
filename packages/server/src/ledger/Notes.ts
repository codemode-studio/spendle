import * as Context from 'effect/Context'
import * as Crypto from 'effect/Crypto'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'

import { addEndpoints, covering, holders } from './Followed.ts'

/** A note is free text the person writes; blank clears it. */
export const maxNoteLength = 500

export class NotesError extends Schema.TaggedError<NotesError>()('NotesError', {
  reason: Schema.Literals(['entry_not_found', 'note_too_long']),
  entryId: Schema.String,
}) {
  override get message(): string {
    return `${this.reason}: ${this.entryId}`
  }
}

/**
 * A derived table of each entry's note (`entry_id`, `note`): the latest
 * revision among the notes whose observations the entry holds now. Join it
 * with `LEFT JOIN (${entryNotes(sql)}) n ON n.entry_id = e.id`.
 */
export const entryNotes = (sql: SqlClient.SqlClient) => sql`
  SELECT entry_id, note FROM (
    SELECT coalesce(v.entry_id, i.entry_id) AS entry_id, n.note,
      ROW_NUMBER() OVER (
        PARTITION BY coalesce(v.entry_id, i.entry_id) ORDER BY n.revision DESC
      ) AS rank
    FROM entry_note_endpoints p
    JOIN entry_notes n ON n.key = p.key
    LEFT JOIN entry_evidence v ON v.source_id = p.source_id AND v.account_id = p.account_id
      AND v.external_id = p.external_id
    LEFT JOIN entry_identity i ON i.source_id = p.source_id AND i.account_id = p.account_id
      AND i.external_id = p.external_id
    WHERE coalesce(v.entry_id, i.entry_id) IS NOT NULL
  ) WHERE rank = 1
`

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const crypto = yield* Crypto.Crypto

  const entryExists = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ id: Schema.String }),
    execute: (id) => sql`SELECT id FROM ledger_entries WHERE id = ${id}`,
  })

  /**
   * The person's note on an entry, or null to clear it. A note keeps the
   * observations the entry has now, so it stays with the movement when the
   * entry merges or its first source goes away. Writing over a note that
   * covers this entry alone updates it in place.
   */
  const set = Effect.fn('Notes.set')(function* (
    entryId: string,
    note: string | null,
  ) {
    const text = note?.trim() ?? ''
    if (text.length > maxNoteLength)
      return yield* new NotesError({ reason: 'note_too_long', entryId })
    if (Option.isNone(yield* entryExists(entryId)))
      return yield* new NotesError({ reason: 'entry_not_found', entryId })
    const notedAt = DateTime.formatIso(yield* DateTime.now)
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const keys = covering(yield* holders('entry_note_endpoints'), entryId)
        if (text === '') {
          for (const key of keys)
            yield* sql`DELETE FROM entry_notes WHERE key = ${key}`
          return
        }
        const targets =
          keys.length > 0
            ? keys
            : [yield* crypto.randomUUIDv7.pipe(Effect.orDie)]
        for (const key of targets) {
          yield* sql`
            INSERT INTO entry_notes (key, note, noted_at, revision)
            VALUES (${key}, ${text}, ${notedAt},
              (SELECT coalesce(max(revision), 0) + 1 FROM entry_notes))
            ON CONFLICT (key) DO UPDATE SET note = excluded.note,
              noted_at = excluded.noted_at, revision = excluded.revision
          `
          yield* addEndpoints('entry_note_endpoints', key, entryId)
        }
      }),
    )
    return { entryId, note: text === '' ? null : text }
  })

  const findNote = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ note: Schema.String }),
    execute: (entryId) => sql`
      SELECT n.note FROM (${entryNotes(sql)}) n WHERE n.entry_id = ${entryId}
    `,
  })

  /** The note the entry shows, or null. */
  const of = Effect.fn('Notes.of')(function* (entryId: string) {
    return Option.getOrNull(
      Option.map(yield* findNote(entryId), (row) => row.note),
    )
  })

  return { set, of }
})

/** Writes the person's notes on entries; reads join them in `api/ReadModel.ts`. */
export class Notes extends Context.Service<
  Notes,
  Effect.Success<typeof make>
>()('@spendle/server/ledger/Notes') {
  static readonly layer = Layer.effect(Notes, make)
}
