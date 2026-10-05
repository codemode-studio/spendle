import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as HttpApiMiddleware from 'effect/http-api/HttpApiMiddleware'

import { constantTimeEquals } from '../openfinance/Webhook.ts'
import { ApiConfig } from './ApiConfig.ts'
import { InvalidRequest, Unauthorized } from './definition/Errors.ts'
import { ApiAuthorization, RequestValidation } from './definition/Security.ts'

export const ApiAuthorizationLive = Layer.effect(
  ApiAuthorization,
  Effect.gen(function* () {
    const { token } = yield* ApiConfig
    return ApiAuthorization.of({
      bearer: (handler, { credential }) =>
        Option.isNone(token) ||
        constantTimeEquals(
          Redacted.value(credential),
          Redacted.value(token.value),
        )
          ? handler
          : Effect.fail(
              new Unauthorized({ reason: 'invalid_token', detail: null }),
            ),
    })
  }),
)

export const RequestValidationLive =
  HttpApiMiddleware.layerSchemaErrorTransform(RequestValidation, (error) =>
    Effect.fail(
      new InvalidRequest({
        reason: `invalid_${error.kind.toLowerCase()}`,
        detail: error.cause.message,
      }),
    ),
  )

export const SecurityLive = Layer.mergeAll(
  ApiAuthorizationLive,
  RequestValidationLive,
)
