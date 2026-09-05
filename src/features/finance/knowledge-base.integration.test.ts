import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { db } from '#/db/index.server'
import * as schema from '#/db/schema'
import { resetTestDatabase } from '#/test/database'
import type { TestDatabase } from '#/test/database'
import * as finance from './finance.server'
import { clearTransactionData, stageImport } from './import.server'
import {
  loadRecurrenceKnowledge,
  updateKnowledgePattern,
} from './knowledge-base.server'
import * as recurrence from './recurrence.server'

function ofxStatement(
  rows: Array<{ id: string; date: string; amount: string; name: string }>,
) {
  const transactions = rows
    .map(
      (row) =>
        `<STMTTRN><TRNTYPE>${row.amount.startsWith('-') ? 'DEBIT' : 'CREDIT'}</TRNTYPE><DTPOSTED>${row.date.replaceAll('-', '')}120000[-3:BRT]</DTPOSTED><TRNAMT>${row.amount}</TRNAMT><FITID>${row.id}</FITID><NAME>${row.name}</NAME></STMTTRN>`,
    )
    .join('')
  const dates = rows.map((row) => row.date.replaceAll('-', '')).sort()
  return new File(
    [
      `OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\nSECURITY:NONE\nENCODING:USASCII\nCHARSET:1252\nCOMPRESSION:NONE\nOLDFILEUID:NONE\nNEWFILEUID:NONE\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL</CURDEF><BANKTRANLIST><DTSTART>${dates[0]}</DTSTART><DTEND>${dates.at(-1)}</DTEND>${transactions}</BANKTRANLIST><LEDGERBAL><BALAMT>0.00</BALAMT><DTASOF>${dates.at(-1)}</DTASOF></LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`,
    ],
    `extrato-${rows[0].id}.ofx`,
  )
}

async function knowledgeEntries(kind: 'category' | 'recurrence') {
  return db
    .select()
    .from(schema.knowledgeBase)
    .where(eq(schema.knowledgeBase.kind, kind))
    .orderBy(schema.knowledgeBase.signature)
}

async function stagedRowsOf(importId: string) {
  return db
    .select()
    .from(schema.stagedTransactions)
    .where(eq(schema.stagedTransactions.importId, importId))
}

