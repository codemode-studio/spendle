import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it } from 'vite-plus/test'

import { v2 } from '#/lib/v2/client.server'
import { startV2Api } from '#/test/v2-api'
import type { V2TestApi } from '#/test/v2-api'
import { openChecking } from '#/test/v2-fixtures'

import { entriesAt } from './entries.server'
import { patchEntryNote, v2QueryKeys } from './queries'

let api: V2TestApi
beforeEach(async () => {
  api = await startV2Api()
})
afterEach(() => api.close())

it('shows a typed-in transaction with its manual id and note on every cached page at once', async () => {
  const account = await openChecking()
  const created = await v2((client) =>
    client.manual.createTransaction({
      payload: {
        accountId: account.id,
        bookedOn: '2026-09-12',
        amountCents: -1000,
        description: 'Feira',
      },
    }),
  )
  const page = await v2((client) => entriesAt(client, {}, 0))
  const [entry] = page.entries
  expect([entry.manualId, entry.note]).toEqual([created.externalId, null])

  const queryClient = new QueryClient()
  const all = v2QueryKeys.entriesPage({ page: 0 })
  const searched = v2QueryKeys.entriesPage({ page: 0, text: 'feira' })
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
