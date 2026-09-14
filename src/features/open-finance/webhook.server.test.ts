import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openTestDatabase } from '#/test/database'
import type { TestDatabase } from '#/test/database'

import { handlePluggyWebhookRequest } from './webhook.server'

describe('Pluggy webhook endpoint', () => {
  let database: TestDatabase
  const previous = {
    id: process.env.PLUGGY_CLIENT_ID,
    secret: process.env.PLUGGY_CLIENT_SECRET,
    webhookUrl: process.env.PLUGGY_WEBHOOK_URL,
    webhookSecret: process.env.PLUGGY_WEBHOOK_SECRET,
  }

  beforeEach(async () => {
    database = await openTestDatabase()
    process.env.PLUGGY_CLIENT_ID = 'client'
    process.env.PLUGGY_CLIENT_SECRET = 'secret'
    process.env.PLUGGY_WEBHOOK_URL = 'https://example.com/api/pluggy/webhook'
    process.env.PLUGGY_WEBHOOK_SECRET = 'webhook-secret'
  })

  afterEach(() => {
    database.close()
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    restore('PLUGGY_CLIENT_ID', previous.id)
    restore('PLUGGY_CLIENT_SECRET', previous.secret)
    restore('PLUGGY_WEBHOOK_URL', previous.webhookUrl)
    restore('PLUGGY_WEBHOOK_SECRET', previous.webhookSecret)
  })

  function request(body: string, token = 'webhook-secret') {
    return new Request('https://example.com/api/pluggy/webhook', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body,
    })
  }

  it('rejects missing configuration and incorrect secrets', async () => {
    delete process.env.PLUGGY_WEBHOOK_SECRET
    expect((await handlePluggyWebhookRequest(request('{}'))).status).toBe(503)
    process.env.PLUGGY_WEBHOOK_SECRET = 'webhook-secret'
    expect(
      (await handlePluggyWebhookRequest(request('{}', 'wrong'))).status,
    ).toBe(401)
  })

  it('rejects invalid events and accepts a valid event without processing it', async () => {
    expect((await handlePluggyWebhookRequest(request('{}'))).status).toBe(400)
    const startedAt = performance.now()
    const response = await handlePluggyWebhookRequest(
      request(
        JSON.stringify({
          eventId: 'event-1',
          event: 'item/updated',
          itemId: 'item-1',
          ignored: 'field',
        }),
      ),
    )
    expect(response.status).toBe(202)
    expect(performance.now() - startedAt).toBeLessThan(5_000)
    const stored = await database.db
      .select()
      .from(database.schema.pluggyWebhookEvents)
    expect(stored).toHaveLength(1)
    expect(stored[0].state).toBe('pending')
    expect(stored[0].payloadJson).not.toContain('ignored')
  })
})
