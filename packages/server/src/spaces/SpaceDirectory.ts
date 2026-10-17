import * as SqliteClient from '@effect/sql-sqlite-node/SqliteClient'
import * as SqliteMigrator from '@effect/sql-sqlite-node/SqliteMigrator'
import * as Context from 'effect/Context'
import * as Crypto from 'effect/Crypto'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'

import { ServerConfig } from '../config.ts'
import Spaces from './Migrations/0001_spaces.ts'

// The control database has its own migrations, separate from the ones every
// space database runs. Append-only, like those.
const migrations = { '0001_spaces': Spaces }

export const Space = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  databaseFile: Schema.String,
})
export type Space = typeof Space.Type

/** A Pluggy delivery waiting to reach the spaces it belongs to. */
export const PendingWebhook = Schema.Struct({
  eventId: Schema.String,
  itemId: Schema.NullOr(Schema.String),
  payload: Schema.String,
})
export type PendingWebhook = typeof PendingWebhook.Type

export class SpaceDirectoryError extends Schema.TaggedError<SpaceDirectoryError>()(
  'SpaceDirectoryError',
  {
    reason: Schema.Literals(['already_member', 'database_claimed']),
    detail: Schema.String,
  },
) {}

const normalize = (email: string) => email.trim().toLowerCase()

