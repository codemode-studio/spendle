import { afterEach, beforeEach, expect, it } from 'vitest'

import { v2 } from '#/lib/v2/client.server'
import { startV2Api } from '#/test/v2-api'
import type { V2TestApi } from '#/test/v2-api'
import { ofxStatement, openChecking, statementUpload } from '#/test/v2-fixtures'

let api: V2TestApi
beforeEach(async () => {
  api = await startV2Api()
})
afterEach(() => api.close())

it('learns from a decision, previews a store edit over history and applies it', async () => {
  const account = await openChecking()
  await v2((client) =>
    client.imports.upload({
      payload: statementUpload(
        account.id,
        ofxStatement({
          start: '20260901',
          end: '20260930',
          closing: '-80.02',
          lines: [
            {
              id: 'a',
              date: '20260905',
              amount: '-40.01',
              memo: 'PADARIA DO ZE',
            },
            {
              id: 'b',
              date: '20260920',
              amount: '-40.01',
              memo: 'PADARIA DO ZE',
            },
          ],
        }),
        'set.ofx',
      ),
    }),
  )
  await api.drain()
  const [first] = (await v2((client) => client.entries.list({ query: {} })))
    .entries
  await v2((client) =>
    client.categoryDecisions.decide({
      params: { entryId: first.id },
      payload: { categoryId: 'groceries' },
    }),
  )
  await api.drain()

  const [pattern] = await v2((client) => client.categoryStore.patterns())
  expect(pattern).toMatchObject({
    kind: 'merchant',
    categoryId: 'groceries',
    source: 'transaction_list',
  })
  const edit = {
    _tag: 'Recategorize' as const,
    id: pattern.id,
    categoryId: 'restaurants',
  }
  const preview = await v2((client) =>
    client.categoryStore.preview({ payload: { edit } }),
  )
  // The decided entry keeps the person's category; only the other one follows the base.
  expect(
    preview.map((change) => [
      change.before.categoryId,
      change.after.categoryId,
    ]),
  ).toEqual([['groceries', 'restaurants']])
  const stillGroceries = await v2((client) =>
    client.entries.list({ query: { categoryId: 'groceries' } }),
  )
  expect(stillGroceries.total).toBe(2)

  await v2((client) => client.categoryStore.edit({ payload: { edit } }))
  await api.drain()
  const restaurants = await v2((client) =>
    client.entries.list({ query: { categoryId: 'restaurants' } }),
  )
  expect(restaurants.entries.map((entry) => entry.id)).toEqual(
    preview.map((change) => change.entryId),
  )
})
