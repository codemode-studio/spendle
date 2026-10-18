import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as HttpRouter from 'effect/http/HttpRouter'
// NodeHttpServer adapts a Node server; there is no Effect equivalent to import instead.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createServer } from 'node:http'

import { ApiConfig } from './api/ApiConfig.ts'
import { ServerConfig } from './config.ts'
import { PluggyClient } from './openfinance/PluggyClient.ts'
import * as Webhook from './openfinance/Webhook.ts'
import { WebhookConfig } from './openfinance/WebhookConfig.ts'
import { memberRoutes } from './spaces/Members.ts'
import { spaceRoutes } from './spaces/Routes.ts'
import { SpaceApps, warmSpaces } from './spaces/Space.ts'
import { SpaceDirectory } from './spaces/SpaceDirectory.ts'
import { SpaceWebhooks, webhookRoutes } from './spaces/SpaceWebhooks.ts'

const HttpServerLive = Layer.unwrap(
  Effect.gen(function* () {
    const { host, port } = yield* ServerConfig
    return NodeHttpServer.layer(createServer, { host, port })
  }),
)

// What the whole server shares; each space builds its own services on top.
const SharedLive = Layer.mergeAll(
  ApiConfig.layer,
  WebhookConfig.layer,
  PluggyClient.layer.pipe(Layer.provide(FetchHttpClient.layer)),
)

/**
 * One API for every family space: `/api` serves the signed-in member's
 * space, and Pluggy's webhook reaches the spaces its items belong to.
 */
export const ServerLive = HttpRouter.serve(
  Layer.mergeAll(spaceRoutes, memberRoutes, webhookRoutes),
).pipe(
  Layer.provideMerge(Layer.mergeAll(warmSpaces, Webhook.registration)),
  Layer.provideMerge(SpaceWebhooks.layer),
  Layer.provideMerge(SpaceApps.layer),
  Layer.provideMerge(SpaceDirectory.layer),
  Layer.provideMerge(SharedLive),
  Layer.provide(HttpServerLive),
)
