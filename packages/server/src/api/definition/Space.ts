import * as Schema from 'effect/Schema'
import * as HttpApi from 'effect/http-api/HttpApi'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'

import { EndpointErrors } from './Errors.ts'
import { ApiAuthorization, RequestValidation } from './Security.ts'

export const SpaceRole = Schema.Literals(['owner', 'member'])
export type SpaceRole = typeof SpaceRole.Type

export const SpaceMember = Schema.Struct({
  email: Schema.String,
  role: SpaceRole,
})
export type SpaceMember = typeof SpaceMember.Type

/** The caller's family space: who belongs to it and the caller's own email. */
export const SpaceView = Schema.Struct({
  name: Schema.String,
  you: Schema.String,
  members: Schema.Array(SpaceMember),
})
export type SpaceView = typeof SpaceView.Type

const MemberEmail = Schema.Struct({
  email: Schema.String.check(Schema.isPattern(/^[^\s@]+@[^\s@]+$/)),
})

export class SpaceGroupApi extends HttpApiGroup.make('space')
  .add(
    HttpApiEndpoint.get('get', '/', {
      success: SpaceView,
      error: EndpointErrors,
    }),
    /** Owner only. Someone with an empty space of their own moves in. */
    HttpApiEndpoint.post('addMember', '/members', {
      payload: MemberEmail,
      success: SpaceView,
      error: EndpointErrors,
    }),
    /** Owner only; the owner stays. */
    HttpApiEndpoint.post('removeMember', '/members/remove', {
      payload: MemberEmail,
      success: SpaceView,
      error: EndpointErrors,
    }),
  )
  .prefix('/api/v2/space') {}

/**
 * Who belongs to the caller's space. Served by the server itself rather than
 * by a space, since adding someone may move them out of another space.
 */
export class SpaceApi extends HttpApi.make('spendle-space')
  .add(SpaceGroupApi)
  .middleware(ApiAuthorization)
  .middleware(RequestValidation) {}
