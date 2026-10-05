import { afterEach, beforeEach, expect, it } from 'vitest'

import { analyzeCategories } from '#/features/categories/analysis'
import { v2 } from '#/lib/v2/client.server'
import { startV2Api } from '#/test/v2-api'
import type { V2TestApi } from '#/test/v2-api'
import { ofxStatement, openChecking, statementUpload } from '#/test/v2-fixtures'

import { categoryLedger } from './categories.server'

let api: V2TestApi
beforeEach(async () => {
  api = await startV2Api()
})
afterEach(() => api.close())

it('analyzes spending by the categories the person decided, in centavos', async () => {
  const account = await openChecking()
  await v2((client) =>
    client.imports.upload({
      payload: statementUpload(
        account.id,
        ofxStatement({
          start: '20260901',
          end: '20260930',
          closing: '4774.88',
          lines: [
            {
              id: 'salary',
              date: '20260901',
              amount: '5000.00',
              memo: 'Salario ACME',
            },
            {
              id: 'market',
              date: '20260905',
              amount: '-120.51',
              memo: 'Mercado Bom',
            },
            {
              id: 'mystery',
              date: '20260910',
              amount: '-104.61',
              memo: 'XPTO 123',
            },
          ],
        }),
        'set.ofx',
      ),
    }),
  )
  await api.drain()
  const { entries } = await v2((client) => client.entries.list({ query: {} }))
  const market = entries.find((entry) => entry.description === 'Mercado Bom')!
  await v2((client) =>
    client.categoryDecisions.decide({
      params: { entryId: market.id },
      payload: { categoryId: 'groceries' },
    }),
  )
  await api.drain()

  const ledger = await v2(categoryLedger)
  const analysis = analyzeCategories(ledger, {
    start: '2026-09-01',
    end: '2026-09-30',
  })
  expect(analysis.items.map((item) => [item.id, item.cents])).toContainEqual([
    'groceries',
    12_051,
  ])
  expect(analysis.items.some((item) => item.id === 'salary')).toBe(false)
  expect(analysis.totalCents).toBe(12_051)
  expect([analysis.uncategorizedCount, analysis.uncategorizedCents]).toEqual([
    1, 10_461,
  ])
})
