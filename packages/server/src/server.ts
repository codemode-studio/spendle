import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as HttpRouter from 'effect/http/HttpRouter'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
// NodeHttpServer adapts a Node server; there is no Effect equivalent to import instead.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createServer } from 'node:http'

import { ServerConfig } from './config.ts'
import { Api } from './http/Api.ts'
import { SystemHandlers } from './http/System.ts'
import * as Sqlite from './persistence/Sqlite.ts'

export const ApiRoutes = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(SystemHandlers),
)

const HttpServerLive = Layer.unwrap(
  Effect.gen(function* () {
    const { port } = yield* ServerConfig
    return NodeHttpServer.layer(createServer, { port })
  }),
)

export const ServerLive = HttpRouter.serve(ApiRoutes).pipe(
  Layer.provide(HttpServerLive),
  Layer.provide(Sqlite.layer),
)
