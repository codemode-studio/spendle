import { afterEach, beforeEach, expect, it } from 'vite-plus/test'

import { ApiRequestError, api } from '#/lib/api/client.server'
import { startTestApi } from '#/test/api'
import type { TestApi } from '#/test/api'

let testApi: TestApi
beforeEach(async () => {
  testApi = await startTestApi()
})
afterEach(() => testApi.close())

it('opens an account and a card with terms through the API', async () => {
  const owner = await api((client) =>
    client.owners.create({ payload: { name: 'Família', kind: 'household' } }),
  )
  const card = await api((client) =>
    client.accounts.open({
      payload: {
        ownerId: owner.id,
        institutionName: 'Banco',
        name: 'Cartão',
        kind: 'credit_card',
        purpose: 'operating',
        currency: 'BRL',
        card: {
          closingDay: 5,
          dueDay: 12,
          limitCents: 150_051,
          lastFour: '1234',
        },
      },
    }),
  )
  const changed = await api((client) =>
    client.accounts.setCardTerms({
      params: { accountId: card.id },
      payload: {
        closingDay: 6,
        dueDay: 13,
        limitCents: 150_051,
        lastFour: null,
      },
    }),
  )
  const listed = await api((client) => client.accounts.list({ query: {} }))
  expect(listed.map((account) => [account.name, account.card])).toEqual([
    [
      'Cartão',
      { closingDay: 6, dueDay: 13, limitCents: 150_051, lastFour: null },
    ],
  ])
  expect(changed.card?.limitCents).toBe(150_051)
})

it('rejects with the API reason and a message the person can act on', async () => {
  const failure = await api((client) =>
    client.accounts.get({ params: { accountId: 'missing' } }),
  ).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(ApiRequestError)
  expect(failure).toMatchObject({
    tag: 'NotFound',
    reason: 'account_not_found',
    message: 'Conta não encontrada. Recarregue a página.',
  })
})

it('reports an unreachable API instead of a transport stack', async () => {
  await testApi.close()
  process.env.SPENDLE_API_URL = 'http://127.0.0.1:9'
  const failure = await api((client) => client.owners.list()).catch(
    (error: unknown) => error,
  )
  expect(failure).toMatchObject({ reason: 'api_unreachable' })
  testApi = await startTestApi()
})
