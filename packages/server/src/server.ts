import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as HttpRouter from 'effect/http/HttpRouter'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
// NodeHttpServer adapts a Node server; there is no Effect equivalent to import instead.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createServer } from 'node:http'

import { ServerConfig } from './config.ts'
import { EventLog } from './events/EventLog.ts'
import * as Reactor from './events/Reactor.ts'
import { Imports } from './imports/Imports.ts'
import { Accounts } from './ledger/Accounts.ts'
import * as Entries from './ledger/Entries.ts'
import { Cards } from './reconciliation/Cards.ts'
import * as Reconciliation from './reconciliation/Reconciliation.ts'
import { Observations } from './ledger/Observations.ts'
import { OpenFinance } from './openfinance/OpenFinance.ts'
import { PluggyClient } from './openfinance/PluggyClient.ts'
import * as SyncReactor from './openfinance/SyncReactor.ts'
import * as Webhook from './openfinance/Webhook.ts'
import { WebhookConfig } from './openfinance/WebhookConfig.ts'
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

// Services every feature builds on. Feature reactors are added beside the routes.
const CoreLive = Layer.mergeAll(
  Reactor.Reactors.layer,
  Imports.layer,
  Entries.Entries.layer,
  Reconciliation.Reconciliation.layer,
  Cards.layer,
).pipe(
  Layer.provideMerge(Observations.layer),
  Layer.provideMerge(Accounts.layer),
  Layer.provideMerge(EventLog.layer),
  Layer.provideMerge(Sqlite.layer),
)

const OpenFinanceLive = Layer.mergeAll(
  Entries.reactor,
  Reconciliation.reactor,
  Reconciliation.startup,
  SyncReactor.layer,
  Webhook.reactor,
  Webhook.registration,
).pipe(
  Layer.provideMerge(OpenFinance.layer),
  Layer.provideMerge(
    PluggyClient.layer.pipe(Layer.provide(FetchHttpClient.layer)),
  ),
  Layer.provideMerge(WebhookConfig.layer),
)

const Routes = Layer.mergeAll(ApiRoutes, Webhook.routes)

export const ServerLive = HttpRouter.serve(Routes).pipe(
  Layer.provideMerge(OpenFinanceLive),
  Layer.provide(HttpServerLive),
  Layer.provide(CoreLive),
)
