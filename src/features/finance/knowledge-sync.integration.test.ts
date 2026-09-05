import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { db } from '#/db/index.server'
import * as schema from '#/db/schema'
import { resetTestDatabase } from '#/test/database'
import type { TestDatabase } from '#/test/database'
import * as finance from './finance.server'
import {
  applyKnowledgeSync,
  planKnowledgeSync,
  reviewKnowledgeCategoryAndSync,
  updateKnowledgePatternAndSync,
} from './knowledge-sync.server'

describe('sincronização das categorias com a base de conhecimento', () => {
  let database: TestDatabase

  beforeEach(async () => {
    database = await resetTestDatabase()
  })

  afterEach(() => {
    database.close()
  })

  async function expense(description: string, categoryId?: string) {
    return finance.createManualTransaction({
      targetType: 'account',
      targetId: database.ids.brlAccount,
      postedAt: '2026-08-10',
      description,
      direction: 'outflow',
      amountCents: 5_000,
      categoryId,
    })
  }

  async function categoriesById() {
    return Object.fromEntries(
      (await db.select().from(schema.transactions)).map((row) => [
        row.description,
        row.categoryId,
      ]),
    )
  }

  it('aplica o padrão aos lançamentos desatualizados e preserva categorias protegidas', async () => {
    const learned = await expense('LOJA DO BAIRRO 1111')
    await expense('LOJA DO BAIRRO 2222')
    await expense('LOJA DO BAIRRO 3333', database.ids.categories.housing)
    await expense('LOJA DO BAIRRO 4444', database.ids.categories.cardPayment)
    await expense('OUTRA LOJA 5555')
    await finance.updateTransactionCategory({
      transactionId: learned.id,
      categoryId: database.ids.categories.family,
      saveRule: false,
    })

    const plan = await planKnowledgeSync()
    expect(plan.scanned).toBe(5)
    expect(
      plan.changes.map((change) => [
        change.description,
        change.fromCategoryName,
        change.toCategoryName,
      ]),
    ).toEqual([
      ['LOJA DO BAIRRO 2222', 'Sem categoria', 'Família e filhos'],
      ['LOJA DO BAIRRO 3333', 'Moradia', 'Família e filhos'],
    ])

    expect(await applyKnowledgeSync()).toEqual({ changed: 2 })
    expect(await categoriesById()).toEqual({
      'LOJA DO BAIRRO 1111': database.ids.categories.family,
      'LOJA DO BAIRRO 2222': database.ids.categories.family,
      'LOJA DO BAIRRO 3333': database.ids.categories.family,
      'LOJA DO BAIRRO 4444': database.ids.categories.cardPayment,
      'OUTRA LOJA 5555': 'uncategorized',
    })
    expect((await planKnowledgeSync()).changes).toEqual([])
  })

  it('reaplica só os lançamentos da entrada editada e depois do padrão ampliado', async () => {
    const first = await expense('LOJA DO BAIRRO 1111')
    await expense('LOJA DO BAIRRO 2222')
    const other = await expense('LOJA CENTRAL 9999')
    await finance.updateTransactionCategory({
      transactionId: first.id,
      categoryId: database.ids.categories.family,
      saveRule: false,
    })
    await finance.updateTransactionCategory({
      transactionId: other.id,
      categoryId: database.ids.categories.housing,
      saveRule: false,
    })
    const [entry] = await db
      .select()
      .from(schema.knowledgeBase)
      .where(eq(schema.knowledgeBase.pattern, 'loja do bairro'))

    expect(
      await reviewKnowledgeCategoryAndSync({
        id: entry.id,
        categoryId: database.ids.categories.leisure,
      }),
    ).toEqual({ id: entry.id, synced: 2 })
    expect(await categoriesById()).toMatchObject({
      'LOJA DO BAIRRO 1111': database.ids.categories.leisure,
      'LOJA DO BAIRRO 2222': database.ids.categories.leisure,
      'LOJA CENTRAL 9999': database.ids.categories.housing,
    })

    expect(
      await updateKnowledgePatternAndSync({
        id: entry.id,
        pattern: 'loja',
        matchMode: 'prefix',
      }),
    ).toEqual({ id: entry.id, pattern: 'loja', synced: 0 })
    expect(await categoriesById()).toMatchObject({
      'LOJA CENTRAL 9999': database.ids.categories.housing,
    })
  })
})
