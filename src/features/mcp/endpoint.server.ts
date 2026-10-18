import { requireMcpAuth } from '@better-auth/mcp'
import { createMcpHandler } from '@modelcontextprotocol/server'
import * as Option from 'effect/Option'
import * as Predicate from 'effect/Predicate'
import * as Schema from 'effect/Schema'

import { getAuth, isAllowed, mcpResource } from '#/features/auth/auth.server'

import { spendleMcpServer } from './tools.server'

/** The claims Spendle reads from a verified access token. */
const AccessClaims = Schema.Struct({
  sub: Schema.String,
  /** The OAuth client the token was issued to. */
  azp: Schema.String,
  scope: Schema.optional(Schema.String),
  exp: Schema.optional(Schema.Number),
})
const decodeClaims = Schema.decodeUnknownOption(AccessClaims)

// Every request stands alone: each one gets a fresh server for the member
// its token names, so the endpoint keeps no MCP session between calls.
const mcp = createMcpHandler(
  ({ authInfo }) => {
    const member = authInfo?.extra?.member
    if (!Predicate.isString(member)) {
      throw new Error('MCP request without a verified member')
    }
    return spendleMcpServer(member)
  },
  { responseMode: 'json' },
)

const forbidden = () =>
  Response.json(
    {
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32_000,
        message: 'This Google account no longer has access to Spendle.',
      },
    },
    { status: 403 },
  )

/**
 * `POST /api/mcp`. Better Auth verifies the bearer token's signature, issuer,
 * expiry and audience, answering a missing or invalid one with the RFC 9728
 * challenge that starts the client's sign-in. The allowlist is checked again
 * on every call: removing an email cuts off tokens already issued to it.
 */
export async function handleMcpRequest(request: Request) {
  const auth = await getAuth()
  const protectedHandler = requireMcpAuth(
    auth,
    async (request, payload) => {
      const claims = decodeClaims(payload)
      if (Option.isNone(claims)) return forbidden()
      const context = await auth.$context
      const user = await context.internalAdapter.findUserById(claims.value.sub)
      if (!user || !isAllowed(user.email)) return forbidden()
      const token = request.headers.get('authorization')?.replace(/^\S+\s+/, '')
      return mcp.fetch(request, {
        authInfo: {
          token: token ?? '',
          clientId: claims.value.azp,
          scopes: claims.value.scope?.split(' ') ?? [],
          expiresAt: claims.value.exp,
          extra: { member: user.email },
        },
      })
    },
    { resource: mcpResource() },
  )
  return protectedHandler(request)
}
