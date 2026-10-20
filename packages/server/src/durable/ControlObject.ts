import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Option from 'effect/Option'
import * as HttpMiddleware from 'effect/http/HttpMiddleware'
import * as HttpRouter from 'effect/http/HttpRouter'
import type * as SqlClient from 'effect/sql/SqlClient'

import { Deployment, oncePerDeployment } from '../events/Startup.ts'
import * as Webhook from '../openfinance/Webhook.ts'
import { memberRoutes } from '../spaces/Members.ts'
import { spaceRoutes } from '../spaces/Routes.ts'
import { SpaceDirectory } from '../spaces/SpaceDirectory.ts'
import { SpaceGateway } from '../spaces/SpaceGateway.ts'
import type { RemoteSpaces } from '../spaces/SpaceGateway.ts'
import { SpaceWebhooks, webhookRoutes } from '../spaces/SpaceWebhooks.ts'
import * as Platform from './Platform.ts'

const makeApp = HttpRouter.toHttpEffect(
  Layer.mergeAll(spaceRoutes, memberRoutes, webhookRoutes),
)

class ControlApp extends Context.Service<
  ControlApp,
  Effect.Success<typeof makeApp>
>()('@spendle/server/durable/ControlObject/ControlApp') {}

/**
 * The server's front door as a Durable Object: the same routes the Node
 * server answers (each space's `/api`, `/api/space` and Pluggy's webhook),
 * over the control database in the object's storage. Spaces answer in their
 * own objects, reached through `spaces`.
 */
export const makeControlObject = <E>(
  database: Layer.Layer<SqlClient.SqlClient, E>,
  spaces: RemoteSpaces,
  /** The Worker version, so startup work runs once per deployment. */
  deployment?: string,
) => {
  const runtime = ManagedRuntime.make(
    Layer.effect(ControlApp, makeApp).pipe(
      // Pluggy keeps one subscription per URL; a new deployment may bring a
      // new URL or secret, so each one refreshes it once.
      Layer.provideMerge(
        Webhook.registrationWith(
          oncePerDeployment('pluggy-webhook', Webhook.subscribe),
        ),
      ),
      Layer.provideMerge(SpaceWebhooks.layer),
      Layer.provideMerge(SpaceGateway.remote(spaces)),
      Layer.provideMerge(SpaceDirectory.layerClient),
      Layer.provideMerge(database),
      Layer.provideMerge(Platform.layer),
      Layer.provideMerge(
        Layer.succeed(Deployment, Option.fromNullishOr(deployment)),
      ),
    ),
  )
  const handler = runtime
    .context()
    .then((context) =>
      Platform.webHandler(
        context,
        Context.get(context, ControlApp),
        HttpMiddleware.logger,
      ),
    )
  return {
    fetch: async (request: Request) => (await handler)(request),
    /** Routes every delivery it can; true when some still wait for a retry. */
    drainWebhooks: () =>
      runtime.runPromise(
        Effect.gen(function* () {
          yield* SpaceWebhooks.use((webhooks) => webhooks.drain)
          const directory = yield* SpaceDirectory
          return (yield* directory.pendingWebhooks).length > 0
        }),
      ),
    dispose: () => runtime.dispose(),
  }
}

export type ControlObject = ReturnType<typeof makeControlObject>
