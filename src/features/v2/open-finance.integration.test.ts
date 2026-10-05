import { afterEach, beforeEach, expect, it } from 'vitest'

import { v2 } from '#/lib/v2/client.server'
import { bank, card, startV2Api, tx } from '#/test/v2-api'
import type { V2TestApi } from '#/test/v2-api'

let api: V2TestApi
beforeEach(async () => {
  api = await startV2Api()
})
afterEach(() => api.close())

const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000)
  .toISOString()
  .slice(0, 10)

it('connects an item, links its accounts with history and syncs entries', async () => {
  const owner = await v2((client) =>
    client.owners.create({ payload: { name: 'Família', kind: 'household' } }),
  )
  const { connectionId, accessToken } = await v2((client) =>
    client.openFinance.createConnectToken({ payload: { ownerId: owner.id } }),
  )
  expect(accessToken).toBeTruthy()
  // The widget authorizes the item for this connection's clientUserId.
  await api.pluggy((current) => ({
    ...current,
    clientUserId: connectionId,
    accounts: [bank, card],
    transactions: {
      [bank.id]: [
        tx('market', fiveDaysAgo, { amount: 120.5, description: 'Mercado' }),
      ],
    },
  }))
  const found = await v2((client) =>
    client.openFinance.registerItem({
      params: { connectionId },
      payload: { itemId: 'item-1' },
    }),
  )
  expect(found.map((account) => [account.type, account.accountId])).toEqual([
    ['BANK', null],
    ['CREDIT', null],
  ])

  const checking = await v2((client) =>
    client.openFinance.link({
      params: { providerAccountId: bank.id },
      payload: {
        target: { kind: 'checking', purpose: 'operating' },
        historyMonths: 3,
      },
    }),
  )
  const cardFailure = await v2((client) =>
    client.openFinance.link({
      params: { providerAccountId: card.id },
      payload: {
        target: { kind: 'credit_card', purpose: 'operating' },
        historyMonths: 6,
      },
    }),
  ).catch((error: unknown) => error)
  await api.drain()

  const entries = await v2((client) =>
    client.entries.list({ query: { accountId: checking.id } }),
  )
  expect(entries.entries.map((entry) => entry.amountCents)).toEqual([-12_050])
  expect(cardFailure).toMatchObject({ reason: 'card_terms_required' })

  await v2((client) =>
    client.openFinance.disconnect({ params: { connectionId } }),
  )
  const [connection] = await v2((client) => client.openFinance.connections())
  expect(connection).toMatchObject({ status: 'disconnected' })
})
