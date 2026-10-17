import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as HttpRouter from 'effect/http/HttpRouter'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import * as OpenApi from 'effect/http-api/OpenApi'

import { ApiConfig } from '../api/ApiConfig.ts'
import { SpendleApi } from '../api/definition/Api.ts'
import { memberHeader } from '../api/definition/Security.ts'
import * as Webhook from '../openfinance/Webhook.ts'
import { SpaceApp, withSpace } from './Space.ts'
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
        const handle = yield* withSpace(
          space.id,
          SpaceApp.useSync((app) => app),
        )
        return yield* handle
      }),
    )
  }),
)
