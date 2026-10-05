import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as HttpRouter from 'effect/http/HttpRouter'
// NodeHttpServer adapts a Node server; there is no Effect equivalent to import instead.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createServer } from 'node:http'

import { ApiConfig } from './api/ApiConfig.ts'
import { ApiRoutes } from './api/Routes.ts'
import { Categories } from './categories/Categories.ts'
import * as Categorizer from './categories/Categorizer.ts'
import { Classifier } from './categories/Classifier.ts'
import { KnowledgeStore } from './categories/KnowledgeStore.ts'
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
import * as Sqlite from './persistence/Sqlite.ts'
import { AssistantModel } from './planning/AssistantModel.ts'
import { PlanningServices } from './planning/Services.ts'
import * as V1PlanningImport from './v1import/PlanningImport.ts'
import * as V1Import from './v1import/V1Import.ts'

const HttpServerLive = Layer.unwrap(
  Effect.gen(function* () {
    const { host, port } = yield* ServerConfig
    return NodeHttpServer.layer(createServer, { host, port })
  }),
)

// Category learning; the model is called only when `TYPESAFE_API_KEY` is set.
const CategoriesLive = Categorizer.Categorizer.layer.pipe(
  Layer.provideMerge(KnowledgeStore.layer),
  Layer.provideMerge(Categories.layer),
  Layer.provideMerge(
    Classifier.layer.pipe(Layer.provide(FetchHttpClient.layer)),
  ),
)

// Services every feature builds on. Feature reactors are added beside the routes.
const CoreLive = Layer.mergeAll(
  Reactor.Reactors.layer,
  Imports.layer,
  Entries.Entries.layer,
  Reconciliation.Reconciliation.layer,
  Cards.layer,
  CategoriesLive,
).pipe(
  Layer.provideMerge(Observations.layer),
  Layer.provideMerge(Accounts.layer),
  Layer.provideMerge(EventLog.layer),
  Layer.provideMerge(Sqlite.layer),
)

// The assistant calls its model only when `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` are set.
const PlanningLive = V1PlanningImport.reactor.pipe(
  Layer.provide(V1PlanningImport.V1PlanningImport.layer),
  Layer.provideMerge(PlanningServices),
  Layer.provideMerge(
    AssistantModel.layer.pipe(Layer.provide(FetchHttpClient.layer)),
  ),
)

const OpenFinanceLive = Layer.mergeAll(
  Entries.reactor,
  Reconciliation.reactor,
  Reconciliation.startup,
  Categorizer.reactor,
  Categorizer.modelReactor,
  Categorizer.startup,
  SyncReactor.layer,
  Webhook.reactor,
  Webhook.registration,
  // Decisions `migrate-v1` brought over apply as their movements arrive.
  V1Import.reactor.pipe(Layer.provide(V1Import.V1Import.layer)),
).pipe(
  Layer.provideMerge(OpenFinance.layer),
  Layer.provideMerge(
    PluggyClient.layer.pipe(Layer.provide(FetchHttpClient.layer)),
  ),
  Layer.provideMerge(WebhookConfig.layer),
)

const Routes = Layer.mergeAll(
  ApiRoutes.pipe(Layer.provide(ApiConfig.layer)),
  Webhook.routes,
)

export const ServerLive = HttpRouter.serve(Routes).pipe(
  Layer.provideMerge(PlanningLive),
  Layer.provideMerge(OpenFinanceLive),
  Layer.provide(HttpServerLive),
  Layer.provide(CoreLive),
)
