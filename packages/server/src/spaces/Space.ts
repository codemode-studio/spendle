import * as Context from 'effect/Context'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as LayerMap from 'effect/LayerMap'
import * as Option from 'effect/Option'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as HttpRouter from 'effect/http/HttpRouter'

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
import * as Sqlite from '../persistence/Sqlite.ts'
import { AssistantModel } from '../planning/AssistantModel.ts'
import { PlanningServices } from '../planning/Services.ts'
import { ExchangeRates } from '../rates/ExchangeRates.ts'
import { RateSource } from '../rates/RateSource.ts'
import * as Reconciliation from '../reconciliation/Reconciliation.ts'
import { Cards } from '../reconciliation/Cards.ts'
import * as V1PlanningImport from '../v1import/PlanningImport.ts'
import * as V1Import from '../v1import/V1Import.ts'
import { SpaceDirectory } from './SpaceDirectory.ts'

// Category learning; the model is called only when `TYPESAFE_API_KEY` is set.
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
const coreLive = (databasePath: string) =>
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
    Layer.provideMerge(Sqlite.layerFile(databasePath)),
  )

// The assistant calls its model only when `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` are set.
const PlanningLive = V1PlanningImport.reactor.pipe(
  Layer.provide(V1PlanningImport.V1PlanningImport.layer),
  Layer.provideMerge(PlanningServices),
  Layer.provideMerge(
    AssistantModel.layer.pipe(Layer.provide(FetchHttpClient.layer)),
  ),
)

// The webhook route, its registration at Pluggy and the Pluggy client are
// server-wide; each space only reacts to the events routed into its log.
const OpenFinanceLive = Layer.mergeAll(
  Entries.reactor,
  Reconciliation.reactor,
  Reconciliation.startup,
  Categorizer.reactor,
  Categorizer.modelReactor,
  Categorizer.startup,
  SyncReactor.layer,
  Webhook.reactor,
  // Decisions `migrate-v1` brought over apply as their movements arrive.
  V1Import.reactor.pipe(Layer.provide(V1Import.V1Import.layer)),
).pipe(Layer.provideMerge(OpenFinance.layer))

/** Every service and reactor of one space, over the database at `databasePath`. */
export const spaceServices = (databasePath: string) =>
  Layer.mergeAll(PlanningLive, OpenFinanceLive).pipe(
    Layer.provideMerge(coreLive(databasePath)),
  )

const makeApp = HttpRouter.toHttpEffect(ApiRoutes)

/** One space's `/api/v2` routes as a handler for the current request. */
export class SpaceApp extends Context.Service<
  SpaceApp,
  Effect.Success<typeof makeApp>
>()('@spendle/server/spaces/Space/SpaceApp') {}

/** A space's services, reactors and API, over its own database. */
export const spaceLive = (databasePath: string) =>
  Layer.effect(SpaceApp, makeApp).pipe(
    Layer.provideMerge(spaceServices(databasePath)),
  )

/**
 * Builds `layer` with a memo map of its own. LayerMap shares one memo map
 * across keys, so module-level layers (`Accounts.layer`, `EventLog.layer`)
 * would otherwise be built once, over the first space's database, and reused
 * by every other space.
 */
const isolated = <A, E, R>(layer: Layer.Layer<A, E, R>) =>
  Layer.fromBuild((_shared, scope) =>
    Layer.buildWithMemoMap(layer, Layer.makeMemoMapUnsafe(), scope),
  )

/**
 * Each space's services, built on first use and kept: its reactors keep
 * working on events (webhooks, syncs) while nobody is signed in.
 */
export class SpaceApps extends LayerMap.Service<SpaceApps>()(
  '@spendle/server/spaces/Space/SpaceApps',
  {
    lookup: (spaceId: string) =>
      Layer.unwrap(
        Effect.gen(function* () {
          const directory = yield* SpaceDirectory
          const space = yield* directory.space(spaceId)
          if (Option.isNone(space)) {
            return yield* Effect.die(`Unknown space ${spaceId}`)
          }
          return isolated(spaceLive(directory.databasePath(space.value)))
        }),
      ),
    idleTimeToLive: Duration.infinity,
  },
) {}

/**
 * Runs `effect` with a space's services. A space that fails to build (its
 * database locked or unreadable) is dropped from the map, so the next use
 * builds it again instead of repeating the failure until a restart.
 */
export const withSpace = <A, E, R>(
  spaceId: string,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.void.pipe(
    Effect.provide(SpaceApps.get(spaceId)),
    Effect.tapCause(() => SpaceApps.invalidate(spaceId)),
    Effect.andThen(effect.pipe(Effect.provide(SpaceApps.get(spaceId)))),
  )

/** Builds every known space at startup so their reactors run from the start. */
export const warmSpaces = Layer.effectDiscard(
  Effect.gen(function* () {
    const directory = yield* SpaceDirectory
    const spaces = yield* directory.list
    yield* Effect.forEach(
      spaces,
      (space) =>
        withSpace(space.id, Effect.void).pipe(
          Effect.catchCause((cause) =>
            Effect.logError(`Space ${space.id} failed to start`, cause),
          ),
        ),
      { discard: true },
    )
  }),
)
