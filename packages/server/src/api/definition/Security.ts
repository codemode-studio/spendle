import * as HttpApiMiddleware from 'effect/http-api/HttpApiMiddleware'
import * as HttpApiSecurity from 'effect/http-api/HttpApiSecurity'

import { InvalidRequest, Unauthorized } from './Errors.ts'

/**
 * Checks `Authorization: Bearer <SPENDLE_API_TOKEN>` when the server has a
 * token; without one, every local caller is accepted. Clients add the header
 * in `transformClient`, so the middleware is not required on the client.
 */
export class ApiAuthorization extends HttpApiMiddleware.Service<ApiAuthorization>()(
  '@spendle/server/api/ApiAuthorization',
  {
    security: { bearer: HttpApiSecurity.bearer },
    error: Unauthorized,
  },
) {}

/** Answers a request that fails its schema with `InvalidRequest` instead of an empty 400. */
export class RequestValidation extends HttpApiMiddleware.Service<RequestValidation>()(
  '@spendle/server/api/RequestValidation',
  { error: InvalidRequest },
) {}
