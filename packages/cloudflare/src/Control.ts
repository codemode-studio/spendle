import * as SqliteClient from '@effect/sql-sqlite-do/SqliteClient'
import { makeControlObject, webhookPath } from '@spendle/server/durable'
import type { ControlObject } from '@spendle/server/durable'
import { DurableObject } from 'cloudflare:workers'

import { keepAwake } from './awake.ts'

// Deliveries a space could not take yet are routed again a minute later,
// for as long as any wait.
const retryDelay = 60_000

/**
 * The API's front door: resolves the member each request names to their
 * space, answers `/api/space`, and keeps Pluggy's deliveries until every
 * space they belong to has stored them.
 */
export class Control extends DurableObject<Cloudflare.Env> {
  readonly #control: ControlObject
  readonly #touch = keepAwake()

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env)
    const space = (spaceId: string) => env.SPACES.getByName(spaceId)
    this.#control = makeControlObject(
      SqliteClient.layer({ storage: ctx.storage }),
      {
        fetch: (spaceId, request) => space(spaceId).fetch(request),
        holdsItem: (spaceId, itemId) => space(spaceId).holdsItem(itemId),
        hasConnection: (spaceId, connectionId) =>
          space(spaceId).hasConnection(connectionId),
        storeWebhook: (spaceId, body) => space(spaceId).storeWebhook(body),
      },
      env.CF_VERSION_METADATA.id,
    )
  }

  override async fetch(request: Request) {
    this.#touch()
    const response = await this.#control.fetch(request)
    if (
      new URL(request.url).pathname === webhookPath &&
      (await this.ctx.storage.getAlarm()) === null
    ) {
      await this.ctx.storage.setAlarm(Date.now() + retryDelay)
    }
    return response
  }

  override async alarm() {
    if (await this.#control.drainWebhooks()) {
      await this.ctx.storage.setAlarm(Date.now() + retryDelay)
    }
  }
}
