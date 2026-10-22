import { cimd } from '@better-auth/cimd'
import { dash } from '@better-auth/infra'
import { mcp } from '@better-auth/mcp'
import { getRequest } from '@tanstack/react-start/server'
import { betterAuth } from 'better-auth'
import { APIError } from 'better-auth/api'
import { getMigrations } from 'better-auth/db/migration'
import { jwt } from 'better-auth/plugins'
import { tanstackStartCookies } from 'better-auth/tanstack-start'

import { authPlatform } from '#/platform/auth.server'

import { isAllowedEmail, parseAllowedEmails } from './allowlist'
import { qaSignIn } from './qa-sign-in.server'
import type { Person } from './viewer'

function requiredEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set; see .env.example.`)
  return value
}

const allowedEmails = () =>
  parseAllowedEmails(process.env.SPENDLE_ALLOWED_EMAILS)

/** Whether an email may use Spendle now; read per call so removals apply at once. */
export const isAllowed = (email: string) =>
  isAllowedEmail(email, allowedEmails())

/**
 * The MCP endpoint as OAuth clients name it (RFC 8707): every access token is
 * bound to this audience, so a token issued for it opens nothing else.
 */
export const mcpResource = () =>
  new URL('/api/mcp', requiredEnv('BETTER_AUTH_URL')).toString()

function createAuth() {
  // Set only by `vp run qa:start`, whose API holds synthetic data.
  const qaToken = process.env.SPENDLE_QA_SIGN_IN_TOKEN
  return betterAuth({
    appName: 'Spendle',
    secret: requiredEnv('BETTER_AUTH_SECRET'),
    baseURL: requiredEnv('BETTER_AUTH_URL'),
    // People, sessions and the OAuth clients, consents and signing keys
    // behind the MCP: a SQLite file on Node, D1 on Cloudflare. Financial data
    // never lives here.
    database: authPlatform.database(),
    // Every server function reads the session. A signed cookie answers for
    // five minutes before the database is asked again, so a session ended
    // elsewhere can last that long on this browser. The allowlist is still
    // checked on every call (`readViewer`). JWE encrypts the cookie, so the
    // person's name and email are not readable from it.
    session: {
      cookieCache: { enabled: true, maxAge: 5 * 60, strategy: 'jwe' },
    },
    // OAuth failures without their own error URL (a lost sign-in state, a
    // rejected MCP authorization request) land on the sign-in page with
    // `?error=<code>` instead of Better Auth's development error page.
    onAPIError: { errorURL: '/entrar' },
    // The JWT plugin's `/token` hands a session's JWT to the browser; the MCP
    // only accepts access tokens from the OAuth flow, so nothing needs it.
    disabledPaths: ['/token'],
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
            if (!isAllowed(user.email)) {
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
    advanced: {
      ipAddress: {
        // For Cloudflare
        ipAddressHeaders: ['cf-connecting-ip', 'x-forwarded-for'],

        // For Vercel
        // ipAddressHeaders: ["x-vercel-forwarded-for", "x-forwarded-for"],

        // For AWS/Generic
        // ipAddressHeaders: ["x-forwarded-for"],
      },
      database: {
        joins: true, // Enable database joins for better performance
      },
    },
    plugins: [
      // Signs the MCP access tokens and serves the keys at `/api/auth/jwks`.
      // Nothing reads the `set-auth-jwt` header it would add to every
      // session read, at the cost of a signing-key lookup and a signature.
      jwt({ disableSettingJwtHeader: true }),
      mcp({
        loginPage: '/entrar',
        consentPage: '/autorizar',
        resource: mcpResource(),
        // Clients that predate Client ID Metadata Documents register
        // themselves. Registering grants nothing: a token still needs an
        // allowed person to sign in and approve the client on `/autorizar`.
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        // Desktop clients (Claude Code, Cursor) register a loopback callback
        // without saying they are native apps; web clients still need https.
        clientRegistrationDefaultApplicationType: 'infer',
      }),
      cimd({
        fetchClientMetadataResource: authPlatform.fetchClientMetadataResource,
        metadataProfile: 'mcp-2026-07-28',
      }),
      ...(qaToken ? [qaSignIn(qaToken)] : []),
      dash(),
      // Must stay last: it applies cookies Better Auth sets inside Start,
      // including the session cache a session read refreshes.
      tanstackStartCookies(),
    ],
  })
}

let auth:
  | { instance: ReturnType<typeof createAuth>; ready: Promise<void> }
  | undefined

/**
 * Built on first use so env is read at request time, not at import. Resolves
 * once Better Auth's tables exist: they are created or extended in place, so
 * a plugin upgrade needs no separate migration step.
 */
export async function getAuth() {
  if (auth === undefined) {
    const instance = createAuth()
    const ready = authPlatform.migrate(async () => {
      const { runMigrations } = await getMigrations(instance.options)
      await runMigrations()
    })
    auth = { instance, ready }
    // A failed migration (a locked file, say) is retried by the next request
    // instead of failing every request until a restart.
    ready.catch(() => {
      if (auth?.ready === ready) auth = undefined
    })
  }
  const { instance, ready } = auth
  await ready
  return instance
}

// One lookup per request: the middleware, SSR loaders and every API call of
// a request share it instead of reading the session each time.
const viewers = new WeakMap<Request, Promise<Person | null>>()

/**
 * The signed-in person for the current request, or null. The allowlist is
 * checked again here so removing an email takes effect for live sessions.
 */
export function readViewer(): Promise<Person | null> {
  const request = getRequest()
  let viewer = viewers.get(request)
  if (viewer === undefined) {
    viewer = lookUpViewer(request.headers)
    viewers.set(request, viewer)
  }
  return viewer
}

async function lookUpViewer(headers: Headers): Promise<Person | null> {
  const session = await (await getAuth()).api.getSession({ headers })
  if (!session || !isAllowed(session.user.email)) return null
  const { name, email, image } = session.user
  return { name, email, image: image ?? null }
}
