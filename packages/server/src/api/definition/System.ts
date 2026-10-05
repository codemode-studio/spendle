import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import * as HttpApiSchema from 'effect/http-api/HttpApiSchema'

import { Unavailable } from './Errors.ts'

export class SystemApi extends HttpApiGroup.make('system', {
  topLevel: true,
}).add(
  HttpApiEndpoint.get('health', '/health', {
    success: HttpApiSchema.NoContent,
    error: Unavailable,
  }),
) {}