describe('base de conhecimento das importações', () => {
  let database: TestDatabase

  beforeEach(async () => {
    database = await resetTestDatabase()
  })

  afterEach(() => {
    database.close()
  })

  it('aprende a categoria decidida na lista, reafirma e corrige a decisão', async () => {
    const transaction = await finance.createManualTransaction({
      targetType: 'account',
      targetId: database.ids.brlAccount,
      postedAt: '2026-08-03',
      description: 'LOJA DO BAIRRO 4421 12/08',
      direction: 'outflow',
      amountCents: 4_500,
    })

    await finance.updateTransactionCategory({
      transactionId: transaction.id,
      categoryId: database.ids.categories.family,
      saveRule: false,
    })
    expect(await knowledgeEntries('category')).toMatchObject([
      {
        kind: 'category',
        signature: 'loja do bairro',
        direction: 'expense',
        categoryId: database.ids.categories.family,
        recurrenceId: null,
        sampleDescription: 'LOJA DO BAIRRO 4421 12/08',
        source: 'transaction_review',
        confirmations: 1,
        corrections: 0,
      },
    ])

    await finance.updateTransactionCategory({
      transactionId: transaction.id,
      categoryId: database.ids.categories.family,
      saveRule: false,
    })
    expect(await knowledgeEntries('category')).toMatchObject([
      { confirmations: 2, corrections: 0 },
    ])

    await finance.updateTransactionCategory({
      transactionId: transaction.id,
      categoryId: database.ids.categories.leisure,
      saveRule: false,
    })
    expect(await knowledgeEntries('category')).toMatchObject([
      {
        categoryId: database.ids.categories.leisure,
        confirmations: 1,
        corrections: 1,
      },
    ])
    expect(await db.select().from(schema.categorizationRules)).toHaveLength(0)
  })

  it('não aprende categorias de sistema nem descrições sem assinatura', async () => {
    const transaction = await finance.createManualTransaction({
      targetType: 'account',
      targetId: database.ids.brlAccount,
      postedAt: '2026-08-03',
      description: 'PIX 20260803 1234',
      direction: 'outflow',
      amountCents: 10_000,
    })
    await finance.updateTransactionCategory({
      transactionId: transaction.id,
      categoryId: database.ids.categories.family,
      saveRule: false,
    })
    const named = await finance.createManualTransaction({
      targetType: 'account',
      targetId: database.ids.brlAccount,
      postedAt: '2026-08-04',
      description: 'CONTA DO SEU JOAO',
      direction: 'outflow',
      amountCents: 10_000,
    })
    await finance.updateTransactionCategory({
      transactionId: named.id,
      categoryId: database.ids.categories.transfer,
      saveRule: false,
    })
    await finance.updateTransactionCategory({
      transactionId: named.id,
      categoryId: database.ids.categories.uncategorized,
      saveRule: false,
    })

    expect(await knowledgeEntries('category')).toEqual([])
  })

  it('sugere a categoria aprendida na próxima importação, acima da heurística', async () => {
    const [store, market] = await Promise.all([
      finance.createManualTransaction({
        targetType: 'account',
        targetId: database.ids.brlAccount,
        postedAt: '2026-07-03',
        description: 'LOJA DO BAIRRO 4421',
        direction: 'outflow',
        amountCents: 4_500,
      }),
      finance.createManualTransaction({
        targetType: 'account',
        targetId: database.ids.brlAccount,
        postedAt: '2026-07-04',
        description: 'SUPERMERCADO BOM 7788',
        direction: 'outflow',
        amountCents: 30_000,
      }),
    ])
    await finance.updateTransactionCategory({
      transactionId: store.id,
      categoryId: database.ids.categories.family,
      saveRule: false,
    })
    await finance.updateTransactionCategory({
      transactionId: market.id,
      categoryId: database.ids.categories.housing,
      saveRule: false,
    })

    const staged = await stageImport({
      file: ofxStatement([
        {
          id: 'kb-1',
          date: '2026-08-10',
          amount: '-52.00',
          name: 'LOJA DO BAIRRO 9090',
        },
        {
          id: 'kb-2',
          date: '2026-08-11',
          amount: '-310.00',
          name: 'SUPERMERCADO BOM 1010',
        },
        {
          id: 'kb-3',
          date: '2026-08-12',
          amount: '52.00',
          name: 'LOJA DO BAIRRO 9090',
        },
      ]),
      targetType: 'account',
      targetId: database.ids.brlAccount,
      aiConsent: false,
    })
    const rows = await stagedRowsOf(staged.importId)
    const byDescription = new Map(
      rows.map((row) => [`${row.description}|${row.amountCents}`, row]),
    )

    expect(byDescription.get('LOJA DO BAIRRO 9090|-5200')).toMatchObject({
      suggestedCategoryId: database.ids.categories.family,
      suggestionSource: 'knowledge',
      suggestionConfidence: 98,
    })
    expect(byDescription.get('SUPERMERCADO BOM 1010|-31000')).toMatchObject({
      suggestedCategoryId: database.ids.categories.housing,
      suggestionSource: 'knowledge',
    })
    expect(byDescription.get('LOJA DO BAIRRO 9090|5200')).toMatchObject({
      suggestedCategoryId: 'uncategorized',
      suggestionSource: 'none',
    })
  })

  it('aprende a revisão feita no lote e mantém o conhecimento após limpar o ledger', async () => {
    const staged = await stageImport({
      file: ofxStatement([
        {
          id: 'review-1',
          date: '2026-08-10',
          amount: '-52.00',
          name: 'LOJA DO BAIRRO 9090',
        },
      ]),
      targetType: 'account',
      targetId: database.ids.brlAccount,
      aiConsent: false,
    })
    const [row] = await stagedRowsOf(staged.importId)
    await finance.updateStagedTransactionCategory({
      stagedTransactionId: row.id,
      categoryId: database.ids.categories.leisure,
    })
    expect(await knowledgeEntries('category')).toMatchObject([
      {
        signature: 'loja do bairro',
        categoryId: database.ids.categories.leisure,
        source: 'import_review',
      },
    ])

    await clearTransactionData()
    expect(await db.select().from(schema.transactions)).toEqual([])
    expect(await knowledgeEntries('category')).toHaveLength(1)

    const again = await stageImport({
      file: ofxStatement([
        {
          id: 'review-2',
          date: '2026-09-10',
          amount: '-60.00',
          name: 'LOJA DO BAIRRO 55555',
        },
      ]),
      targetType: 'account',
      targetId: database.ids.brlAccount,
      aiConsent: false,
    })
    expect(await stagedRowsOf(again.importId)).toMatchObject([
      {
        suggestedCategoryId: database.ids.categories.leisure,
        suggestionSource: 'knowledge',
      },
    ])
  })

  it('aprende o estabelecimento de uma recorrência ao confirmar e esquece ao desvincular', async () => {
    const created = await recurrence.createRecurrence({
      name: 'Netflix',
      categoryId: database.ids.categories.subscriptions,
      amountCents: 3_990,
      currency: 'BRL',
      direction: 'expense',
      amountMode: 'fixed',
      destinationMode: 'automatic',
      frequency: 'monthly',
      nextDate: '2026-08-10',
    })
    const transaction = await finance.createManualTransaction({
      targetType: 'account',
      targetId: database.ids.brlAccount,
      postedAt: '2026-08-10',
      description: 'PG *NETFLIX.COM 847291',
      direction: 'outflow',
      amountCents: 3_990,
    })
    await recurrence.refreshRecurrences()
    const [suggested] = await db
      .select()
      .from(schema.recurrenceMatches)
      .where(
        and(
          eq(schema.recurrenceMatches.transactionId, transaction.id),
          eq(schema.recurrenceMatches.status, 'suggested'),
        ),
      )
    expect(suggested).toBeDefined()
    expect(await knowledgeEntries('recurrence')).toEqual([])

    await recurrence.confirmMatch(suggested.id)
    expect(await knowledgeEntries('recurrence')).toMatchObject([
      {
        signature: 'netflix com',
        direction: 'expense',
        recurrenceId: created.id,
        categoryId: null,
        source: 'recurrence_link',
      },
    ])
    expect(await knowledgeEntries('category')).toMatchObject([
      {
        signature: 'netflix com',
        categoryId: database.ids.categories.subscriptions,
        source: 'recurrence_link',
      },
    ])
    expect(await loadRecurrenceKnowledge()).toEqual(
      new Map([[created.id, new Set(['netflix com'])]]),
    )

    await recurrence.unlinkMatch(suggested.id)
    expect(await knowledgeEntries('recurrence')).toEqual([])
    expect(await knowledgeEntries('category')).toHaveLength(1)
  })

  it('registra a aprovação de um candidato detectado e remove o vínculo com a recorrência', async () => {
    for (const [index, postedAt] of [
      '2026-06-10',
      '2026-07-10',
      '2026-08-10',
    ].entries()) {
      await finance.createManualTransaction({
        targetType: 'account',
        targetId: database.ids.brlAccount,
        postedAt,
        description: `SPOTIFY ${1000 + index}`,
        direction: 'outflow',
        amountCents: 2_190,
      })
    }
    const [candidate] = await recurrence.detectRecurrenceCandidates({
      today: '2026-09-05',
    })
    expect(candidate).toMatchObject({
      signature: 'spotify',
      frequency: 'monthly',
    })

    const approved = await recurrence.approveDetectedRecurrence({
      name: candidate.name,
      categoryId: database.ids.categories.subscriptions,
      amountCents: candidate.typicalAmountCents,
      currency: candidate.currency,
      direction: candidate.direction,
      amountMode: candidate.amountMode,
      frequency: candidate.frequency,
      nextDate: candidate.nextExpectedDate,
      accountId: candidate.accountId ?? undefined,
      transactionIds: candidate.transactions.map((item) => item.id),
    })
    expect(approved.linked).toBeGreaterThan(0)
    expect(await knowledgeEntries('recurrence')).toMatchObject([
      {
        signature: 'spotify',
        recurrenceId: approved.id,
        source: 'recurrence_approval',
        confirmations: approved.linked,
      },
    ])
    expect(await knowledgeEntries('category')).toMatchObject([
      {
        signature: 'spotify',
        categoryId: database.ids.categories.subscriptions,
      },
    ])
    expect(
      await recurrence.detectRecurrenceCandidates({ today: '2026-09-05' }),
    ).toEqual([])

    const matches = await db.select().from(schema.recurrenceMatches)
    for (const match of matches) await recurrence.unlinkMatch(match.id)
    await recurrence.deleteRecurrence(approved.id)
    expect(await knowledgeEntries('recurrence')).toEqual([])
    expect(await knowledgeEntries('category')).toHaveLength(1)
  })

  it('funde parcelas no mesmo padrão e casa prefixos no limite de token', async () => {
    const first = await finance.createManualTransaction({
      targetType: 'card',
      targetId: database.ids.card,
      postedAt: '2026-07-03',
      description: 'SEPHORA STORE - Parcela 1/6',
      direction: 'outflow',
      amountCents: 12_000,
    })
    const second = await finance.createManualTransaction({
      targetType: 'card',
      targetId: database.ids.card,
      postedAt: '2026-08-03',
      description: 'SEPHORA STORE - Parcela 2/6',
      direction: 'outflow',
      amountCents: 12_000,
    })
    await finance.updateTransactionCategory({
      transactionId: first.id,
      categoryId: database.ids.categories.personalCare,
      saveRule: false,
    })
    await finance.updateTransactionCategory({
      transactionId: second.id,
      categoryId: database.ids.categories.personalCare,
      saveRule: false,
    })
    expect(await knowledgeEntries('category')).toMatchObject([
      {
        pattern: 'sephora store',
        matchMode: 'exact',
        signature: 'sephora store parcela',
        confirmations: 2,
      },
    ])

    const johnny = await finance.createManualTransaction({
      targetType: 'card',
      targetId: database.ids.card,
      postedAt: '2026-08-04',
      description: 'Ifd*Pizzaria do Johnny',
      direction: 'outflow',
      amountCents: 8_000,
    })
    await finance.updateTransactionCategory({
      transactionId: johnny.id,
      categoryId: database.ids.categories.delivery,
      saveRule: false,
    })
    const [johnnyEntry] = (await knowledgeEntries('category')).filter(
      (entry) => entry.pattern === 'ifd pizzaria do johnny',
    )
    expect(johnnyEntry).toBeDefined()
    await updateKnowledgePattern({
      id: johnnyEntry.id,
      pattern: 'IFD',
      matchMode: 'prefix',
    })
    const pharmacy = await finance.createManualTransaction({
      targetType: 'card',
      targetId: database.ids.card,
      postedAt: '2026-08-05',
      description: 'IFD*FARMACIA CENTRAL',
      direction: 'outflow',
      amountCents: 4_000,
    })
    await finance.updateTransactionCategory({
      transactionId: pharmacy.id,
      categoryId: database.ids.categories.family,
      saveRule: false,
    })
    await expect(
      updateKnowledgePattern({
        id: johnnyEntry.id,
        pattern: 'ifd farmacia central',
        matchMode: 'exact',
      }),
    ).rejects.toThrow('Já existe um aprendizado com este padrão e modo.')

    const staged = await stageImport({
      file: ofxStatement([
        {
          id: 'prefix-1',
          date: '2026-09-01',
          amount: '-45.00',
          name: 'IFD*OUTRO LUGAR 9',
        },
        {
          id: 'prefix-2',
          date: '2026-09-02',
          amount: '-30.00',
          name: 'IFD*FARMACIA CENTRAL',
        },
        {
          id: 'prefix-3',
          date: '2026-09-03',
          amount: '-20.00',
          name: 'IFDX LOJA QUALQUER',
        },
        {
          id: 'prefix-4',
          date: '2026-09-04',
          amount: '-99.00',
          name: 'SEPHORA STORE - Parcela 3/6',
        },
      ]),
      targetType: 'account',
      targetId: database.ids.brlAccount,
      aiConsent: false,
    })
    const rows = new Map(
      (await stagedRowsOf(staged.importId)).map((row) => [
        row.description,
        row,
      ]),
    )
    expect(rows.get('IFD*OUTRO LUGAR 9')).toMatchObject({
      suggestedCategoryId: database.ids.categories.delivery,
      suggestionSource: 'knowledge',
      suggestionConfidence: 92,
    })
    expect(rows.get('IFD*FARMACIA CENTRAL')).toMatchObject({
      suggestedCategoryId: database.ids.categories.family,
      suggestionSource: 'knowledge',
      suggestionConfidence: 98,
    })
    expect(rows.get('IFDX LOJA QUALQUER')).toMatchObject({
      suggestedCategoryId: 'uncategorized',
      suggestionSource: 'none',
    })
    expect(rows.get('SEPHORA STORE - Parcela 3/6')).toMatchObject({
      suggestedCategoryId: database.ids.categories.personalCare,
      suggestionSource: 'knowledge',
      suggestionConfidence: 98,
    })
  })

  it('não cria entrada exata coberta por um prefixo da mesma categoria e absorve as existentes', async () => {
    const learn = async (description: string, categoryId: string) => {
      const transaction = await finance.createManualTransaction({
        targetType: 'card',
        targetId: database.ids.card,
        postedAt: '2026-08-04',
        description,
        direction: 'outflow',
        amountCents: 5_000,
      })
      await finance.updateTransactionCategory({
        transactionId: transaction.id,
        categoryId,
        saveRule: false,
      })
    }
    await learn('Shopee *Abcpapelaria', database.ids.categories.shopping)
    await learn('Shopee *Lepokpapelaria', database.ids.categories.shopping)
    await learn('Shopee *Presentes', database.ids.categories.family)
    const [first] = (await knowledgeEntries('category')).filter(
      (entry) => entry.pattern === 'shopee abcpapelaria',
    )

    await updateKnowledgePattern({
      id: first.id,
      pattern: 'shopee',
      matchMode: 'prefix',
    })
    expect(
      (await knowledgeEntries('category')).map((entry) => [
        entry.pattern,
        entry.matchMode,
        entry.categoryId,
        entry.confirmations,
      ]),
    ).toEqual([
      ['shopee', 'prefix', database.ids.categories.shopping, 2],
      ['shopee presentes', 'exact', database.ids.categories.family, 1],
    ])

    await learn('Shopee *Nova Loja', database.ids.categories.shopping)
    await learn('Shopee *Presentes', database.ids.categories.shopping)
    expect(
      (await knowledgeEntries('category')).map((entry) => [
        entry.pattern,
        entry.matchMode,
        entry.confirmations,
      ]),
    ).toEqual([['shopee', 'prefix', 4]])
  })
})
