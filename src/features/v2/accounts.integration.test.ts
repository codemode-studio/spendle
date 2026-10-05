import { afterEach, beforeEach, expect, it } from 'vitest'

import { V2ApiError, v2 } from '#/lib/v2/client.server'
import { startV2Api } from '#/test/v2-api'
import type { V2TestApi } from '#/test/v2-api'

let api: V2TestApi
beforeEach(async () => {
  api = await startV2Api()
})
afterEach(() => api.close())

it('opens an account and a card with terms through the V2 API', async () => {
  const owner = await v2((client) =>
    client.owners.create({ payload: { name: 'Família', kind: 'household' } }),
  )
  const card = await v2((client) =>
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
  const changed = await v2((client) =>
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
  const listed = await v2((client) => client.accounts.list({ query: {} }))
  expect(listed.map((account) => [account.name, account.card])).toEqual([
    [
      'Cartão',
      { closingDay: 6, dueDay: 13, limitCents: 150_051, lastFour: null },
    ],
  ])
  expect(changed.card?.limitCents).toBe(150_051)
})

it('rejects with the API reason and a message the person can act on', async () => {
  const failure = await v2((client) =>
    client.accounts.get({ params: { accountId: 'missing' } }),
  ).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(V2ApiError)
  expect(failure).toMatchObject({
    tag: 'NotFound',
    reason: 'account_not_found',
    message: 'Conta não encontrada. Recarregue a página.',
  })
})

it('reports an unreachable API instead of a transport stack', async () => {
  await api.close()
  process.env.SPENDLE_API_URL = 'http://127.0.0.1:9'
  const failure = await v2((client) => client.owners.list()).catch(
    (error: unknown) => error,
  )
  expect(failure).toMatchObject({ reason: 'v2_unreachable' })
  api = await startV2Api()
})
