import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import * as HttpRouter from 'effect/http/HttpRouter'
import * as HttpApiClient from 'effect/http-api/HttpApiClient'

import { ApiConfig } from '../api/ApiConfig.ts'
import { SpendleApi } from '../api/definition/Api.ts'
import { ApiRoutes } from '../api/Routes.ts'
import { categoriesTest } from './FakePluggy.ts'

/**
 * The API served over a real socket, with every service, reactor and a fake
 * Pluggy behind it. Tests call it with `apiClient` or a raw `HttpClient`.
 */
export const apiTest = (options: { readonly token?: string } = {}) =>
  HttpRouter.serve(ApiRoutes, {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(
    Layer.provideMerge(ApiConfig.layerTest(options.token)),
    Layer.provideMerge(categoriesTest()),
    Layer.provideMerge(NodeHttpServer.layerTest),
  )

/** The typed client a web app derives from `SpendleApi`, optionally sending a token. */
export const apiClient = (token?: string) =>
  HttpApiClient.make(SpendleApi, {
    transformClient: (client) =>
      token === undefined
        ? client
        : HttpClient.mapRequest(client, HttpClientRequest.bearerToken(token)),
  })

/** The raw JSON a request answers, with its status. */
export const rawJson = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const response = yield* HttpClient.execute(request)
    return { status: response.status, body: yield* response.json }
  })
