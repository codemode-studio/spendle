import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as Result from 'effect/Result'
import * as HttpRouter from 'effect/http/HttpRouter'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import * as OpenApi from 'effect/http-api/OpenApi'

import { ApiConfig } from '../api/ApiConfig.ts'
import { SpendleApi } from '../api/definition/Api.ts'
import { memberHeader } from '../api/definition/Security.ts'
import { OpenFinance } from '../openfinance/OpenFinance.ts'
import { PluggyClient } from '../openfinance/PluggyClient.ts'
import * as Webhook from '../openfinance/Webhook.ts'
import type { PluggyWebhook } from '../openfinance/Webhook.ts'
import { SpaceApp, SpaceApps } from './Space.ts'
import type { Space } from './SpaceDirectory.ts'
import { SpaceDirectory } from './SpaceDirectory.ts'

const openApi = OpenApi.fromApi(SpendleApi)

// Same body as the API's `Unauthorized` error, so the typed client decodes it.
const unauthorized = (reason: string) =>
  HttpServerResponse.jsonUnsafe(
    { _tag: 'Unauthorized', reason, detail: null },
    { status: 401 },
  )

/**
 * `/api/v2/*`: checks the token, then serves the request from the space of
 * the member the web server names. The token comes first so an unauthorized
 * caller cannot create spaces.
 */
export const spaceRoutes = HttpRouter.use(
  Effect.fn(function* (router) {
    // Both answer without a token or a member, as they did before spaces:
    // a supervisor probes health, and the document describes every space.
    yield* router.add(
      'GET',
      '/api/v2/health',
      SpaceDirectory.use((directory) => directory.ping).pipe(
        Effect.as(HttpServerResponse.empty({ status: 204 })),
        Effect.catchCause((cause) =>
          Effect.logError('health check failed', cause).pipe(
            Effect.as(
              HttpServerResponse.jsonUnsafe(
                {
                  _tag: 'Unavailable',
                  reason: 'database_unavailable',
                  detail: null,
                },
                { status: 503 },
              ),
            ),
          ),
        ),
      ),
    )
    yield* router.add(
      'GET',
      '/api/v2/openapi.json',
      HttpServerResponse.jsonUnsafe(openApi),
    )
    yield* router.add(
      '*',
      '/api/v2/*',
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const { token } = yield* ApiConfig
        if (
          Option.isSome(token) &&
          !Webhook.constantTimeEquals(
            request.headers.authorization ?? '',
            `Bearer ${Redacted.value(token.value)}`,
          )
        ) {
          return unauthorized('invalid_token')
        }
        const member = request.headers[memberHeader]?.trim()
        if (!member) return unauthorized('member_required')
        const directory = yield* SpaceDirectory
        const unclaimed = yield* directory.unclaimedLegacy
        if (Option.isSome(unclaimed)) {
          return HttpServerResponse.jsonUnsafe(
            {
              _tag: 'Unavailable',
              reason: 'unclaimed_database',
              detail: unclaimed.value,
            },
            { status: 503 },
          )
        }
        const space = yield* directory.spaceOf(member)
        const handle = yield* SpaceApp.useSync((app) => app).pipe(
          Effect.provide(SpaceApps.get(space.id)),
        )
        return yield* handle
      }),
    )
  }),
)

const inSpace = <A, E, R>(space: Space, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(SpaceApps.get(space.id)))

/**
 * The spaces a Pluggy event belongs to:
 * - events without an item concern no space
 * - a deletion goes to every space, as before: it is kept even for an item no
 *   connection holds yet, so a late registration cannot attach it
 * - other item events go to the space whose connection holds the item, or,
 *   for an item not attached yet, to the space whose pending connection
 *   requested it (Pluggy's `clientUserId` is that connection's id)
 */
const spacesFor = Effect.fn('SpaceWebhooks.spacesFor')(function* (
  webhook: PluggyWebhook,
) {
  const itemId = webhook.itemId
  if (itemId === undefined) return []
  const spaces = yield* SpaceDirectory.use((directory) => directory.list)
  if (webhook.event === 'item/deleted') return spaces

  const holding = yield* Effect.filter(spaces, (space) =>
    inSpace(
      space,
      OpenFinance.use((openFinance) => openFinance.connectionByItem(itemId)),
    ).pipe(Effect.map(Option.isSome)),
  )
  if (holding.length > 0) return holding

  const item = yield* PluggyClient.use((pluggy) => pluggy.getItem(itemId)).pipe(
    Effect.map(Option.some),
    // Gone or never Pluggy's: nothing to route. Unavailable fails the
    // delivery so Pluggy retries it.
    Effect.catchTag('PluggyError', (error) =>
      error.reason === 'unavailable'
        ? Effect.fail(error)
        : Effect.succeed(Option.none()),
    ),
  )
  const requester = Option.flatMap(item, (found) =>
    Option.fromNullishOr(found.clientUserId),
  )
  if (Option.isNone(requester)) return []
  return yield* Effect.filter(spaces, (space) =>
    inSpace(
      space,
      OpenFinance.use((openFinance) => openFinance.connection(requester.value)),
    ).pipe(
      Effect.as(true),
      Effect.catchTag('OpenFinanceError', () => Effect.succeed(false)),
    ),
  )
})

/** Validates a delivery and stores it in the log of each space it belongs to. */
export const routeWebhook = Effect.fn('SpaceWebhooks.route')(function* (input: {
  readonly authorization: string | undefined
  readonly body: string
}) {
  const parsed = yield* Webhook.parseWebhook(input)
  if (Result.isFailure(parsed)) return parsed.failure
  const targets = yield* spacesFor(parsed.success.webhook)
  if (targets.length === 0) {
    yield* Effect.logInfo(
      `Pluggy ${parsed.success.webhook.event} belongs to no space; not stored`,
    )
  }
  const stored = yield* Effect.forEach(targets, (space) =>
    inSpace(space, Webhook.storeWebhook(parsed.success)),
  )
  return {
    status: 202,
    body: { accepted: true, duplicate: !stored.some(Boolean) },
  } satisfies Webhook.WebhookResult
})

/** `POST /api/pluggy/webhook` for a server with one database per space. */
export const webhookRoutes = Webhook.routesWith(routeWebhook)
