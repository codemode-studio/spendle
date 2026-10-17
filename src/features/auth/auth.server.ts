import { getRequest } from '@tanstack/react-start/server'
import { betterAuth } from 'better-auth'
import { APIError } from 'better-auth/api'
import { tanstackStartCookies } from 'better-auth/tanstack-start'

import { isAllowedEmail, parseAllowedEmails } from './allowlist'
import type { Person } from './viewer'

function requiredEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set; see .env.example.`)
  return value
}

const allowedEmails = () =>
  parseAllowedEmails(process.env.SPENDLE_ALLOWED_EMAILS)

function createAuth() {
  return betterAuth({
    secret: requiredEnv('BETTER_AUTH_SECRET'),
    baseURL: requiredEnv('BETTER_AUTH_URL'),
    // No database: Better Auth runs stateless, keeping the session and the
    // Google account in encrypted cookies. Changing the secret signs everyone
    // out; there is no per-session revocation.
    socialProviders: {
      google: {
        clientId: requiredEnv('GOOGLE_CLIENT_ID'),
        clientSecret: requiredEnv('GOOGLE_CLIENT_SECRET'),
      },
    },
    databaseHooks: {
      user: {
        create: {
          // Stops sign-in before a session exists; the callback redirects to
          // the error URL with `?error=EMAIL_NOT_ALLOWED`.
          before: async (user) => {
            if (!isAllowedEmail(user.email, allowedEmails())) {
              throw new APIError('FORBIDDEN', {
                code: 'EMAIL_NOT_ALLOWED',
                message: 'This email is not in SPENDLE_ALLOWED_EMAILS.',
              })
            }
            return { data: user }
          },
        },
      },
    },
    // Must stay last: it applies cookies Better Auth sets inside Start.
    plugins: [tanstackStartCookies()],
  })
}

let auth: ReturnType<typeof createAuth> | undefined

/** Built on first use so env is read at request time, not at import. */
export function getAuth() {
  auth ??= createAuth()
  return auth
}

const qaViewer: Person = {
  name: 'QA',
  email: 'qa@spendle.local',
  image: null,
}

// One lookup per request: the middleware, SSR loaders and every API call of
// a request share it instead of decrypting the session cookie each time.
const viewers = new WeakMap<Request, Promise<Person | null>>()

/**
 * The signed-in person for the current request, or null. The allowlist is
 * checked again here so removing an email takes effect for live sessions.
 */
export function readViewer(): Promise<Person | null> {
  // Set only by `vp run qa:start`, whose API holds synthetic data.
  if (process.env.SPENDLE_AUTH_DISABLED === '1') {
    return Promise.resolve(qaViewer)
  }
  const request = getRequest()
  let viewer = viewers.get(request)
  if (viewer === undefined) {
    viewer = lookUpViewer(request.headers)
    viewers.set(request, viewer)
  }
  return viewer
}

async function lookUpViewer(headers: Headers): Promise<Person | null> {
  const session = await getAuth().api.getSession({ headers })
  if (!session || !isAllowedEmail(session.user.email, allowedEmails())) {
    return null
  }
  const { name, email, image } = session.user
  return { name, email, image: image ?? null }
}