const make = Effect.gen(function* () {
  const { dataDirectory, databasePath: legacyPath } = yield* ServerConfig
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const crypto = yield* Crypto.Crypto
  const inMemory = dataDirectory === ':memory:'

  if (!inMemory) yield* fs.makeDirectory(dataDirectory, { recursive: true })
  // A private client: the space services read `SqlClient` from their own
  // database, so this one never enters the shared context.
  const client = yield* Layer.build(
    SqliteClient.layer({
      filename: inMemory
        ? ':memory:'
        : path.join(dataDirectory, 'control.sqlite'),
      spanAttributes: { 'db.name': 'spendle-control' },
    }),
  )
  const sql = Context.get(client, SqlClient.SqlClient)
  yield* Effect.gen(function* () {
    yield* sql`PRAGMA foreign_keys = ON`
    yield* SqliteMigrator.run({
      loader: SqliteMigrator.fromRecord(migrations),
    })
  }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.orDie)

  const now = Effect.map(DateTime.now, DateTime.formatIso)
  const columns = sql`s.id, s.name, s.database_file AS databaseFile`

  const findByMember = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Space,
    execute: (email) => sql`
      SELECT ${columns} FROM spaces s
      JOIN space_members m ON m.space_id = s.id
      WHERE m.email = ${email}
    `,
  })
  const findById = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Space,
    execute: (id) => sql`SELECT ${columns} FROM spaces s WHERE s.id = ${id}`,
  })
  const findByFile = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Space,
    execute: (file) =>
      sql`SELECT ${columns} FROM spaces s WHERE s.database_file = ${file}`,
  })
  const findAll = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Space,
    execute: () =>
      sql`SELECT ${columns} FROM spaces s ORDER BY s.created_at, s.rowid`,
  })

  const insert = Effect.fnUntraced(function* (space: Space, owner: string) {
    const at = yield* now
    yield* sql`
      INSERT INTO spaces (id, name, database_file, created_at)
      VALUES (${space.id}, ${space.name}, ${space.databaseFile}, ${at})
    `
    yield* sql`
      INSERT INTO space_members (email, space_id, role, added_at)
      VALUES (${owner}, ${space.id}, 'owner', ${at})
    `
  })

  /**
   * The space an email belongs to. The first request of an email nobody has
   * added creates a space for it, with an empty database.
   */
  const spaceOf = Effect.fn('SpaceDirectory.spaceOf')(function* (
    email: string,
  ) {
    const member = normalize(email)
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const found = yield* findByMember(member)
        if (Option.isSome(found)) return found.value
        const id = yield* crypto.randomUUIDv7
        const space: Space = {
          id,
          name: 'Família',
          databaseFile: `spaces/${id}.sqlite`,
        }
        yield* insert(space, member)
        return space
      }),
    )
  }, Effect.orDie)

  /** Registers an existing database as a new space owned by `email`. */
  const claim = Effect.fn('SpaceDirectory.claim')(
    function* (input: {
      readonly email: string
      readonly databasePath: string
    }) {
      const owner = normalize(input.email)
      const databaseFile = fileOf(input.databasePath)
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          if (Option.isSome(yield* findByMember(owner))) {
            return yield* new SpaceDirectoryError({
              reason: 'already_member',
              detail: owner,
            })
          }
          if (Option.isSome(yield* findByFile(databaseFile))) {
            return yield* new SpaceDirectoryError({
              reason: 'database_claimed',
              detail: databaseFile,
            })
          }
          const space: Space = {
            id: yield* crypto.randomUUIDv7,
            name: 'Família',
            databaseFile,
          }
          yield* insert(space, owner)
          return space
        }),
      )
    },
    Effect.catchTag(['SqlError', 'SchemaError', 'PlatformError'], Effect.die),
  )

  const fileOf = (databasePath: string) => {
    const relative = path.relative(dataDirectory, databasePath)
    // Inside the data directory the file stays relative, so the directory
    // can move; anything else is kept as given.
    return relative.startsWith('..') || path.isAbsolute(relative)
      ? databasePath
      : relative
  }

  // Known once claimed; until then each check looks again, so a claim made
  // by `claim-space` while the server runs takes effect at once.
  let legacyClaimed = inMemory
  /**
   * The database from before spaces, while no space has claimed it. Spaces
   * are not created meanwhile: a member who signed in first would get an
   * empty space and could no longer claim their data.
   */
  const unclaimedLegacy = Effect.gen(function* () {
    if (legacyClaimed) return Option.none<string>()
    const exists = yield* fs.exists(legacyPath)
    const claimed =
      !exists || Option.isSome(yield* findByFile(fileOf(legacyPath)))
    if (claimed) legacyClaimed = true
    return claimed ? Option.none<string>() : Option.some(legacyPath)
  }).pipe(Effect.orDie)

  /** Stores a delivery once; false when its event was already received. */
  const receiveWebhook = Effect.fn('SpaceDirectory.receiveWebhook')(function* (
    delivery: PendingWebhook,
  ) {
    const at = yield* now
    const stored = yield* sql`
        INSERT INTO webhook_inbox (event_id, item_id, payload, received_at)
        VALUES (${delivery.eventId}, ${delivery.itemId}, ${delivery.payload}, ${at})
        ON CONFLICT (event_id) DO NOTHING
        RETURNING event_id
      `
    return stored.length > 0
  }, Effect.orDie)
  const findPendingWebhooks = SqlSchema.findAll({
    Request: Schema.Void,
    Result: PendingWebhook,
    execute: () => sql`
      SELECT event_id AS eventId, item_id AS itemId, payload
      FROM webhook_inbox WHERE routed_at IS NULL ORDER BY rowid
    `,
  })
  const webhookRouted = Effect.fn('SpaceDirectory.webhookRouted')(function* (
    eventId: string,
  ) {
    const at = yield* now
    yield* sql`UPDATE webhook_inbox SET routed_at = ${at} WHERE event_id = ${eventId}`
  }, Effect.orDie)

  /** Where a space's database lives; `:memory:` when the directory is in memory. */
  const databasePath = (space: Space) =>
    inMemory
      ? ':memory:'
      : path.isAbsolute(space.databaseFile)
        ? space.databaseFile
        : path.join(dataDirectory, space.databaseFile)

  return {
    /** Fails when the control database cannot answer. */
    ping: sql`SELECT 1`.pipe(Effect.asVoid),
    spaceOf,
    claim,
    unclaimedLegacy,
    space: (id: string) => findById(id).pipe(Effect.orDie),
    list: findAll(undefined).pipe(Effect.orDie),
    receiveWebhook,
    /** Deliveries not yet routed, oldest first. */
    pendingWebhooks: findPendingWebhooks(undefined).pipe(Effect.orDie),
    webhookRouted,
    databasePath,
  }
})

/** Family spaces, their members, and where each space's database lives. */
export class SpaceDirectory extends Context.Service<
  SpaceDirectory,
  Effect.Success<typeof make>
>()('@spendle/server/spaces/SpaceDirectory') {
  static readonly layer = Layer.effect(SpaceDirectory, make)
}
