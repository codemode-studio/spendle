// Connects to a QA run's `/api/mcp` as an MCP client would (Claude Code uses
// this SDK): discovery, registration, PKCE authorization, consent, tokens,
// then a few tool calls. It prints the authorization URL; open it in a
// browser signed in through the run's QA sign-in link and decide on
// `/autorizar`. Exits 0 once the tools answer, 1 if the person refused.
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from '@modelcontextprotocol/client'
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from '@modelcontextprotocol/client'

const directory = process.argv.at(2)
if (!directory) throw new Error('Usage: vp run qa:mcp <run-directory>')
const { url } = JSON.parse(readFileSync(join(directory, 'run.json'), 'utf8'))
const mcpUrl = new URL('/api/mcp', url)

// The authorization server sends the browser back here with a code.
const callback = createServer()
await new Promise<void>((resolve) => callback.listen(0, '127.0.0.1', resolve))
const redirectUrl = `http://127.0.0.1:${(callback.address() as AddressInfo).port}/callback`
const decision = new Promise<URLSearchParams>((resolve) =>
  callback.on('request', (request, response) => {
    const params = new URL(request.url ?? '/', redirectUrl).searchParams
    response.setHeader('content-type', 'text/plain; charset=utf-8')
    response.end(
      params.has('code')
        ? 'Spendle QA MCP client: authorized. You can close this tab.'
        : `Spendle QA MCP client: ${params.get('error') ?? 'no code'}.`,
    )
    resolve(params)
  }),
)

let client: StoredOAuthClientInformation | undefined
let tokens: StoredOAuthTokens | undefined
let verifier = ''
let discovery: OAuthDiscoveryState | undefined
const provider: OAuthClientProvider = {
  redirectUrl,
  clientMetadata: {
    client_name: 'Spendle QA MCP client',
    redirect_uris: [redirectUrl],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  },
  clientInformation: () => client,
  saveClientInformation: (information) => {
    client = information
  },
  tokens: () => tokens,
  saveTokens: (saved) => {
    tokens = saved
  },
  saveCodeVerifier: (saved) => {
    verifier = saved
  },
  codeVerifier: () => verifier,
  // Lets the SDK check that the code comes from the server it discovered.
  saveDiscoveryState: (state) => {
    discovery = state
  },
  discoveryState: () => discovery,
  redirectToAuthorization: (authorizationUrl) => {
    console.log(`authorizeUrl: ${authorizationUrl}`)
  },
}

const connect = async () => {
  const transport = new StreamableHTTPClientTransport(mcpUrl, {
    authProvider: provider,
  })
  const mcp = new Client({ name: 'spendle-qa', version: '1.0.0' })
  await mcp.connect(transport)
  return { mcp, transport }
}

const firstTry = await connect().catch((error: unknown) => {
  if (error instanceof UnauthorizedError) return null
  throw error
})
let mcp = firstTry?.mcp
if (!mcp) {
  console.log('Waiting for the decision on /autorizar…')
  const params = await decision
  const code = params.get('code')
  if (!code) {
    console.log(`refused: ${params.get('error') ?? 'no code'}`)
    callback.close()
    process.exit(1)
  }
  const transport = new StreamableHTTPClientTransport(mcpUrl, {
    authProvider: provider,
  })
  await transport.finishAuth(params)
  ;({ mcp } = await connect())
}
callback.close()

const { tools } = await mcp.listTools()
console.log(`clientId: ${client?.client_id}`)
console.log(
  `tools (${tools.length}): ${tools.map(({ name }) => name).join(', ')}`,
)
for (const [name, args] of [
  ['list_accounts', {}],
  ['search_transactions', { limit: 3 }],
  ['list_open_finance_connections', {}],
] as const) {
  const result = await mcp.callTool({ name, arguments: args })
  const [first] = result.content
  const text = first?.type === 'text' ? first.text : JSON.stringify(first)
  console.log(
    `${name}${result.isError ? ' (error)' : ''}: ${text.slice(0, 400)}`,
  )
}
await mcp.close()
