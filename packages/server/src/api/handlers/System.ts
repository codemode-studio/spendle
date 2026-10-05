import * as Effect from 'effect/Effect'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import * as SqlClient from 'effect/sql/SqlClient'

import { SpendleApi } from '../definition/Api.ts'
import { Unavailable } from '../definition/Errors.ts'

export const SystemHandlers = HttpApiBuilder.group(
  SpendleApi,
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
          Effect.mapError(
            () =>
              new Unavailable({ reason: 'database_unavailable', detail: null }),
          ),
        ),
    })
  }),
)
