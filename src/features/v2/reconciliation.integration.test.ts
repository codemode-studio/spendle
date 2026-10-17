import { afterEach, beforeEach, expect, it } from 'vite-plus/test'

import { v2 } from '#/lib/v2/client.server'
import { startV2Api } from '#/test/v2-api'
import type { V2TestApi } from '#/test/v2-api'
import { ofxStatement, openChecking, statementUpload } from '#/test/v2-fixtures'

import { linkCandidates } from './reconciliation.server'

let api: V2TestApi
beforeEach(async () => {
  api = await startV2Api()
})
afterEach(() => api.close())

async function upload(
  accountId: string,
  lines: Parameters<typeof ofxStatement>[0]['lines'],
  closing: string,
) {
  await v2((client) =>
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
  const savings = await v2((client) =>
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
  await api.drain()

  const [relation] = await v2((client) =>
    client.reconciliation.relations({ query: {} }),
  )
  expect(relation).toMatchObject({
    kind: 'internal_transfer',
    outflow: { amountCents: -25_001, accountId: checking.id },
    inflow: { amountCents: 25_001, accountId: savings.id },
  })

  await v2((client) =>
    client.reconciliation.decide({
      payload: { key: relation.key, decision: 'rejected' },
    }),
  )
  await api.drain()
  expect(
    await v2((client) => client.reconciliation.relations({ query: {} })),
  ).toEqual([])

  const { candidates } = await v2((client) =>
    linkCandidates(client, relation.outflowEntryId),
  )
  expect(candidates.map((entry) => entry.id)).toEqual([relation.inflowEntryId])
  await v2((client) =>
    client.reconciliation.link({
      payload: {
        outflowEntryId: relation.outflowEntryId,
        inflowEntryId: relation.inflowEntryId,
      },
    }),
  )
  await api.drain()
  const [linked] = await v2((client) =>
    client.reconciliation.relations({ query: { status: 'confirmed' } }),
  )
  expect(linked).toMatchObject({ origin: 'person', kind: 'internal_transfer' })
  const outflow = await v2((client) =>
    client.entries.get({ params: { entryId: relation.outflowEntryId } }),
  )
  expect(outflow.entry.category).toMatchObject({ excludedFromSpending: true })
})
