import type { PluggyClient } from 'pluggy-sdk'
import { describe, expect, it, vi } from 'vitest'

import { createPluggyGateway } from './pluggy.server'

describe('Pluggy gateway', () => {
  it('creates a restricted token without repeating the webhook URL', async () => {
    const createConnectToken = vi
      .fn()
      .mockResolvedValue({ accessToken: 'token' })
    const gateway = createPluggyGateway({
      createConnectToken,
    } as unknown as PluggyClient)
    await gateway.createConnectToken({ clientUserId: 'connection-1' })
    expect(createConnectToken).toHaveBeenCalledWith(undefined, {
      clientUserId: 'connection-1',
      avoidDuplicates: true,
    })
  })

  it('reads every cursor page', async () => {
    const fetchTransactionsCursor = vi
      .fn()
      .mockResolvedValueOnce({
        results: [{ id: 'first' }],
        next: 'https://api.pluggy.ai/v2/transactions?after=cursor-2',
      })
      .mockResolvedValueOnce({ results: [{ id: 'second' }], next: null })
    const gateway = createPluggyGateway({
      fetchTransactionsCursor,
    } as unknown as PluggyClient)
    const result = await gateway.fetchAllTransactions('account-1')
    expect(result.map((item) => item.id)).toEqual(['first', 'second'])
    expect(fetchTransactionsCursor).toHaveBeenNthCalledWith(2, 'account-1', {
      after: 'cursor-2',
    })
  })

  it('updates an existing client webhook with the current bearer secret', async () => {
    const updateWebhook = vi.fn().mockResolvedValue({})
    const client = {
      fetchWebhooks: vi.fn().mockResolvedValue({
        results: [
          {
            id: 'hook-1',
            event: 'all',
            url: 'https://example.com/api/pluggy/webhook',
          },
        ],
      }),
      updateWebhook,
    }
    const gateway = createPluggyGateway(client as unknown as PluggyClient)
    await gateway.ensureWebhook({
      url: 'https://example.com/api/pluggy/webhook',
      secret: 'rotated-secret',
    })
    expect(updateWebhook).toHaveBeenCalledWith('hook-1', {
      url: 'https://example.com/api/pluggy/webhook',
      event: 'all',
      headers: { Authorization: 'Bearer rotated-secret' },
      enabled: true,
    })
  })

  it('limits retries for transient errors', async () => {
    const transient = Object.assign(new Error('secret upstream body'), {
      response: { statusCode: 503 },
    })
    const fetchItem = vi.fn().mockRejectedValue(transient)
    const gateway = createPluggyGateway({
      fetchItem,
    } as unknown as PluggyClient)
    await expect(gateway.fetchItem('item-1')).rejects.toMatchObject({
      retryable: true,
    })
    expect(fetchItem).toHaveBeenCalledTimes(3)
  })
})
