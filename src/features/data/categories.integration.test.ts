import { afterEach, beforeEach, expect, it } from 'vite-plus/test'

import { analyzeCategories } from '#/features/categories/analysis'
import { api } from '#/lib/api/client.server'
import { startTestApi } from '#/test/api'
import type { TestApi } from '#/test/api'
import { ofxStatement, openChecking, statementUpload } from '#/test/fixtures'

import { categoryLedger } from './categories.server'

let testApi: TestApi
beforeEach(async () => {
  testApi = await startTestApi()
})
afterEach(() => testApi.close())

it('analyzes spending by the categories the person decided, in centavos', async () => {
  const account = await openChecking()
  await api((client) =>
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
  await testApi.drain()
  const { entries } = await api((client) => client.entries.list({ query: {} }))
  const market = entries.find((entry) => entry.description === 'Mercado Bom')!
  await api((client) =>
    client.categoryDecisions.decide({
      params: { entryId: market.id },
      payload: { categoryId: 'groceries' },
    }),
  )
  await testApi.drain()

  const ledger = await api(categoryLedger)
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
  await testApi.close()
  testApi = await startTestApi({
    rates: {
      USD: [
        ['2026-09-04', 5_000_000],
        ['2026-09-08', 5_500_000],
      ],
    },
  })
  const dollars = await openChecking('Conta em dólar', 'USD')
  const euros = await openChecking('Conta em euro', 'EUR')
  const lunch = await api((client) =>
    client.manual.createTransaction({
      payload: {
        accountId: dollars.id,
        bookedOn: '2026-09-05',
        amountCents: -2_000,
        description: 'Lunch',
      },
    }),
  )
  await api((client) =>
    client.manual.createTransaction({
      payload: {
        accountId: euros.id,
        bookedOn: '2026-09-05',
        amountCents: -1_000,
        description: 'Croissant',
      },
    }),
  )
  await testApi.drain()
  await api((client) =>
    client.categoryDecisions.decide({
      params: { entryId: lunch.entryId! },
      payload: { categoryId: 'restaurants' },
    }),
  )
  await testApi.drain()

  const ledger = await api(categoryLedger)
  // US$ 20.00 at the 4th's R$ 5.00; the euro, without a rate, stays out.
  expect(ledger.map((entry) => [entry.description, entry.amountCents])).toEqual(
    [['Lunch', -10_000]],
  )
})
