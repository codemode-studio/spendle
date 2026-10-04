import * as Effect from 'effect/Effect'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import * as SqlClient from 'effect/sql/SqlClient'

import { Api, DatabaseUnavailable } from './Api.ts'

export const SystemHandlers = HttpApiBuilder.group(
  Api,
  'system',
  Effect.fn(function* (handlers) {
    const sql = yield* SqlClient.SqlClient
    return handlers.handleAll({
      health: () =>
        sql`SELECT 1`.pipe(
          Effect.asVoid,
          Effect.tapError((cause) =>
            Effect.logError('health check failed', cause),
          ),
          Effect.mapError(() => new DatabaseUnavailable()),
        ),
    })
  }),
)
