import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it } from 'vite-plus/test'

import { api } from '#/lib/api/client.server'
import { startTestApi } from '#/test/api'
import type { TestApi } from '#/test/api'
import { openChecking } from '#/test/fixtures'

import { entriesAt } from './entries.server'
import { patchEntryNote, queryKeys } from './queries'

let testApi: TestApi
beforeEach(async () => {
  testApi = await startTestApi()
})
afterEach(() => testApi.close())

it('shows a typed-in transaction with its manual id and note on every cached page at once', async () => {
  const account = await openChecking()
  const created = await api((client) =>
    client.manual.createTransaction({
      payload: {
        accountId: account.id,
        bookedOn: '2026-09-12',
        amountCents: -1000,
        description: 'Feira',
      },
    }),
  )
  const page = await api((client) => entriesAt(client, {}, 0))
  const [entry] = page.entries
  expect([entry.manualId, entry.note]).toEqual([created.externalId, null])

  const queryClient = new QueryClient()
  const all = queryKeys.entriesPage({ page: 0 })
  const searched = queryKeys.entriesPage({ page: 0, text: 'feira' })
  queryClient.setQueryData(all, page)
  queryClient.setQueryData(searched, page)
  const rollback = await patchEntryNote(queryClient, {
    entryId: entry.id,
    note: 'Em dinheiro',
  })
  const noteIn = (key: typeof all) =>
    queryClient.getQueryData<typeof page>(key)?.entries[0]?.note
  expect([noteIn(all), noteIn(searched)]).toEqual([
    'Em dinheiro',
    'Em dinheiro',
  ])
  rollback()
  expect(noteIn(all)).toBeNull()
})
