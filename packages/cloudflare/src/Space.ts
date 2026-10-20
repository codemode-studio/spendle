import type { SpaceObject } from '@spendle/server/durable'
import { DurableObject } from 'cloudflare:workers'

import { keepAwake } from './awake.ts'

// Reactors handle new events while the object is in memory; the alarm makes
// sure they finish after it would otherwise be evicted, and retries a failed
// pass (Pluggy down, say) a minute later.
const settleDelay = 1_000
const retryDelay = 60_000

/** One family space: its database, services, reactors and `/api`. */
export class Space extends DurableObject<Cloudflare.Env> {
  readonly #space: Promise<SpaceObject>
  readonly #touch = keepAwake()

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env)
    this.#space = import('./server.ts').then((server) =>
      server.spaceObject(ctx.storage, env.CF_VERSION_METADATA.id),
    )
  }

  override async fetch(request: Request) {
    this.#touch()
    try {
      return await (await this.#space).fetch(request)
    } finally {
      await this.#settleSoon()
    }
  }

  async holdsItem(itemId: string) {
    return (await this.#space).holdsItem(itemId)
  }

  async hasConnection(connectionId: string) {
    return (await this.#space).hasConnection(connectionId)
  }

  async storeWebhook(body: string) {
    await (await this.#space).storeWebhook(body)
    await this.#settleSoon()
  }

  override async alarm() {
    try {
      await (await this.#space).drain()
    } catch (error) {
      console.error('Space reactors failed; retrying in a minute', error)
      await this.ctx.storage.setAlarm(Date.now() + retryDelay)
    }
  }

  async #settleSoon() {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + settleDelay)
    }
  }
}
