import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it } from 'vite-plus/test'

import { api } from '#/lib/api/client.server'
import { startTestApi } from '#/test/api'
import type { TestApi } from '#/test/api'
import { ofxStatement, openChecking, statementUpload } from '#/test/fixtures'

import { entriesAt } from './entries.server'
import { patchEntryCategory, queryKeys } from './queries'

let testApi: TestApi
beforeEach(async () => {
  testApi = await startTestApi()
})
afterEach(() => testApi.close())

async function importVolume(count: number) {
  const account = await openChecking()
  const lines = Array.from({ length: count }, (_, index) => ({
    id: `volume-${index}`,
    date: '20260901',
    amount: '-1.00',
    memo: `Despesa QA ${index}`,
  }))
  lines.push({
    id: 'income',
    date: '20260902',
    amount: '500.01',
    memo: 'Receita',
  })
  await api((client) =>
    client.imports.upload({
      payload: statementUpload(
        account.id,
        ofxStatement({
          start: '20260901',
          end: '20260902',
          closing: (500.01 - count).toFixed(2),
          lines,
        }),
        'volume.ofx',
      ),
    }),
  )
  await testApi.drain()
  return account
}

it('serves numbered pages of 50 over the cursor API without repeating entries', async () => {
  await importVolume(120)
  const pages = await Promise.all(
    [0, 1, 2].map((page) => api((client) => entriesAt(client, {}, page))),
  )
  expect(pages.map((page) => page.entries.length)).toEqual([50, 50, 21])
  expect(pages.map((page) => page.total)).toEqual([121, 121, 121])
  const ids = pages.flatMap((page) => page.entries.map((entry) => entry.id))
  expect(new Set(ids).size).toBe(121)
  // Latest first: the income booked on the 2nd opens the first page.
  expect(pages[0].entries[0].amountCents).toBe(50_001)

  const beyond = await api((client) => entriesAt(client, {}, 9))
  expect([beyond.page, beyond.entries.length]).toEqual([2, 21])
  const outflows = await api((client) =>
    entriesAt(client, { direction: 'outflow', text: 'QA 11' }, 0),
  )
  expect(outflows.entries.map((entry) => entry.description).sort()).toEqual([
    'Despesa QA 11',
    'Despesa QA 110',
    'Despesa QA 111',
    'Despesa QA 112',
    'Despesa QA 113',
    'Despesa QA 114',
    'Despesa QA 115',
    'Despesa QA 116',
    'Despesa QA 117',
    'Despesa QA 118',
    'Despesa QA 119',
  ])
})

it('patches a decided category into every cached page and rolls it back', async () => {
  await importVolume(2)
  const page = await api((client) => entriesAt(client, {}, 0))
  const queryClient = new QueryClient()
  const first = queryKeys.entriesPage({ page: 0 })
  const filtered = queryKeys.entriesPage({ page: 0, direction: 'outflow' })
  queryClient.setQueryData(first, page)
  queryClient.setQueryData(filtered, {
    ...page,
    entries: page.entries.filter((entry) => entry.amountCents < 0),
  })
  const target = page.entries.find((entry) => entry.amountCents < 0)!
  const rollback = await patchEntryCategory(queryClient, {
    entryId: target.id,
    categoryId: 'groceries',
  })
  const categoryOf = (key: typeof first) =>
    queryClient
      .getQueryData<typeof page>(key)
      ?.entries.find((entry) => entry.id === target.id)?.category
  expect(categoryOf(first)).toMatchObject({
    categoryId: 'groceries',
    status: 'applied',
    origin: 'decision',
  })
  expect(categoryOf(filtered)).toMatchObject({ categoryId: 'groceries' })
  rollback()
  expect(categoryOf(first)).toEqual(target.category)
})
