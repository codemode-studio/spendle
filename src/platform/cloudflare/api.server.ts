import { memberHeader } from '@spendle/server/api'
import { servedBySpace } from '@spendle/server/routing'
import { env } from 'cloudflare:workers'
import * as Layer from 'effect/Layer'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'

import type { ApiPlatform } from '../types'

const control = () => env.CONTROL.getByName('control')

// The space each member's requests go to. Asking the control object on every
// call would queue every family behind that one object; this isolate asks
// once and remembers the answer briefly. A member removed from a space keeps
// reaching it from an isolate that remembers them for at most this long.
const rememberFor = 30_000
const spaces = new Map<
  string,
  {
    readonly spaceId: string
    readonly written: boolean
    readonly until: number
  }
>()

async function toSpace(request: Request) {
  const { pathname } = new URL(request.url)
  const member = request.headers.get(memberHeader)?.trim()
  if (!member || !servedBySpace(pathname)) {
    // Membership changes go through the control object; forget what this
    // isolate remembered so they apply here at once.
    if (request.method !== 'GET') spaces.clear()
    return control().fetch(request)
  }
  // The control object records a space's first write (see `addMember`), so
  // a write asks it once even when the space is remembered.
  const write = request.method !== 'GET' && request.method !== 'HEAD'
  let known = spaces.get(member)
  if (
    known === undefined ||
    known.until < Date.now() ||
    (write && !known.written)
  ) {
    const spaceId = await control().spaceOf(member, write)
    // The control object explains why it refuses (data not claimed yet).
    if (spaceId === null) return control().fetch(request)
    known = {
      spaceId,
      written: write || (known?.spaceId === spaceId && known.written),
      until: Date.now() + rememberFor,
    }
    spaces.set(member, known)
  }
  return env.SPACES.getByName(known.spaceId).fetch(request)
}

// The API answers in Durable Objects, reached through their stubs rather than
// the network: nothing outside this Worker can call it.
export const apiPlatform: ApiPlatform = {
  // The stub ignores the origin; it only has to make the URL absolute.
  settings: () => ({
    baseUrl: 'https://api.spendle.internal',
    token: undefined,
  }),
  httpClient: FetchHttpClient.layer.pipe(
    Layer.provideMerge(
      Layer.succeed(FetchHttpClient.Fetch, (input, init) =>
        toSpace(new Request(input, init)),
      ),
    ),
  ),
}
