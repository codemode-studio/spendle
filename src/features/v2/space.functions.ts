import { createServerFn } from '@tanstack/react-start'
import * as Schema from 'effect/Schema'

import { isAllowedEmail, parseAllowedEmails } from '#/features/auth/allowlist'
import { V2ApiError, v2Space } from '#/lib/v2/client.server'

const MemberEmail = Schema.toStandardSchemaV1(
  Schema.Struct({
    email: Schema.String.check(Schema.isPattern(/^[^\s@]+@[^\s@]+$/)),
  }),
)

export const getSpaceFn = createServerFn({ method: 'GET' }).handler(() =>
  v2Space((client) => client.space.get()),
)

export const addMemberFn = createServerFn({ method: 'POST' })
  .validator(MemberEmail)
  .handler(({ data }) => {
    // Sign-in still checks the allowlist: someone outside it could be added
    // but never get in.
    if (
      process.env.SPENDLE_AUTH_DISABLED !== '1' &&
      !isAllowedEmail(
        data.email,
        parseAllowedEmails(process.env.SPENDLE_ALLOWED_EMAILS),
      )
    ) {
      throw new V2ApiError('Rejected', 'not_allowed', data.email)
    }
    return v2Space((client) => client.space.addMember({ payload: data }))
  })

export const removeMemberFn = createServerFn({ method: 'POST' })
  .validator(MemberEmail)
  .handler(({ data }) =>
    v2Space((client) => client.space.removeMember({ payload: data })),
  )
