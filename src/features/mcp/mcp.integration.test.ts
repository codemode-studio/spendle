import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { makeSignature } from 'better-auth/crypto'
import { toNodeHandler } from 'better-auth/node'
import { afterAll, beforeAll, expect, it } from 'vite-plus/test'

import { getAuth } from '#/features/auth/auth.server'
import { v2 } from '#/lib/v2/client.server'
import { startV2Api } from '#/test/v2-api'
import type { V2TestApi } from '#/test/v2-api'
import { openChecking } from '#/test/v2-fixtures'

import { handleMcpRequest } from './endpoint.server'

// Better Auth serves over real HTTP: the MCP endpoint fetches its signing
// keys from `/api/auth/jwks` as it would in production.
const authServer = createServer(
  toNodeHandler(async (request) => (await getAuth()).handler(request)),
)
let api: V2TestApi
let base: string
let mcpUrl: string

beforeAll(async () => {
  await new Promise<void>((resolve) =>
    authServer.listen(0, '127.0.0.1', resolve),
  )
  base = `http://127.0.0.1:${(authServer.address() as AddressInfo).port}`
  mcpUrl = `${base}/api/mcp`
  // Overrides whatever `.env.local` holds, before Better Auth is first built.
  Object.assign(process.env, {
    BETTER_AUTH_URL: base,
    BETTER_AUTH_SECRET: 'mcp-test-secret-0123456789abcdef0123456789',
    GOOGLE_CLIENT_ID: 'test',
    GOOGLE_CLIENT_SECRET: 'test',
    SPENDLE_ALLOWED_EMAILS: 'ana@example.com',
    SPENDLE_AUTH_DATABASE_PATH: ':memory:',
  })
  delete process.env.SPENDLE_AUTH_DISABLED
  api = await startV2Api()
})
afterAll(async () => {
  await api.close()
  await new Promise((resolve) => authServer.close(resolve))
})

const auth = async (path: string, init?: RequestInit) =>
  (await getAuth()).handler(new Request(new URL(path, base), init))

/** A session cookie for a person, as Google sign-in would leave one. */
async function signIn(email: string) {
  const context = await (await getAuth()).$context
  const user =
    (await context.internalAdapter.findUserByEmail(email))?.user ??
    (await context.internalAdapter.createUser(
      { email, name: email },
      { method: 'admin' },
    ))
  const session = await context.internalAdapter.createSession(user.id)
  const signature = await makeSignature(session.token, context.secret)
  return `${context.authCookies.sessionToken.name}=${session.token}.${signature}`
}

/**
 * What an MCP client does: register, send the person through authorization
 * and consent, and exchange the code (with PKCE) for an access token bound
 * to the MCP endpoint.
 */
async function connectClient(cookie: string) {
  const redirectUri = 'http://127.0.0.1:9/callback'
  const registered = await auth('/api/auth/oauth2/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Test client',
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
    }),
  })
  const { client_id: clientId } = await registered.json()

  const verifier = randomBytes(32).toString('base64url')
  const authorize = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'openid offline_access',
    state: 'state',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    resource: mcpUrl,
  })
  const toConsent = await auth(`/api/auth/oauth2/authorize?${authorize}`, {
    headers: { cookie },
  })
  const consentPage = new URL(toConsent.headers.get('location') ?? '', base)
  expect(consentPage.pathname).toBe('/autorizar')

  const consent = await auth('/api/auth/oauth2/consent', {
    method: 'POST',
    headers: { cookie, origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({
      accept: true,
      oauth_query: consentPage.search.slice(1),
    }),
  })
  const { url } = await consent.json()
  const code = new URL(url).searchParams.get('code') ?? ''

  const tokens = await auth('/api/auth/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      resource: mcpUrl,
    }),
  })
  const { access_token: accessToken } = await tokens.json()
  return accessToken as string
}

/** One JSON-RPC call as a 2025-era streamable HTTP client sends it. */
async function callMcp(token: string | null, method: string, params = {}) {
  const response = await handleMcpRequest(
    new Request(mcpUrl, {
      method: 'POST',
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-06-18',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  )
  const text = await response.text()
  // The response is JSON, or a one-event stream carrying it.
  const json = text.startsWith('{') ? text : /^data: (.*)$/m.exec(text)?.[1]
  return { response, body: json ? JSON.parse(json) : null }
}

it('points an unauthenticated client to where it signs in', async () => {
  const { response } = await callMcp(null, 'tools/list')
  expect(response.status).toBe(401)
  const challenge = response.headers.get('www-authenticate') ?? ''
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1] ?? ''
  expect(new URL(metadataUrl).pathname).toBe(
    '/.well-known/oauth-protected-resource/api/mcp',
  )

  const resource = await (await fetch(metadataUrl)).json()
  expect(resource).toMatchObject({
    resource: mcpUrl,
    authorization_servers: [`${base}/api/auth`],
  })
  const server = await (
    await fetch(`${base}/.well-known/oauth-authorization-server/api/auth`)
  ).json()
  expect(server).toMatchObject({ issuer: `${base}/api/auth` })
})

it("reads the member's transactions with a token they approved, until their email leaves the allowlist", async () => {
  const account = await openChecking()
  await v2((client) =>
    client.manual.createTransaction({
      payload: {
        accountId: account.id,
        bookedOn: '2026-09-12',
        amountCents: -4_590,
        description: 'Mercado do bairro',
      },
    }),
  )
  await api.drain()
  const token = await connectClient(await signIn('ana@example.com'))

  const { body } = await callMcp(token, 'tools/call', {
    name: 'search_transactions',
    arguments: { text: 'mercado' },
  })
  expect(body.result.isError).toBeFalsy()
  const page = JSON.parse(body.result.content[0].text)
  expect(
    page.entries.map((entry: { amountCents: number }) => entry.amountCents),
  ).toEqual([-4_590])

  process.env.SPENDLE_ALLOWED_EMAILS = 'someone-else@example.com'
  try {
    const { response } = await callMcp(token, 'tools/list')
    expect(response.status).toBe(403)
  } finally {
    process.env.SPENDLE_ALLOWED_EMAILS = 'ana@example.com'
  }
})

it('reports an API failure to the client as a tool error', async () => {
  const token = await connectClient(await signIn('ana@example.com'))
  const { response, body } = await callMcp(token, 'tools/call', {
    name: 'get_transaction',
    arguments: { entryId: 'missing' },
  })
  expect(response.status).toBe(200)
  expect(body.result).toMatchObject({ isError: true })
})
