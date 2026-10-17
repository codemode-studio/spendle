import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'

import {
  Conflict,
  InvalidRequest,
  NotFound,
  Rejected,
  Unavailable,
} from '../api/definition/Errors.ts'
import { memberHeader } from '../api/definition/Security.ts'
import { SpaceApi } from '../api/definition/Space.ts'
import { SecurityLive } from '../api/Security.ts'
import type { Space, SpaceDirectoryError } from './SpaceDirectory.ts'
import { SpaceDirectory } from './SpaceDirectory.ts'

// What the API answers for each refusal of the directory.
const toApiError = (error: SpaceDirectoryError) => {
  const fields = { reason: error.reason, detail: error.detail }
  switch (error.reason) {
    case 'not_owner':
    case 'owner_stays':
      return new Rejected(fields)
    case 'member_not_found':
      return new NotFound(fields)
    case 'already_member':
    case 'member_elsewhere':
    case 'database_claimed':
      return new Conflict(fields)
  }
}

const SpaceHandlers = HttpApiBuilder.group(
  SpaceApi,
  'space',
  Effect.fn(function* (handlers) {
    const directory = yield* SpaceDirectory

    // The member the web server names, once the old data has an owner.
    const callerEmail = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const email = request.headers[memberHeader]?.trim().toLowerCase()
      if (!email) {
        return yield* new InvalidRequest({
          reason: 'member_required',
          detail: null,
        })
      }
      const unclaimed = yield* directory.unclaimedLegacy
      if (Option.isSome(unclaimed)) {
        return yield* new Unavailable({
          reason: 'unclaimed_database',
          detail: unclaimed.value,
        })
      }
      return email
    })

    const view = (space: Space, you: string) =>
      Effect.map(directory.members(space.id), (members) => ({
        id: space.id,
        name: space.name,
        you,
        members,
      }))

    return handlers.handleAll({
      get: () =>
        Effect.gen(function* () {
          const email = yield* callerEmail
          const { space } = yield* directory.memberOf(email)
          return yield* view(space, email)
        }),
      addMember: ({ payload }) =>
        Effect.gen(function* () {
          const by = yield* callerEmail
          const space = yield* directory
            .addMember({ by, email: payload.email })
            .pipe(Effect.mapError(toApiError))
          return yield* view(space, by)
        }),
      removeMember: ({ payload }) =>
        Effect.gen(function* () {
          const by = yield* callerEmail
          const space = yield* directory
            .removeMember({ by, email: payload.email })
            .pipe(Effect.mapError(toApiError))
          return yield* view(space, by)
        }),
    })
  }),
)

/** `/api/v2/space`, answered by the server for the caller's space. */
export const memberRoutes = HttpApiBuilder.layer(SpaceApi).pipe(
  Layer.provide(SpaceHandlers),
  Layer.provide(SecurityLive),
)
