import { timingSafeEqual } from 'node:crypto'

import type { BetterAuthPlugin } from 'better-auth'
import { createAuthEndpoint } from 'better-auth/api'
import { setSessionCookie } from 'better-auth/cookies'
import * as Schema from 'effect/Schema'

/** The person a QA run signs in as; `qa:start` allows only this email. */
export const qaEmail = 'qa@spendle.local'

const Query = Schema.Struct({
  token: Schema.String,
  // A path on this site, never another origin.
  next: Schema.optional(Schema.String.check(Schema.isPattern(/^\/(?![/\\])/))),
})

const sameToken = (given: string, expected: string) =>
  given.length === expected.length &&
  timingSafeEqual(Buffer.from(given), Buffer.from(expected))

/**
 * `GET /api/auth/qa/sign-in?token=…&next=/path` signs the browser in as the
 * QA person through a real Better Auth session, so an agent can check
 * `/entrar` redirects, `/autorizar` and the MCP flow without Google. Only
 * `vp run qa:start` registers it, with a token it makes for each run.
 */
export const qaSignIn = (token: string) =>
  ({
    id: 'spendle-qa-sign-in',
    endpoints: {
      qaSignIn: createAuthEndpoint(
        '/qa/sign-in',
        { method: 'GET', query: Schema.toStandardSchemaV1(Query) },
        async (ctx) => {
          if (!sameToken(ctx.query.token, token)) {
            throw ctx.error('FORBIDDEN', { message: 'Unknown QA token.' })
          }
          const { internalAdapter } = ctx.context
          const user =
            (await internalAdapter.findUserByEmail(qaEmail))?.user ??
            (await internalAdapter.createUser(
              { email: qaEmail, name: 'QA', emailVerified: true },
              ctx,
            ))
          const session = await internalAdapter.createSession(user.id)
          await setSessionCookie(ctx, { session, user })
          throw ctx.redirect(ctx.query.next ?? '/')
        },
      ),
    },
  }) satisfies BetterAuthPlugin
