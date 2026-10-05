import * as HttpApi from 'effect/http-api/HttpApi'
import * as OpenApi from 'effect/http-api/OpenApi'

import { AccountsApi, OwnersApi } from './Accounts.ts'
import { ApiAuthorization, RequestValidation } from './Security.ts'
import { SystemApi } from './System.ts'

/**
 * The V2 API under `/api/v2`. Clients derive a typed client from it with
 * `HttpApiClient.make(SpendleApi)`; this module and its siblings import only
 * `effect`, so they are safe to bundle in the web app.
 */
export class V2Api extends HttpApi.make('spendle-v2')
  .add(OwnersApi, AccountsApi)
  .middleware(ApiAuthorization) {}

/** `V2Api` plus `/health`, which answers without a token. */
export class SpendleApi extends HttpApi.make('spendle')
  .addHttpApi(V2Api)
  .add(SystemApi)
  .middleware(RequestValidation)
  .annotateMerge(OpenApi.annotations({ title: 'Spendle API', version: '2' })) {}
