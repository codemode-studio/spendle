import { afterEach, beforeEach, expect, it } from 'vitest'
import { openTestDatabase } from '#/test/database'
import type { TestDatabase } from '#/test/database'
import { transactionFiltersSchema } from './transactions.filters'
import { getTransactionsPage } from './transactions.server'

let database: TestDatabase
beforeEach(async () => {
  database = await openTestDatabase()
})
afterEach(() => database.close())

it('exibe a fonte canônica mesmo com uma correção rejeitada em outra importação', async () => {
  const { db, schema: s, ids } = database
  for (const [id, date] of [
    ['original', '20 de mar. 2026'],
    ['rejected', '21 de mar. 2026'],
  ]) {
    await db.insert(s.sourceFiles).values({
      id,
      sha256: id,
      originalName: `${id}.pdf`,
      mediaType: 'application/pdf',
      sizeBytes: 1,
      storagePath: `${database.directory}/${id}.pdf`,
    })
    await db.insert(s.imports).values({
      id,
      sourceFileId: id,
      creditCardId: ids.card,
      parser: 'pdf_local',
      statementDueDate: id === 'original' ? '2026-05-15' : '2026-06-15',
    })
    await db.insert(s.stagedTransactions).values({
      id,
      importId: id,
      fingerprint: id,
      postedAt: '2026-04-20',
      description: 'Compra parcela 2/3',
      normalizedDescription: 'compra parcela',
      amountCents: -10_000,
      currency: 'BRL',
      sourcePage: 2,
      rawJson: JSON.stringify({ line: `${date} Compra parcela 2/3 R$ 100,00` }),
    })
  }
  await db.insert(s.transactions).values({
    id: 'purchase',
    importId: 'original',
    creditCardId: ids.card,
    fingerprint: 'purchase',
    postedAt: '2026-04-20',
    description: 'Compra parcela 2/3',
    normalizedDescription: 'compra parcela',
    amountCents: -10_000,
    currency: 'BRL',
  })
  await db.insert(s.transactionEvidence).values([
    {
      id: 'a',
      transactionId: 'purchase',
      stagedTransactionId: 'original',
      matchKind: 'created',
    },
    {
      id: 'b',
      transactionId: 'purchase',
      stagedTransactionId: 'rejected',
      matchKind: 'rejected_correction',
    },
  ])
  const page = await getTransactionsPage(transactionFiltersSchema.parse({}))
  expect(
    page.transactions.find((row) => row.id === 'purchase')?.sourceDocument,
  ).toEqual({
    date: '2026-03-20',
    file: 'original.pdf',
    page: 2,
    dueDate: '2026-05-15',
  })
  expect(await db.select().from(s.transactionEvidence)).toHaveLength(2)
})
