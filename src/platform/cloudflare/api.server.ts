import { env } from 'cloudflare:workers'
import * as Layer from 'effect/Layer'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'

import type { ApiPlatform } from '../types'

// The API answers in the control Durable Object, reached through its stub
// rather than the network: nothing outside this Worker can call it.
export const apiPlatform: ApiPlatform = {
  // The stub ignores the origin; it only has to make the URL absolute.
  settings: () => ({
    baseUrl: 'https://api.spendle.internal',
    token: undefined,
  }),
  httpClient: FetchHttpClient.layer.pipe(
    Layer.provideMerge(
      Layer.succeed(FetchHttpClient.Fetch, (input, init) =>
        env.CONTROL.getByName('control').fetch(new Request(input, init)),
      ),
    ),
  ),
}
