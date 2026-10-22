import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as HttpRouter from 'effect/http/HttpRouter'
import type * as SqlClient from 'effect/sql/SqlClient'

import { ApiRoutes } from '../api/Routes.ts'
import { Categories } from '../categories/Categories.ts'
import * as Categorizer from '../categories/Categorizer.ts'
import { Classifier } from '../categories/Classifier.ts'
import { KnowledgeStore } from '../categories/KnowledgeStore.ts'
import { EventLog } from '../events/EventLog.ts'
import * as Reactor from '../events/Reactor.ts'
import { Imports } from '../imports/Imports.ts'
import { Investments } from '../investments/Investments.ts'
import { Accounts } from '../ledger/Accounts.ts'
import * as Entries from '../ledger/Entries.ts'
import { ManualEntries } from '../ledger/Manual.ts'
import { Notes } from '../ledger/Notes.ts'
import { Observations } from '../ledger/Observations.ts'
import { OpenFinance } from '../openfinance/OpenFinance.ts'
import * as SyncReactor from '../openfinance/SyncReactor.ts'
import * as Webhook from '../openfinance/Webhook.ts'
import { AssistantModel } from '../planning/AssistantModel.ts'
import { PlanningServices } from '../planning/Services.ts'
import { ExchangeRates } from '../rates/ExchangeRates.ts'
import { RateSource } from '../rates/RateSource.ts'
import * as Reconciliation from '../reconciliation/Reconciliation.ts'
import { Cards } from '../reconciliation/Cards.ts'

// Category learning; the model is called only when `OPENROUTER_API_KEY` is set.
const CategoriesLive = Categorizer.Categorizer.layer.pipe(
  Layer.provideMerge(KnowledgeStore.layer),
  Layer.provideMerge(Categories.layer),
  Layer.provideMerge(
    Classifier.layer.pipe(Layer.provide(FetchHttpClient.layer)),
  ),
)

// Exchange rates to reais (PTAX, cached in the database) for every value in another currency.
const RatesLive = ExchangeRates.layer.pipe(
  Layer.provide(RateSource.layer.pipe(Layer.provide(FetchHttpClient.layer))),
)

// What the person types in, and investment positions.
const PersonLive = Layer.mergeAll(ManualEntries.layer, Investments.layer).pipe(
  Layer.provideMerge(Notes.layer),
  Layer.provideMerge(RatesLive),
)

// Services every feature builds on, over the space's database. Feature
// reactors are added beside them.
const coreLive = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) =>
  PersonLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Reactor.Reactors.layer,
        Imports.layer,
        Entries.Entries.layer,
        Reconciliation.Reconciliation.layer,
        Cards.layer,
        CategoriesLive,
      ),
    ),
    Layer.provideMerge(Observations.layer),
    Layer.provideMerge(Accounts.layer),
    Layer.provideMerge(EventLog.layer),
    Layer.provideMerge(database),
  )

// The assistant calls its model only when `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` are set.
const PlanningLive = PlanningServices.pipe(
  Layer.provideMerge(
    AssistantModel.layer.pipe(Layer.provide(FetchHttpClient.layer)),
  ),
)

// The webhook route, its registration at Pluggy and the Pluggy client are
// server-wide; each space only reacts to the events routed into its log.
const OpenFinanceLive = Layer.mergeAll(
  Entries.reactor,
  Entries.startup,
  Reconciliation.reactor,
  Reconciliation.startup,
  Categorizer.reactor,
  Categorizer.modelReactor,
  Categorizer.startup,
  SyncReactor.layer,
  Webhook.reactor,
).pipe(Layer.provideMerge(OpenFinance.layer))

/**
 * Every service and reactor of one space, over `database`: a file through
 * `Sqlite.layerFile`, or a Durable Object's storage through `Database.layerClient`.
 */
export const spaceServices = <E, R>(
  database: Layer.Layer<SqlClient.SqlClient, E, R>,
) =>
  Layer.mergeAll(PlanningLive, OpenFinanceLive).pipe(
    Layer.provideMerge(coreLive(database)),
  )

const makeApp = HttpRouter.toHttpEffect(ApiRoutes)

/** One space's `/api` routes as a handler for the current request. */
export class SpaceApp extends Context.Service<
  SpaceApp,
  Effect.Success<typeof makeApp>
>()('@spendle/server/spaces/Space/SpaceApp') {}

/** A space's services, reactors and API, over its own database. */
export const spaceLive = <E, R>(
  database: Layer.Layer<SqlClient.SqlClient, E, R>,
) =>
  Layer.effect(SpaceApp, makeApp).pipe(
    Layer.provideMerge(spaceServices(database)),
  )
