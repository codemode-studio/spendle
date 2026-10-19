import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import * as Ref from 'effect/Ref'
import * as SqlClient from 'effect/sql/SqlClient'

import { Accounts } from '../ledger/Accounts.ts'
import { OpenFinance } from '../openfinance/OpenFinance.ts'
import { webhookReceived } from '../openfinance/Webhook.ts'
import * as Sqlite from '../persistence/Sqlite.ts'
import { FakePluggyState } from '../testing/FakePluggy.ts'
import { spacesTest, webhookSecret } from '../testing/SpacesTest.ts'
import { withSpace } from './LocalSpaces.ts'
import type { Space } from './SpaceDirectory.ts'
import { SpaceDirectory } from './SpaceDirectory.ts'
import { SpaceWebhooks } from './SpaceWebhooks.ts'

const deliver = (body: object) =>
  SpaceWebhooks.use((webhooks) =>
    webhooks.accept({
      authorization: `Bearer ${webhookSecret}`,
      body: JSON.stringify(body),
    }),
  )

const drain = SpaceWebhooks.use((webhooks) => webhooks.drain)

const storedIn = (space: Space) =>
  withSpace(
    space.id,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{ readonly count: number }>`
        SELECT count(*) AS count FROM domain_events WHERE type = ${webhookReceived}
      `
      return rows[0]?.count ?? 0
    }),
  )

// Two spaces; Ana's has a pending connection that Pluggy's item names.
const twoSpaces = Effect.gen(function* () {
  const directory = yield* SpaceDirectory
  const ana = yield* directory.spaceOf('ana@example.com')
  const beto = yield* directory.spaceOf('beto@example.com')
  const connectionId = yield* withSpace(
    ana.id,
    Effect.gen(function* () {
      const owner = yield* (yield* Accounts).createOwner({
        name: 'Ana',
        kind: 'person',
      })
      const openFinance = yield* OpenFinance
      return (yield* openFinance.createConnectToken({ ownerId: owner.id }))
        .connectionId
    }),
  )
  const state = yield* FakePluggyState
  yield* Ref.update(state, (current) => ({
    ...current,
    clientUserId: connectionId,
  }))
  return { ana, beto }
})

describe('Pluggy webhooks across spaces', () => {
  it.effect(
    'stores an item event only in the space that requested the item',
    () =>
      Effect.gen(function* () {
        const { ana, beto } = yield* twoSpaces
        const answer = yield* deliver({
          eventId: 'event-1',
          event: 'item/created',
          itemId: 'item-1',
        })
        yield* drain

        assert.strictEqual(answer.status, 202)
        assert.deepStrictEqual(
          [yield* storedIn(ana), yield* storedIn(beto)],
          [1, 0],
        )
        assert.deepStrictEqual(
          yield* SpaceDirectory.use((directory) => directory.pendingWebhooks),
          [],
        )
      }).pipe(Effect.provide(spacesTest())),
  )

  it.effect(
    'keeps deletions in every space and drops events without an item',
    () =>
      Effect.gen(function* () {
        const { ana, beto } = yield* twoSpaces
        yield* deliver({
          eventId: 'event-2',
          event: 'item/deleted',
          itemId: 'x',
        })
        yield* deliver({
          eventId: 'event-3',
          event: 'connector/status_updated',
        })
        yield* drain

        assert.deepStrictEqual(
          [yield* storedIn(ana), yield* storedIn(beto)],
          [1, 1],
        )
      }).pipe(Effect.provide(spacesTest())),
  )

  it.effect('drops an event for an item Pluggy no longer has', () =>
    Effect.gen(function* () {
      const { ana, beto } = yield* twoSpaces
      const state = yield* FakePluggyState
      yield* Ref.update(state, (current) => ({
        ...current,
        deleted: [...current.deleted, 'x'],
      }))
      yield* deliver({ eventId: 'event-6', event: 'item/updated', itemId: 'x' })
      yield* drain

      assert.deepStrictEqual(
        [yield* storedIn(ana), yield* storedIn(beto)],
        [0, 0],
      )
      assert.deepStrictEqual(
        yield* SpaceDirectory.use((directory) => directory.pendingWebhooks),
        [],
      )
    }).pipe(Effect.provide(spacesTest())),
  )

  it.effect('accepts a retried delivery once', () =>
    Effect.gen(function* () {
      const event = { eventId: 'event-4', event: 'item/deleted', itemId: 'x' }
      const first = yield* deliver(event)
      const retry = yield* deliver(event)

      assert.deepStrictEqual(
        [first.body, retry.body],
        [
          { accepted: true, duplicate: false },
          { accepted: true, duplicate: true },
        ],
      )
    }).pipe(Effect.provide(spacesTest())),
  )

  it.effect(
    'holds deliveries until the data from before spaces is claimed',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dataDirectory = yield* fs.makeTempDirectoryScoped()
        const databasePath = path.join(dataDirectory, 'spendle.sqlite')
        // A database from before spaces, with nothing in it yet.
        yield* Effect.void.pipe(Effect.provide(Sqlite.layerFile(databasePath)))

        yield* Effect.gen(function* () {
          const directory = yield* SpaceDirectory
          yield* deliver({
            eventId: 'event-5',
            event: 'item/deleted',
            itemId: 'x',
          })
          yield* drain
          const waiting = yield* directory.pendingWebhooks

          const space = yield* directory.claim({
            email: 'ana@example.com',
            databasePath,
          })
          yield* drain

          assert.deepStrictEqual(
            waiting.map((pending) => pending.eventId),
            ['event-5'],
          )
          assert.strictEqual(yield* storedIn(space), 1)
          assert.deepStrictEqual(yield* directory.pendingWebhooks, [])
        }).pipe(
          Effect.provide(
            spacesTest({ config: { dataDirectory, databasePath } }),
          ),
        )
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})
