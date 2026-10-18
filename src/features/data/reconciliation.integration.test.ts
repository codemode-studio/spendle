import { afterEach, beforeEach, expect, it } from 'vite-plus/test'

import { api } from '#/lib/api/client.server'
import { startTestApi } from '#/test/api'
import type { TestApi } from '#/test/api'
import { ofxStatement, openChecking, statementUpload } from '#/test/fixtures'

import { linkCandidates } from './reconciliation.server'

let testApi: TestApi
beforeEach(async () => {
  testApi = await startTestApi()
})
afterEach(() => testApi.close())

async function upload(
  accountId: string,
  lines: Parameters<typeof ofxStatement>[0]['lines'],
  closing: string,
) {
  await api((client) =>
    client.imports.upload({
      payload: statementUpload(
        accountId,
        ofxStatement({ start: '20260901', end: '20260930', closing, lines }),
        `${accountId}.ofx`,
      ),
    }),
  )
}

it('keeps both sides of a transfer, lets the person reject it and link the pair by hand', async () => {
  const checking = await openChecking('Corrente')
  const savings = await api((client) =>
    client.accounts.open({
      payload: {
        ownerId: checking.ownerId,
        institutionName: 'Banco',
        name: 'Reserva',
        kind: 'savings',
        purpose: 'reserve',
        currency: 'BRL',
      },
    }),
  )
  await upload(
    checking.id,
    [
      {
        id: 'out',
        date: '20260910',
        amount: '-250.01',
        memo: 'Transferencia para reserva',
      },
    ],
    '-250.01',
  )
  await upload(
    savings.id,
    [
      {
        id: 'in',
        date: '20260910',
        amount: '250.01',
        memo: 'Transferencia recebida',
      },
    ],
    '250.01',
  )
  await testApi.drain()

  const [relation] = await api((client) =>
    client.reconciliation.relations({ query: {} }),
  )
  expect(relation).toMatchObject({
    kind: 'internal_transfer',
    outflow: { amountCents: -25_001, accountId: checking.id },
    inflow: { amountCents: 25_001, accountId: savings.id },
  })

  await api((client) =>
    client.reconciliation.decide({
      payload: { key: relation.key, decision: 'rejected' },
    }),
  )
  await testApi.drain()
  expect(
    await api((client) => client.reconciliation.relations({ query: {} })),
  ).toEqual([])

  const { candidates } = await api((client) =>
    linkCandidates(client, relation.outflowEntryId),
  )
  expect(candidates.map((entry) => entry.id)).toEqual([relation.inflowEntryId])
  await api((client) =>
    client.reconciliation.link({
      payload: {
        outflowEntryId: relation.outflowEntryId,
        inflowEntryId: relation.inflowEntryId,
      },
    }),
  )
  await testApi.drain()
  const [linked] = await api((client) =>
    client.reconciliation.relations({ query: { status: 'confirmed' } }),
  )
  expect(linked).toMatchObject({ origin: 'person', kind: 'internal_transfer' })
  const outflow = await api((client) =>
    client.entries.get({ params: { entryId: relation.outflowEntryId } }),
  )
  expect(outflow.entry.category).toMatchObject({ excludedFromSpending: true })
})
