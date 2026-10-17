import { afterEach, beforeEach, expect, it } from 'vite-plus/test'

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

it('counts spending in another currency in reais at the rate of its date', async () => {
  await api.close()
  api = await startV2Api({
    rates: {
      USD: [
        ['2026-09-04', 5_000_000],
        ['2026-09-08', 5_500_000],
      ],
    },
  })
  const dollars = await openChecking('Conta em dólar', 'USD')
  const euros = await openChecking('Conta em euro', 'EUR')
  const lunch = await v2((client) =>
    client.manual.createTransaction({
      payload: {
        accountId: dollars.id,
        bookedOn: '2026-09-05',
        amountCents: -2_000,
        description: 'Lunch',
      },
    }),
  )
  await v2((client) =>
    client.manual.createTransaction({
      payload: {
        accountId: euros.id,
        bookedOn: '2026-09-05',
        amountCents: -1_000,
        description: 'Croissant',
      },
    }),
  )
  await api.drain()
  await v2((client) =>
    client.categoryDecisions.decide({
      params: { entryId: lunch.entryId! },
      payload: { categoryId: 'restaurants' },
    }),
  )
  await api.drain()

  const ledger = await v2(categoryLedger)
  // US$ 20.00 at the 4th's R$ 5.00; the euro, without a rate, stays out.
  expect(ledger.map((entry) => [entry.description, entry.amountCents])).toEqual(
    [['Lunch', -10_000]],
  )
})
