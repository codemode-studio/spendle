import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'

import { memberHeader } from '../api/definition/Security.ts'
import { EventLog } from '../events/EventLog.ts'
import { Accounts } from '../ledger/Accounts.ts'
import * as Sqlite from '../persistence/Sqlite.ts'
import { rawJson } from '../testing/ApiTest.ts'
import { clientFor, spacesTest } from '../testing/SpacesTest.ts'
import { SpaceDirectory } from './SpaceDirectory.ts'

const token = 'a-local-token-long-enough-to-count-0123456789'

describe('family spaces API', () => {
  it.effect("serves each member only their own space's data", () =>
    Effect.gen(function* () {
      const ana = yield* clientFor('ana@example.com')
      const beto = yield* clientFor('beto@example.com')
      yield* ana.owners.create({ payload: { name: 'Ana', kind: 'person' } })

      const anasOwners = yield* (yield* clientFor(' ANA@example.com')).owners
        .list()
        .pipe(Effect.map((owners) => owners.map((owner) => owner.name)))
      const betosOwners = yield* beto.owners.list()

      assert.deepStrictEqual(anasOwners, ['Ana'])
      assert.deepStrictEqual(betosOwners, [])
    }).pipe(Effect.provide(spacesTest())),
  )

  it.effect('refuses a call without a member', () =>
    Effect.gen(function* () {
      const response = yield* rawJson(HttpClientRequest.get('/api/owners'))
      assert.deepStrictEqual(response, {
        status: 401,
        body: { _tag: 'Unauthorized', reason: 'member_required', detail: null },
      })
    }).pipe(Effect.provide(spacesTest())),
  )

  it.effect('checks the token before creating a space', () =>
    Effect.gen(function* () {
      const missing = yield* rawJson(
        HttpClientRequest.get('/api/owners').pipe(
          HttpClientRequest.setHeader(memberHeader, 'ana@example.com'),
        ),
      )
      const spacesBefore = yield* SpaceDirectory.use(
        (directory) => directory.list,
      )
      const owners = yield* (yield* clientFor(
        'ana@example.com',
        token,
      )).owners.list()

      assert.strictEqual(missing.status, 401)
      assert.deepStrictEqual(spacesBefore, [])
      assert.deepStrictEqual(owners, [])
    }).pipe(Effect.provide(spacesTest({ token }))),
  )

  it.effect(
    'creates no space until the database from before spaces is claimed',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dataDirectory = yield* fs.makeTempDirectoryScoped()
        const databasePath = path.join(dataDirectory, 'spendle.sqlite')
        // The data people had before spaces existed.
        yield* Accounts.use((accounts) =>
          accounts.createOwner({ name: 'Antes', kind: 'household' }),
        ).pipe(
          Effect.provide(
            Accounts.layer.pipe(
              Layer.provideMerge(EventLog.layer),
              Layer.provideMerge(Sqlite.layerFile(databasePath)),
            ),
          ),
        )

        yield* Effect.gen(function* () {
          const ana = yield* clientFor('ana@example.com')
          const waiting = yield* ana.owners.list().pipe(Effect.flip)
          const spacesWhileWaiting = yield* SpaceDirectory.use(
            (directory) => directory.list,
          )
          yield* SpaceDirectory.use((directory) =>
            directory.claim({ email: 'ana@example.com', databasePath }),
          )
          const anasOwners = yield* ana.owners.list()
          const betosOwners = yield* (yield* clientFor(
            'beto@example.com',
          )).owners.list()

          assert.strictEqual(
            waiting._tag === 'Unavailable' ? waiting.reason : waiting._tag,
            'unclaimed_database',
          )
          assert.deepStrictEqual(spacesWhileWaiting, [])
          assert.deepStrictEqual(
            anasOwners.map((owner) => owner.name),
            ['Antes'],
          )
          assert.deepStrictEqual(betosOwners, [])
        }).pipe(
          Effect.provide(
            spacesTest({ config: { dataDirectory, databasePath } }),
          ),
        )
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.effect('answers health and the OpenAPI document without a member', () =>
    Effect.gen(function* () {
      const health = yield* HttpClient.execute(
        HttpClientRequest.get('/api/health'),
      )
      const document = yield* rawJson(
        HttpClientRequest.get('/api/openapi.json'),
      )
      assert.deepStrictEqual([health.status, document.status], [204, 200])
    }).pipe(Effect.provide(spacesTest({ token }))),
  )
})
