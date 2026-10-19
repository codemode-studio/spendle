import { env } from 'cloudflare:workers'

import type { AuthPlatform } from '../types'

export const authPlatform: AuthPlatform = {
  // A D1 database; Better Auth creates its tables there on first use.
  database: () => env.AUTH_DB,
  // CIMD's Node transport pins the resolved address so a metadata URL cannot
  // reach a private network. A Worker has no private network to reach: its
  // fetches leave through Cloudflare to the public internet. The rest of the
  // contract (HTTPS, GET or HEAD, redirects returned unfollowed) holds here.
  fetchClientMetadataResource: (input, init) => {
    const request = new Request(input, init)
    if (new URL(request.url).protocol !== 'https:') {
      throw new TypeError('CIMD metadata must be fetched over HTTPS')
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      throw new TypeError('CIMD metadata is fetched with GET or HEAD only')
    }
    return fetch(request, { redirect: 'manual' })
  },
}
