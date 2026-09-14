import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openTestDatabase } from '#/test/database'
import type { TestDatabase } from '#/test/database'
import {
  getCategoryTransactions,
  getConfigurationSnapshot,
  getFinanceSnapshot,
  getStrategyHistory,
} from './finance-snapshot.server'
import { getTransactionsPage } from './transactions.server'
import { transactionFiltersSchema } from './transactions.filters'
import { stageImport } from './import-stage.server'
import { familyTransactions } from '#/domain/ledger'

let database: TestDatabase | undefined
afterEach(() => {
  database?.close()
  vi.useRealTimers()
})

describe('bounded financial reads', () => {
  it('paginates stably and filters across all rows, preserving accent and amount semantics', async () => {
    database = await openTestDatabase()
    const { db, schema, ids } = database
    db.insert(schema.transactions)
      .values(
        Array.from({ length: 121 }, (_, index) => ({
          id: String(index).padStart(3, '0'),
          accountId: ids.brlAccount,
          postedAt: index === 0 ? '2026-08-01' : '2026-08-15',
          description: index === 0 ? 'Café São Paulo' : 'Mercado',
          normalizedDescription: 'unused by search',
          amountCents: -100,
          currency: index === 0 ? 'USD' : 'BRL',
          baseAmountCents: index === 0 ? -500 : null,
          categoryId:
            index === 0 ? ids.categories.uncategorized : ids.categories.food,
          fingerprint: String(index),
        })),
      )
      .run()
    const first = await getTransactionsPage(transactionFiltersSchema.parse({}))
    const second = await getTransactionsPage(
      transactionFiltersSchema.parse({ page: 1 }),
    )
    expect(first.transactions).toHaveLength(50)
    expect(second.transactions).toHaveLength(50)
    expect(
      new Set(
        [...first.transactions, ...second.transactions].map((row) => row.id),
      ).size,
    ).toBe(100)
    expect(first.totalCount).toBe(121)
    expect(first.uncategorizedCount).toBe(1)
    const searched = await getTransactionsPage(
      transactionFiltersSchema.parse({
        search: 'cafe sao',
        minCents: 400,
        direction: 'out',
        page: 50,
      }),
    )
    expect(searched.page).toBe(0)
    expect(searched.transactions.map((row) => row.id)).toEqual(['000'])
    const noMatch = await getTransactionsPage(
      transactionFiltersSchema.parse({ search: "' OR 1=1 --" }),
    )
    expect(noMatch.filteredCount).toBe(0)
    const dateRange = await getTransactionsPage(
      transactionFiltersSchema.parse({
        dateFrom: '2026-08-01',
        dateTo: '2026-08-01',
      }),
    )
    expect(dateRange.transactions.map((row) => row.id)).toEqual(['000'])
    expect(dateRange.filteredCount).toBe(1)
    const config = await getConfigurationSnapshot()
    expect(config).not.toHaveProperty('transactions')
    expect(config.accounts).toEqual((await getFinanceSnapshot()).accounts)
  })

  it('reads the category ledger without calculating budgets, preserving order, FX, refunds and both transfer sides', async () => {
    const queries: string[] = []
    database = await openTestDatabase({
      onQuery: (query) => queries.push(query),
    })
    const { db, schema: s, ids } = database
    const row = (
      id: string,
      extra: Partial<typeof s.transactions.$inferInsert> = {},
    ) => ({
      id,
      fingerprint: id,
      accountId: ids.brlAccount,
      postedAt: '2026-08-01',
      description: id,
      normalizedDescription: id,
      amountCents: -101,
      currency: 'BRL',
      categoryId: ids.categories.groceries,
      ...extra,
    })
    await db
      .insert(s.transactions)
      .values([
        row('expense'),
        row('refund', { amountCents: 1 }),
        row('converted', { currency: 'USD', baseAmountCents: -507 }),
        row('unconverted', { currency: 'USD' }),
        row('pending', { status: 'pending' }),
        row('excluded', { status: 'excluded' }),
        row('card', { accountId: null, creditCardId: ids.card }),
        row('unknown', { categoryId: null }),
        row('system-unknown', { categoryId: ids.categories.uncategorized }),
        row('payment', { categoryId: ids.categories.cardPayment }),
        row('counterparty', { counterpartyAccountId: ids.brlAccount }),
        row('transfer-out'),
        row('transfer-in', { amountCents: 101 }),
        row('suggested-transfer'),
      ])
    await db.insert(s.reconciliationGroups).values([
      { id: 'own', type: 'transfer', status: 'confirmed', confidence: 100 },
      {
        id: 'suggested',
        type: 'transfer',
        status: 'suggested',
        confidence: 50,
      },
    ])
    await db.insert(s.reconciliationLinks).values([
      {
        id: 'out',
        groupId: 'own',
        transactionId: 'transfer-out',
        role: 'source',
      },
      {
        id: 'in',
        groupId: 'own',
        transactionId: 'transfer-in',
        role: 'target',
      },
      {
        id: 'suggestion',
        groupId: 'suggested',
        transactionId: 'suggested-transfer',
        role: 'source',
      },
    ])
    const before = await db.select().from(s.transactions)
    const expected = familyTransactions(await getFinanceSnapshot())
    queries.length = 0
    const result = await getCategoryTransactions()
    expect(result).toEqual(expected)
    expect(result.map((entry) => entry.id).sort()).toEqual([
      'card',
      'converted',
      'expense',
      'refund',
      'suggested-transfer',
      'system-unknown',
      'unknown',
    ])
    expect(result.find((entry) => entry.id === 'converted')?.amountCents).toBe(
      -507,
    )
    expect(result.find((entry) => entry.id === 'refund')?.amountCents).toBe(1)
    expect(queries).toHaveLength(3)
    expect(queries.every((query) => /^select\b/i.test(query))).toBe(true)
    expect(queries.join(' ')).not.toMatch(
      /monthly_budgets|exchange_rates|imports|recurrences|investment_goals|card_statement_cycles/,
    )
    expect(await db.select().from(s.transactions)).toEqual(before)
    expect(await db.select().from(s.knowledgeBase)).toEqual([])
  })

  it('reads once for history and keeps closed-month allocations frozen', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-04T12:00:00Z'))
    let selects = 0
    database = await openTestDatabase({
      onQuery: (query) => {
        if (/^select\b/i.test(query)) selects += 1
      },
    })
    const { db, schema } = database
    db.insert(schema.monthlyBudgets)
      .values({
        id: 'closed',
        month: '2026-08',
        strategyId: 'test-strategy-balanced',
        baseIncomeCents: 100_000,
        eligibleIncomeCents: 100_000,
        essentialBps: 4000,
        lifestyleBps: 2000,
        investmentBps: 3000,
        reserveBps: 1000,
        effectiveInvestmentBps: 4000,
        effectiveReserveBps: 0,
        closed: true,
      })
      .run()
    selects = 0
    const history = await getStrategyHistory({ months: 3 })
    const threeMonths = selects
    selects = 0
    await getStrategyHistory({ months: 12 })
    expect(selects).toBe(threeMonths)
    // As leituras adicionais carregam referências humanas de recorrências,
    // pagamentos de fatura e os vínculos entre posições e transações.
    expect(threeMonths).toBeLessThanOrEqual(31)
    expect(history[0]).toMatchObject({
      month: '2026-08',
      closed: true,
      baseIncomeCents: 100_000,
      targets: {
        essential: 40_000,
        lifestyle: 20_000,
        investment: 40_000,
        reserve: 0,
      },
    })
    for (const row of history) {
      const { dashboard } = await getFinanceSnapshot(row.month)
      expect(row.actual).toEqual(dashboard.budgetActual)
      expect(row.targets).toEqual(dashboard.budgetTargets)
    }
  })

  it('owns staged source files inside the same disposable root as its database', async () => {
    database = await openTestDatabase()
    const file = new File(
      [
        'OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\nSECURITY:NONE\nENCODING:USASCII\nCHARSET:1252\nCOMPRESSION:NONE\nOLDFILEUID:NONE\nNEWFILEUID:NONE\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL</CURDEF><BANKTRANLIST><DTSTART>20260801</DTSTART><DTEND>20260801</DTEND><STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20260801120000[-3:BRT]</DTPOSTED><TRNAMT>10.00</TRNAMT><FITID>isolated</FITID><NAME>Synthetic</NAME></STMTTRN></BANKTRANLIST><LEDGERBAL><BALAMT>10.00</BALAMT><DTASOF>20260801</DTASOF></LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
      ],
      'isolation.ofx',
    )
    await stageImport({
      file,
      targetType: 'account',
      targetId: database.ids.brlAccount,
      aiConsent: false,
    })
    const [source] = await database.db
      .select()
      .from(database.schema.sourceFiles)
    expect(
      source.storagePath.startsWith(`${database.directory}/imports/`),
    ).toBe(true)
    expect(existsSync(source.storagePath)).toBe(true)
    database.close()
    expect(existsSync(source.storagePath)).toBe(false)
  })
})
