import { afterEach, beforeEach, expect, it } from 'vite-plus/test'

import { v2 } from '#/lib/v2/client.server'
import { startV2Api } from '#/test/v2-api'
import type { V2TestApi } from '#/test/v2-api'
import { ofxStatement, openChecking, statementUpload } from '#/test/v2-fixtures'

let api: V2TestApi
beforeEach(async () => {
  api = await startV2Api()
})
afterEach(() => api.close())

const balanced = ofxStatement({
  start: '20260901',
  end: '20260902',
  closing: '900.00',
  lines: [
    { id: 'income', date: '20260901', amount: '1000.00', memo: 'Receita QA' },
    { id: 'expense', date: '20260902', amount: '-100.00', memo: 'Mercado QA' },
  ],
})

it('previews a statement, records it once and lists the import', async () => {
  const account = await openChecking()
  const preview = await v2((client) =>
    client.imports.preview({
      payload: statementUpload(account.id, balanced, 'balanced.ofx'),
    }),
  )
  expect(preview).toMatchObject({
    format: 'ofx',
    lineCount: 2,
    inflowCents: 100_000,
    outflowCents: -10_000,
    closingBalance: { asOf: '2026-09-02', cents: 90_000 },
  })
  expect(await v2((client) => client.imports.list({ query: {} }))).toEqual([])

  const first = await v2((client) =>
    client.imports.upload({
      payload: statementUpload(account.id, balanced, 'balanced.ofx'),
    }),
  )
  const again = await v2((client) =>
    client.imports.upload({
      payload: statementUpload(account.id, balanced, 'balanced.ofx'),
    }),
  )
  await api.drain()
  expect([first.recorded, again.alreadyImported, again.recorded]).toEqual([
    2,
    true,
    0,
  ])
  const page = await v2((client) =>
    client.entries.list({ query: { accountId: account.id } }),
  )
  expect(page.entries.map((entry) => entry.amountCents)).toEqual([
    -10_000, 100_000,
  ])
  const [listed] = await v2((client) => client.imports.list({ query: {} }))
  expect(listed).toMatchObject({
    fileName: 'balanced.ofx',
    periodStart: '2026-09-01',
    periodEnd: '2026-09-02',
  })
})

it('refuses a file that is not a statement with a reason the page can show', async () => {
  const account = await openChecking()
  const failure = await v2((client) =>
    client.imports.preview({
      payload: statementUpload(account.id, 'not a statement', 'notes.txt'),
    }),
  ).catch((error: unknown) => error)
  expect(failure).toMatchObject({
    tag: expect.stringMatching(/Rejected|InvalidRequest/),
  })
  expect((failure as Error).message).not.toBe('')
})
