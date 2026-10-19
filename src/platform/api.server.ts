import * as FetchHttpClient from 'effect/http/FetchHttpClient'

import type { ApiPlatform } from './types'

export const apiPlatform: ApiPlatform = {
  // The API server `vp run dev:api` (or the QA run) starts on this machine.
  settings: () => ({
    baseUrl: process.env.SPENDLE_API_URL || 'http://127.0.0.1:4100',
    token: process.env.SPENDLE_API_TOKEN || undefined,
  }),
  httpClient: FetchHttpClient.layer,
}
