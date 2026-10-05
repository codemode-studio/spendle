import { describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as HttpServer from 'effect/http/HttpServer'
import * as HttpApiTest from 'effect/http-api/HttpApiTest'

import * as Sqlite from '../persistence/Sqlite.ts'
import { Api } from './Api.ts'
import { SystemHandlers } from './System.ts'

describe('SystemApi', () => {
  it.effect('reports healthy when the database answers', () =>
    Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(Api, ['system'])
      yield* client.health()
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          SystemHandlers.pipe(Layer.provide(Sqlite.layerMemory)),
          HttpServer.layerServices,
        ),
      ),
    ),
  )
})
