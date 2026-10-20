import type { CimdOptions } from '@better-auth/cimd'
import type { BetterAuthOptions } from 'better-auth'
import type * as Layer from 'effect/Layer'
import type * as HttpClient from 'effect/http/HttpClient'

// What the web server needs from the runtime it runs on. `vp dev` runs on
// Node (`./*.server.ts`); the production build runs on Cloudflare Workers,
// where `vite.config.ts` swaps in `./cloudflare/*.server.ts`.

export interface AuthPlatform {
  /** Better Auth's own database: people, sessions and OAuth clients. */
  readonly database: () => BetterAuthOptions['database']
  /** How the MCP's Client ID Metadata Documents are fetched; see `CimdOptions`. */
  readonly fetchClientMetadataResource: CimdOptions['fetchClientMetadataResource']
  /**
   * Brings Better Auth's tables up to date with `migrate`, which compares
   * them with the configuration and creates or extends what is missing.
   */
  readonly migrate: (migrate: () => Promise<void>) => Promise<void>
}

export interface ApiPlatform {
  /** Where the API answers and the bearer token it expects, read per call. */
  readonly settings: () => {
    readonly baseUrl: string
    readonly token: string | undefined
  }
  /** The HTTP client calls to the API go through. */
  readonly httpClient: Layer.Layer<HttpClient.HttpClient>
}
