import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { generateStructured } from './ai.server'

const input = {
  model: { apiKey: 'synthetic-test-key', model: 'openai/gpt-4o-mini' },
  schema: z.object({ ok: z.boolean() }),
  prompt: 'Synthetic transport test',
  timeoutMs: 5_000,
}
const outage = () =>
  new Response(
    JSON.stringify({ error: { message: 'Synthetic outage', code: 503 } }),
    {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '1' },
    },
  )
afterEach(() => vi.restoreAllMocks())
beforeAll(async () => {
  // Measure cancellation, not the first dynamic import of the SDK.
  await Promise.all([import('@tanstack/ai'), import('@tanstack/ai-openrouter')])
})

describe('real TanStack/OpenRouter transport with synthetic HTTP responses', () => {
  it('aborts during backoff promptly without another fetch', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => outage())
    const start = performance.now()
    await expect(
      generateStructured({ ...input, timeoutMs: 30 }),
    ).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(performance.now() - start).toBeLessThan(500)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('stops at two retries for 503 responses', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => outage())
    await expect(generateStructured(input)).rejects.toMatchObject({
      cause: { statusCode: 503 },
    })
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('preserves credential status under cause and never retries 401', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { message: 'Synthetic unauthorized', code: 401 },
        }),
        {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    )
    await expect(generateStructured(input)).rejects.toMatchObject({
      cause: { statusCode: 401 },
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('retries connection failures twice', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new TypeError('fetch failed', {
        cause: Object.assign(new Error('Synthetic connection refused'), {
          code: 'ECONNREFUSED',
        }),
      }),
    )
    await expect(generateStructured(input)).rejects.toMatchObject({
      cause: { name: 'ConnectionError' },
    })
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('recovers after a 503 and restores optional fields without dropping nullable fields', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(outage())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'synthetic-response',
            object: 'chat.completion',
            created: 1,
              model: input.model.model,
              system_fingerprint: 'synthetic',
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: {
                  role: 'assistant',
                  content: JSON.stringify({
                    required: null,
                    optional: null,
                    nested: { optional: null },
                  }),
                },
              },
            ],
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
      )
    await expect(
      generateStructured({
        ...input,
        schema: z.object({
          required: z.string().nullable(),
          optional: z.string().optional(),
          nested: z.object({ optional: z.number().optional() }),
        }),
      }),
    ).resolves.toEqual({ required: null, nested: {} })
    expect(fetch).toHaveBeenCalledTimes(2)
    const request = fetch.mock.calls[1][0] as Request
    const body = await request.json()
    expect(body.stream).toBe(false)
    expect(body.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { strict: true },
    })
  })
})
