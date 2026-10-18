import { afterEach, beforeEach, expect, it } from 'vite-plus/test'

import { api } from '#/lib/api/client.server'
import { bank, card, startTestApi, tx } from '#/test/api'
import type { TestApi } from '#/test/api'

let testApi: TestApi
beforeEach(async () => {
  testApi = await startTestApi()
})
afterEach(() => testApi.close())

const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000)
  .toISOString()
  .slice(0, 10)

it('connects an item, links its accounts with history and syncs entries', async () => {
  const owner = await api((client) =>
    client.owners.create({ payload: { name: 'Família', kind: 'household' } }),
  )
  const { connectionId, accessToken } = await api((client) =>
    client.openFinance.createConnectToken({ payload: { ownerId: owner.id } }),
  )
  expect(accessToken).toBeTruthy()
  // The widget authorizes the item for this connection's clientUserId.
  await testApi.pluggy((current) => ({
    ...current,
    clientUserId: connectionId,
    accounts: [bank, card],
    transactions: {
      [bank.id]: [
        tx('market', fiveDaysAgo, { amount: 120.5, description: 'Mercado' }),
      ],
    },
  }))
  const found = await api((client) =>
    client.openFinance.registerItem({
      params: { connectionId },
      payload: { itemId: 'item-1' },
    }),
  )
  expect(found.map((account) => [account.type, account.accountId])).toEqual([
    ['BANK', null],
    ['CREDIT', null],
  ])

  const checking = await api((client) =>
    client.openFinance.link({
      params: { providerAccountId: bank.id },
      payload: {
        target: { kind: 'checking', purpose: 'operating' },
        historyMonths: 3,
      },
    }),
  )
  const cardFailure = await api((client) =>
    client.openFinance.link({
      params: { providerAccountId: card.id },
      payload: {
        target: { kind: 'credit_card', purpose: 'operating' },
        historyMonths: 6,
      },
    }),
  ).catch((error: unknown) => error)
  await testApi.drain()

  const entries = await api((client) =>
    client.entries.list({ query: { accountId: checking.id } }),
  )
  expect(entries.entries.map((entry) => entry.amountCents)).toEqual([-12_050])
  expect(cardFailure).toMatchObject({ reason: 'card_terms_required' })

  await api((client) =>
    client.openFinance.disconnect({ params: { connectionId } }),
  )
  const [connection] = await api((client) => client.openFinance.connections())
  expect(connection).toMatchObject({ status: 'disconnected' })
})
