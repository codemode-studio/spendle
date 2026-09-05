import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { openTestDatabase } from '#/test/database'
import type { TestDatabase } from '#/test/database'

const migration = readFileSync(
  resolve(process.cwd(), 'drizzle/0035_reclassify_food_categories.sql'),
  'utf8',
)

function runMigration(database: TestDatabase) {
  for (const statement of migration.split('--> statement-breakpoint')) {
    database.db.run(sql.raw(statement))
  }
}

describe('migração 0035: reclassificação de comida', () => {
  let database: TestDatabase

  beforeAll(async () => {
    database = await openTestDatabase()
    const { db, schema, ids } = database
    const createdAt = new Date('2026-08-01T12:00:00Z')

    // Simula o banco antes da migração: Alimentação ativa e categorias novas ausentes.
    await db
      .update(schema.categories)
      .set({ active: true })
      .where(eq(schema.categories.id, 'food'))
    await db
      .delete(schema.categories)
      .where(eq(schema.categories.id, 'groceries'))
    await db
      .delete(schema.categories)
      .where(eq(schema.categories.id, 'restaurants'))

    await db.insert(schema.sourceFiles).values({
      id: 'legacy-source',
      sha256: 'legacy-sha',
      originalName: 'legacy.ofx',
      mediaType: 'application/x-ofx',
      sizeBytes: 10,
      storagePath: '/tmp/legacy.ofx',
    })
    await db.insert(schema.imports).values({
      id: 'legacy-import',
      sourceFileId: 'legacy-source',
      accountId: ids.brlAccount,
      parser: 'ofx',
      status: 'committed',
    })
    const row = (input: {
      id: string
      description: string
      categoryId: string
      creditCard?: boolean
    }) => ({
      id: input.id,
      importId: 'legacy-import',
      accountId: input.creditCard ? null : ids.brlAccount,
      creditCardId: input.creditCard ? ids.card : null,
      categoryId: input.categoryId,
      fingerprint: `fp-${input.id}`,
      postedAt: '2026-08-10',
      description: input.description,
      normalizedDescription: input.description.toLowerCase(),
      amountCents: -5_000,
      currency: 'BRL',
      createdAt,
    })
    await db.insert(schema.transactions).values([
      row({
        id: 'tx-angeloni',
        description: 'Angeloni Super Loja',
        categoryId: 'food',
      }),
      row({
        id: 'tx-mercadolivre',
        description: 'MERCADOLIVRE*MERCADOL (Parcela 01 de 02)',
        categoryId: 'food',
        creditCard: true,
      }),
      row({
        id: 'tx-vacuno',
        description: 'V A C U N O Sapiens Pa',
        categoryId: 'food',
      }),
      row({
        id: 'tx-unknown-food',
        description: 'PADARIA SEM LISTA',
        categoryId: 'food',
      }),
      row({
        id: 'tx-cafe',
        description: 'Cafe Cultura Jurere',
        categoryId: 'leisure',
      }),
      row({
        id: 'tx-whoosh',
        description: 'Pix enviado WHOOSH BR ALUGUEL',
        categoryId: 'leisure',
      }),
      row({ id: 'tx-easy', description: 'Easy Food', categoryId: 'leisure' }),
      row({
        id: 'tx-other-angeloni',
        description: 'ANGELONI SUPER LOJA 41',
        categoryId: 'housing',
      }),
    ])
    const staged = (id: string, description: string, suggested: string) => ({
      id,
      importId: 'legacy-import',
      fingerprint: `fp-${id}`,
      postedAt: '2026-08-10',
      description,
      normalizedDescription: description.toLowerCase(),
      amountCents: -5_000,
      currency: 'BRL',
      suggestedCategoryId: suggested,
      suggestionSource: 'heuristic' as const,
    })
    await db
      .insert(schema.stagedTransactions)
      .values([
        staged('st-angeloni', 'Angeloni Super Loja', 'food'),
        staged('st-cafe-orphan', 'Cafe Cultura Jurere', 'leisure'),
        staged('st-unknown', 'PADARIA SEM LISTA', 'food'),
      ])
    await db.insert(schema.transactionEvidence).values({
      id: 'ev-angeloni',
      stagedTransactionId: 'st-angeloni',
      transactionId: 'tx-angeloni',
      matchKind: 'created',
    })
    await db.insert(schema.installmentPlans).values({
      id: 'plan-mercadolivre',
      creditCardId: ids.card,
      sourceTransactionId: 'tx-mercadolivre',
      description: 'MERCADOLIVRE*MERCADOL',
      categoryId: 'food',
      installmentAmountCents: 5_000,
      totalInstallments: 2,
      currentInstallment: 1,
      firstChargeDate: '2026-08-10',
    })
    await db.insert(schema.transactionSplits).values({
      id: 'split-cafe',
      transactionId: 'tx-cafe',
      categoryId: 'leisure',
      amountCents: -5_000,
    })
    await db.insert(schema.recurrences).values({
      id: 'rec-mercado',
      name: 'Mercado',
      categoryId: 'food',
      amountCents: 100_000,
      frequency: 'monthly',
      matchMode: 'aggregate',
      nextDate: '2026-09-10',
    })
    await db.insert(schema.recurrenceOccurrences).values({
      id: 'occ-mercado',
      recurrenceId: 'rec-mercado',
      expectedDate: '2026-08-10',
      expectedAmountCents: 100_000,
      currency: 'BRL',
      direction: 'expense',
      categoryId: 'food',
      status: 'matched',
    })
    await db.insert(schema.recurrenceMatches).values({
      id: 'match-angeloni',
      occurrenceId: 'occ-mercado',
      transactionId: 'tx-angeloni',
      status: 'confirmed',
      score: 100,
      reason: 'vinculado manualmente',
      previousCategoryId: 'food',
    })
    await db.insert(schema.knowledgeBase).values([
      {
        id: 'kb-angeloni',
        kind: 'category',
        signature: 'angeloni super loja',
        pattern: 'angeloni super loja',
        direction: 'expense',
        categoryId: 'food',
        sampleDescription: 'Angeloni Super Loja',
        source: 'transaction_review',
        confirmations: 4,
      },
      {
        id: 'kb-cafe',
        kind: 'category',
        signature: 'cafe cultura jurere',
        pattern: 'cafe cultura jurere',
        direction: 'expense',
        categoryId: 'leisure',
        sampleDescription: 'Cafe Cultura Jurere',
        source: 'transaction_review',
      },
      {
        id: 'kb-whoosh',
        kind: 'category',
        signature: 'enviado whoosh br aluguel',
        pattern: 'enviado whoosh br aluguel',
        direction: 'expense',
        categoryId: 'leisure',
        sampleDescription: 'Pix enviado WHOOSH BR ALUGUEL',
        source: 'transaction_review',
      },
      {
        id: 'kb-food-orphan',
        kind: 'category',
        signature: 'padaria sem lista',
        pattern: 'padaria sem lista',
        direction: 'expense',
        categoryId: 'food',
        sampleDescription: 'PADARIA SEM LISTA',
        source: 'transaction_review',
      },
      {
        id: 'kb-em-conta',
        kind: 'category',
        signature: 'em conta',
        pattern: 'em conta',
        direction: 'expense',
        categoryId: ids.categories.insurance,
        sampleDescription: 'Débito em conta',
        source: 'recurrence_link',
      },
      {
        id: 'kb-rec-angeloni',
        kind: 'recurrence',
        signature: 'angeloni super loja',
        pattern: 'angeloni super loja',
        direction: 'expense',
        recurrenceId: 'rec-mercado',
        sampleDescription: 'ANGELONI SUPER LOJA 41',
        source: 'recurrence_link',
      },
    ])
  })

  afterAll(() => {
    database.close()
  })

  it('cria as categorias, inativa Alimentação e move só os estabelecimentos listados', async () => {
    const { db, schema } = database

    runMigration(database)

    const categories = await db.select().from(schema.categories)
    expect(categories.find((c) => c.id === 'groceries')).toMatchObject({
      name: 'Mercado',
      bucket: 'essential',
      active: true,
    })
    expect(categories.find((c) => c.id === 'restaurants')).toMatchObject({
      name: 'Restaurantes',
      bucket: 'lifestyle',
      active: true,
    })
    expect(categories.find((c) => c.id === 'food')).toMatchObject({
      active: false,
    })

    const transactions = Object.fromEntries(
      (await db.select().from(schema.transactions)).map((t) => [
        t.id,
        t.categoryId,
      ]),
    )
    expect(transactions).toEqual({
      'tx-angeloni': 'groceries',
      'tx-mercadolivre': 'shopping',
      'tx-vacuno': 'restaurants',
      'tx-unknown-food': 'food',
      'tx-cafe': 'restaurants',
      'tx-whoosh': 'leisure',
      'tx-easy': 'delivery',
      'tx-other-angeloni': 'housing',
    })

    const staged = Object.fromEntries(
      (await db.select().from(schema.stagedTransactions)).map((s) => [
        s.id,
        s.suggestedCategoryId,
      ]),
    )
    expect(staged).toEqual({
      'st-angeloni': 'groceries',
      'st-cafe-orphan': 'restaurants',
      'st-unknown': 'food',
    })

    expect(await db.select().from(schema.installmentPlans)).toMatchObject([
      { id: 'plan-mercadolivre', categoryId: 'shopping' },
    ])
    expect(await db.select().from(schema.transactionSplits)).toMatchObject([
      { id: 'split-cafe', categoryId: 'restaurants' },
    ])
    expect(await db.select().from(schema.recurrenceMatches)).toMatchObject([
      { id: 'match-angeloni', previousCategoryId: 'groceries' },
    ])
    expect(await db.select().from(schema.recurrences)).toMatchObject([
      { id: 'rec-mercado', categoryId: 'groceries' },
    ])
    expect(await db.select().from(schema.recurrenceOccurrences)).toMatchObject([
      { id: 'occ-mercado', categoryId: 'groceries' },
    ])

    const knowledge = Object.fromEntries(
      (await db.select().from(schema.knowledgeBase)).map((entry) => [
        entry.id,
        { categoryId: entry.categoryId, confirmations: entry.confirmations },
      ]),
    )
    expect(knowledge).toEqual({
      'kb-angeloni': { categoryId: 'groceries', confirmations: 4 },
      'kb-cafe': { categoryId: 'restaurants', confirmations: 1 },
      'kb-whoosh': { categoryId: 'leisure', confirmations: 1 },
      'kb-rec-angeloni': { categoryId: null, confirmations: 1 },
    })
  })

  it('é idempotente', async () => {
    const { db, schema } = database
    const before = await db.select().from(schema.transactions)
    runMigration(database)
    expect(await db.select().from(schema.transactions)).toEqual(before)
    expect(await db.select().from(schema.knowledgeBase)).toHaveLength(4)
  })
})
