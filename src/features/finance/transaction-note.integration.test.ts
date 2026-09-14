import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { openTestDatabase } from '#/test/database'
import type { TestDatabase } from '#/test/database'
import {
  createManualTransaction,
  updateTransactionNote,
} from './finance.server'
import { getTransactionsPage } from './transactions.server'

const filters = {
  search: '',
  target: 'all',
  category: 'all',
  onlyUncategorized: false,
  direction: 'all' as const,
  minCents: null,
  maxCents: null,
  dateFrom: null,
  dateTo: null,
  page: 0,
}

describe('nota da transação', () => {
  let database: TestDatabase

  beforeAll(async () => {
    database = await openTestDatabase()
  })

  afterAll(() => database.close())

  it('salva, encontra pela busca e remove a nota sem alterar a descrição', async () => {
    const transaction = await createManualTransaction({
      targetType: 'account',
      targetId: database.ids.brlAccount,
      postedAt: '2026-09-14',
      description: 'Restaurante Central',
      direction: 'outflow',
      amountCents: 12_345,
    })

    await updateTransactionNote({
      transactionId: transaction.id,
      note: 'Jantar de aniversário',
    })

    const result = await getTransactionsPage({
      ...filters,
      search: 'aniversario',
    })
    expect(result.transactions).toEqual([
      expect.objectContaining({
        id: transaction.id,
        description: 'Restaurante Central',
        notes: 'Jantar de aniversário',
      }),
    ])

    await updateTransactionNote({ transactionId: transaction.id, note: null })
    const [stored] = await database.db
      .select()
      .from(database.schema.transactions)
    expect(stored).toMatchObject({
      id: transaction.id,
      description: 'Restaurante Central',
      notes: null,
    })
  })
})
