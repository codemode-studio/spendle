import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Redacted from 'effect/Redacted'
import * as Ref from 'effect/Ref'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import * as HttpRouter from 'effect/http/HttpRouter'
import * as HttpApiClient from 'effect/http-api/HttpApiClient'
import * as SqlClient from 'effect/sql/SqlClient'

import { ApiConfig } from '../api/ApiConfig.ts'
import { SpendleApi } from '../api/definition/Api.ts'
import { memberHeader } from '../api/definition/Security.ts'
import { ServerConfig } from '../config.ts'
import type { ServerConfigShape } from '../config.ts'
import { EventLog } from '../events/EventLog.ts'
import { Accounts } from '../ledger/Accounts.ts'
import { OpenFinance } from '../openfinance/OpenFinance.ts'
import { PluggyClient } from '../openfinance/PluggyClient.ts'
import { webhookReceived } from '../openfinance/Webhook.ts'
import { WebhookConfig } from '../openfinance/WebhookConfig.ts'
import * as Sqlite from '../persistence/Sqlite.ts'
import { FakePluggyState, makeFake } from '../testing/FakePluggy.ts'
import type { FakePluggyData } from '../testing/FakePluggy.ts'
import { rawJson } from '../testing/ApiTest.ts'
import { routeWebhook, spaceRoutes, webhookRoutes } from './Routes.ts'
import { SpaceApps } from './Space.ts'
import type { Space } from './SpaceDirectory.ts'
import { SpaceDirectory } from './SpaceDirectory.ts'

const token = 'a-local-token-long-enough-to-count-0123456789'
const secret = 'whsec-0123456789abcdef0123456789abcdef'

const fakePluggy = Layer.unwrap(
  Effect.gen(function* () {
    const state = yield* Ref.make<FakePluggyData>({
      clientUserId: '',
      accounts: [],
      transactions: {},
      deleted: [],
      webhooks: [],
      connectTokens: [],
    })
    return Layer.mergeAll(
      Layer.succeed(PluggyClient, makeFake(state)),
      Layer.succeed(FakePluggyState, state),
    )
  }),
)

// The multi-space server over a real socket, every space in memory.
const spacesTest = (
  options: {
    readonly token?: string
    readonly config?: Partial<ServerConfigShape>
  } = {},
) =>
  HttpRouter.serve(Layer.mergeAll(spaceRoutes, webhookRoutes), {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(
    Layer.provideMerge(SpaceApps.layer),
    Layer.provideMerge(SpaceDirectory.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        ApiConfig.layerTest(options.token),
        WebhookConfig.layerTest(
          Option.some({
            url: 'https://spendle.example/api/pluggy/webhook',
            secret: Redacted.make(secret),
          }),
        ),
        fakePluggy,
        ServerConfig.layerTest(options.config),
      ),
    ),
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provideMerge(NodeServices.layer),
  )

// The typed client the web server uses, naming `email` as the member.
const clientFor = (email: string, bearer?: string) =>
  HttpApiClient.make(SpendleApi, {
    transformClient: HttpClient.mapRequest((request) => {
      const named = HttpClientRequest.setHeader(request, memberHeader, email)
      return bearer === undefined
        ? named
        : HttpClientRequest.bearerToken(named, bearer)
    }),
  })

const inSpace = <A, E, R>(space: Space, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(SpaceApps.get(space.id)))

const webhookCount = (space: Space) =>
  inSpace(
    space,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{ readonly count: number }>`
        SELECT count(*) AS count FROM domain_events WHERE type = ${webhookReceived}
      `
      return rows[0]?.count ?? 0
    }),
  )

const deliver = (body: object) =>
  routeWebhook({
    authorization: `Bearer ${secret}`,
    body: JSON.stringify(body),
  })

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
      const response = yield* rawJson(HttpClientRequest.get('/api/v2/owners'))
      assert.deepStrictEqual(response, {
        status: 401,
        body: { _tag: 'Unauthorized', reason: 'member_required', detail: null },
      })
    }).pipe(Effect.provide(spacesTest())),
  )

  it.effect('checks the token before creating a space', () =>
    Effect.gen(function* () {
      const missing = yield* rawJson(
        HttpClientRequest.get('/api/v2/owners').pipe(
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
        HttpClientRequest.get('/api/v2/health'),
      )
      const document = yield* rawJson(
        HttpClientRequest.get('/api/v2/openapi.json'),
      )
      assert.deepStrictEqual([health.status, document.status], [204, 200])
    }).pipe(Effect.provide(spacesTest({ token }))),
  )
})

describe('Pluggy webhooks across spaces', () => {
  // Two spaces; Ana's has a pending connection that Pluggy's item names.
  const twoSpaces = Effect.gen(function* () {
    const directory = yield* SpaceDirectory
    const ana = yield* directory.spaceOf('ana@example.com')
    const beto = yield* directory.spaceOf('beto@example.com')
    const connectionId = yield* inSpace(
      ana,
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

        assert.strictEqual(answer.status, 202)
        assert.deepStrictEqual(
          [yield* webhookCount(ana), yield* webhookCount(beto)],
          [1, 0],
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

        assert.deepStrictEqual(
          [yield* webhookCount(ana), yield* webhookCount(beto)],
          [1, 1],
        )
      }).pipe(Effect.provide(spacesTest())),
  )
})
