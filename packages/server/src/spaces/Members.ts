import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
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
import { Accounts } from '../ledger/Accounts.ts'
import { SpaceApps, withSpace } from './Space.ts'
import type { Space } from './SpaceDirectory.ts'
import { SpaceDirectory } from './SpaceDirectory.ts'

const SpaceHandlers = HttpApiBuilder.group(
  SpaceApi,
  'space',
  Effect.fn(function* (handlers) {
    const directory = yield* SpaceDirectory
    const spaceApps = yield* SpaceApps
    const fs = yield* FileSystem.FileSystem

    // The member the web server names, their space and their role in it.
    const caller = Effect.gen(function* () {
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
      const space = yield* directory.spaceOf(email)
      const membership = yield* directory.membership(email)
      const role = Option.match(membership, {
        onNone: () => 'member' as const,
        onSome: (found) => found.role,
      })
      return { email, space, role }
    })

    const owner = caller.pipe(
      Effect.filterOrFail(
        (found) => found.role === 'owner',
        () => new Rejected({ reason: 'not_owner', detail: null }),
      ),
    )

    const view = (space: Space, you: string) =>
      Effect.map(directory.members(space.id), (members) => ({
        name: space.name,
        you,
        members,
      }))

    // A space someone made by signing in before being added: nothing was
    // ever recorded in it, so moving them out loses nothing.
    const isEmpty = (space: Space) =>
      withSpace(
        space.id,
        Effect.gen(function* () {
          const accounts = yield* Accounts
          const owners = yield* accounts.listOwners
          const list = yield* accounts.list
          return owners.length === 0 && list.length === 0
        }),
      ).pipe(Effect.provideService(SpaceApps, spaceApps), Effect.orDie)

    // Closes a removed space and deletes its database files.
    const discard = (space: Space) =>
      Effect.gen(function* () {
        yield* SpaceApps.invalidate(space.id).pipe(
          Effect.provideService(SpaceApps, spaceApps),
        )
        const path = directory.databasePath(space)
        if (path === ':memory:') return
        yield* Effect.forEach(
          [path, `${path}-wal`, `${path}-shm`],
          (file) => fs.remove(file, { force: true }),
          { discard: true },
        )
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError(`Space ${space.id} left files behind`, cause),
        ),
      )

    return handlers.handleAll({
      get: () =>
        caller.pipe(Effect.flatMap((found) => view(found.space, found.email))),
      addMember: ({ payload }) =>
        Effect.gen(function* () {
          const found = yield* owner
          const email = payload.email.trim().toLowerCase()
          const current = yield* directory.membership(email)
          if (Option.isNone(current)) {
            yield* directory.addMember(found.space.id, email)
          } else if (current.value.space.id === found.space.id) {
            return yield* new Conflict({
              reason: 'already_member',
              detail: email,
            })
          } else {
            const others = yield* directory.members(current.value.space.id)
            if (others.length > 1 || !(yield* isEmpty(current.value.space))) {
              return yield* new Conflict({
                reason: 'member_elsewhere',
                detail: email,
              })
            }
            const left = yield* directory.moveMember(email, found.space.id)
            if (Option.isSome(left)) yield* discard(left.value)
          }
          return yield* view(found.space, found.email)
        }),
      removeMember: ({ payload }) =>
        Effect.gen(function* () {
          const found = yield* owner
          const email = payload.email.trim().toLowerCase()
          const current = yield* directory.membership(email)
          if (
            Option.isNone(current) ||
            current.value.space.id !== found.space.id
          ) {
            return yield* new NotFound({
              reason: 'member_not_found',
              detail: email,
            })
          }
          if (current.value.role === 'owner') {
            return yield* new Rejected({ reason: 'owner_stays', detail: email })
          }
          yield* directory.removeMember(email)
          return yield* view(found.space, found.email)
        }),
    })
  }),
)

/** `/api/v2/space`, answered by the server for the caller's space. */
export const memberRoutes = HttpApiBuilder.layer(SpaceApi).pipe(
  Layer.provide(SpaceHandlers),
  Layer.provide(SecurityLive),
)
