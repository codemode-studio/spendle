import { createServerFn } from '@tanstack/react-start'
import * as Schema from 'effect/Schema'

import { isAllowedEmail, parseAllowedEmails } from '#/features/auth/allowlist'
import { ApiRequestError, spaceApi } from '#/lib/api/client.server'

const MemberEmail = Schema.toStandardSchemaV1(
  Schema.Struct({
    email: Schema.String.check(Schema.isPattern(/^[^\s@]+@[^\s@]+$/)),
  }),
)

export const getSpaceFn = createServerFn({ method: 'GET' }).handler(() =>
  spaceApi((client) => client.space.get()),
)

export const addMemberFn = createServerFn({ method: 'POST' })
  .validator(MemberEmail)
  .handler(({ data }) => {
    // Sign-in still checks the allowlist: someone outside it could be added
    // but never get in.
    if (
      !isAllowedEmail(
        data.email,
        parseAllowedEmails(process.env.SPENDLE_ALLOWED_EMAILS),
      )
    ) {
      throw new ApiRequestError('Rejected', 'not_allowed', data.email)
    }
    return spaceApi((client) => client.space.addMember({ payload: data }))
  })

export const removeMemberFn = createServerFn({ method: 'POST' })
  .validator(MemberEmail)
  .handler(({ data }) =>
    spaceApi((client) => client.space.removeMember({ payload: data })),
  )
