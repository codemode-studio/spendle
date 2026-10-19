import * as SqliteClient from '@effect/sql-sqlite-node/SqliteClient'
import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import * as HttpApiClient from 'effect/http-api/HttpApiClient'

import { SpendleApi } from '../api/definition/Api.ts'
import { memberHeader } from '../api/definition/Security.ts'
import { makeControlObject } from './ControlObject.ts'
import { makeSpaceObject } from './SpaceObject.ts'
import type { SpaceObject } from './SpaceObject.ts'

// The objects as the Worker wires them, each over its own in-memory SQLite
// database instead of a Durable Object's storage, with every space reached
// through Web requests the way a Durable Object stub carries them.
const objects = Effect.acquireRelease(
  Effect.sync(() => {
    const spaces = new Map<string, SpaceObject>()
    const space = (spaceId: string) => {
      let object = spaces.get(spaceId)
      if (object === undefined) {
        object = makeSpaceObject(SqliteClient.layer({ filename: ':memory:' }))
        spaces.set(spaceId, object)
      }
      return object
    }
    const control = makeControlObject(
      SqliteClient.layer({ filename: ':memory:' }),
      {
        fetch: (spaceId, request) => space(spaceId).fetch(request),
        holdsItem: (spaceId, itemId) => space(spaceId).holdsItem(itemId),
        hasConnection: (spaceId, connectionId) =>
          space(spaceId).hasConnection(connectionId),
        storeWebhook: (spaceId, body) => space(spaceId).storeWebhook(body),
      },
    )
    return { control, spaces }
  }),
  ({ control, spaces }) =>
    Effect.promise(() =>
      Promise.all([
        control.dispose(),
        ...[...spaces.values()].map((object) => object.dispose()),
      ]),
    ),
)

// The typed client the web app uses, sending every request to the control object.
const clientFor = (
  control: { readonly fetch: (request: Request) => Promise<Response> },
  email: string,
) =>
  HttpApiClient.make(SpendleApi, {
    transformClient: HttpClient.mapRequest((request) =>
      request.pipe(
        HttpClientRequest.prependUrl('https://api.spendle.internal'),
        HttpClientRequest.setHeader(memberHeader, email),
      ),
    ),
  }).pipe(
    Effect.provide(
      FetchHttpClient.layer.pipe(
        Layer.provideMerge(
          Layer.succeed(FetchHttpClient.Fetch, (input, init) =>
            control.fetch(new Request(input, init)),
          ),
        ),
      ),
    ),
  )

describe('Durable Object runtimes', () => {
  it.effect("serve each member's space and import an uploaded statement", () =>
    Effect.gen(function* () {
      const { control, spaces } = yield* objects
      const ana = yield* clientFor(control, 'ana@example.com')
      const beto = yield* clientFor(control, 'beto@example.com')

      const owner = yield* ana.owners.create({
        payload: { name: 'Ana', kind: 'person' },
      })
      const account = yield* ana.accounts.open({
        payload: {
          ownerId: owner.id,
          institutionName: 'Nubank',
          name: 'Nubank',
          kind: 'checking',
          purpose: 'operating',
          currency: 'BRL',
        },
      })
      // The upload crosses both objects as multipart and is parsed in memory.
      const data = new FormData()
      data.append('accountId', account.id)
      data.append(
        'file',
        new Blob([
          `OFXHEADER:100\nCHARSET:UTF-8\n\n<OFX><MSGS><STMTRS><CURDEF>BRL<BANKTRANLIST><STMTTRN><DTPOSTED>20260910<TRNAMT>-80.00<FITID>n1<MEMO>Mercado</STMTTRN></BANKTRANLIST></STMTRS></MSGS></OFX>`,
        ]),
        'nubank.ofx',
      )
      yield* ana.imports.upload({ payload: data })
      for (const space of spaces.values()) yield* Effect.promise(space.drain)

      const entries = yield* ana.entries.list({ query: {} })
      assert.deepStrictEqual(
        entries.entries.map((entry) => [entry.description, entry.amountCents]),
        [['Mercado', -8000]],
      )
      // Beto's first request creates a space of his own, in another object.
      assert.deepStrictEqual(yield* beto.owners.list(), [])
      assert.strictEqual(spaces.size, 2)
    }).pipe(Effect.scoped),
  )
})
