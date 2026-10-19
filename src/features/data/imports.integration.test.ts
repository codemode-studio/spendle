import { afterEach, beforeEach, expect, it } from 'vite-plus/test'

import { api } from '#/lib/api/client.server'
import { startTestApi } from '#/test/api'
import type { TestApi } from '#/test/api'
import { ofxStatement, openChecking, statementUpload } from '#/test/fixtures'

let testApi: TestApi
beforeEach(async () => {
  testApi = await startTestApi()
})
afterEach(() => testApi.close())

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
  const preview = await api((client) =>
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
  expect(await api((client) => client.imports.list({ query: {} }))).toEqual([])

  const first = await api((client) =>
    client.imports.upload({
      payload: statementUpload(account.id, balanced, 'balanced.ofx'),
    }),
  )
  const again = await api((client) =>
    client.imports.upload({
      payload: statementUpload(account.id, balanced, 'balanced.ofx'),
    }),
  )
  await testApi.drain()
  expect([first.recorded, again.alreadyImported, again.recorded]).toEqual([
    2,
    true,
    0,
  ])
  const page = await api((client) =>
    client.entries.list({ query: { accountId: account.id } }),
  )
  expect(page.entries.map((entry) => entry.amountCents)).toEqual([
    -10_000, 100_000,
  ])
  const [listed] = await api((client) => client.imports.list({ query: {} }))
  expect(listed).toMatchObject({
    fileName: 'balanced.ofx',
    periodStart: '2026-09-01',
    periodEnd: '2026-09-02',
  })
})

it('refuses a file past the size limit with a message the page can show', async () => {
  const account = await openChecking()
  const failure = await api((client) =>
    client.imports.preview({
      payload: statementUpload(
        account.id,
        balanced + ' '.repeat(1_600_000),
        'large.ofx',
      ),
    }),
  ).catch((error: unknown) => error)
  expect(failure).toMatchObject({
    reason: 'file_too_large',
    message: 'O arquivo passa de 1,5 MB, o limite por extrato.',
  })
})

it('refuses a file that is not a statement with a reason the page can show', async () => {
  const account = await openChecking()
  const failure = await api((client) =>
    client.imports.preview({
      payload: statementUpload(account.id, 'not a statement', 'notes.txt'),
    }),
  ).catch((error: unknown) => error)
  expect(failure).toMatchObject({
    tag: expect.stringMatching(/Rejected|InvalidRequest/),
  })
  expect((failure as Error).message).not.toBe('')
})
