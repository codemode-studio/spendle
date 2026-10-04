import * as Schema from 'effect/Schema'
import * as HttpApi from 'effect/http-api/HttpApi'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import * as HttpApiSchema from 'effect/http-api/HttpApiSchema'

export class DatabaseUnavailable extends Schema.TaggedError<DatabaseUnavailable>()(
  'DatabaseUnavailable',
  {},
  { httpApiStatus: 503 },
) {}

export class SystemApi extends HttpApiGroup.make('system', {
  topLevel: true,
}).add(
  HttpApiEndpoint.get('health', '/health', {
    success: HttpApiSchema.NoContent,
    error: DatabaseUnavailable,
  }),
) {}

export class Api extends HttpApi.make('spendle').add(SystemApi) {}
