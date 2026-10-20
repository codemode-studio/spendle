import type { Control } from './Control.ts'
import type { Space } from './Space.ts'

// The bindings `cloudflare.config.ts` declares, as `env` from
// `cloudflare:workers` sees them. Secrets and variables reach the server as
// `process.env`, like on Node.
declare global {
  // The Workers runtime types `env` as this global interface; augmenting it is
  // the supported way to name the bindings.
  // oxlint-disable-next-line typescript/no-namespace
  namespace Cloudflare {
    interface Env {
      /** Better Auth's database. */
      readonly AUTH_DB: D1Database
      /** The one control object: spaces, members and Pluggy's webhook inbox. */
      readonly CONTROL: DurableObjectNamespace<Control>
      /** One object per family space, named by the space id. */
      readonly SPACES: DurableObjectNamespace<Space>
      /** The running Worker version, which every deploy and setting change replaces. */
      readonly CF_VERSION_METADATA: WorkerVersionMetadata
    }
  }
}
