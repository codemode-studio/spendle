import { performance } from 'node:perf_hooks'
import { buildReconciliationSuggestions } from '../src/domain/reconciliation'
import { openTestDatabase } from '../src/test/database'
import {
  getFinanceSnapshot,
  getConfigurationSnapshot,
  getStrategyHistory,
} from '../src/features/finance/finance-snapshot.server'
import { getTransactionsPage } from '../src/features/finance/transactions.server'
import { transactionFiltersSchema } from '../src/features/finance/transactions.filters'

for (const count of [1_000, 2_000, 4_000]) {
  const rows = Array.from({ length: count }, (_, index) => ({
    id: String(index),
    amountCents: -100,
    currency: 'BRL',
    postedAt: '2026-08-01',
    description: 'Synthetic expense',
    accountId: 'account',
    creditCardId: null,
  }))
  const start = performance.now()
  const suggestions = buildReconciliationSuggestions(rows)
  console.log(
    JSON.stringify({
      operation: 'reconciliation',
      rows: count,
      ms: +(performance.now() - start).toFixed(2),
      suggestions: suggestions.length,
    }),
  )
}
let queries = 0
const database = await openTestDatabase({
  onQuery: (query) => {
    if (/^select\b/i.test(query)) queries += 1
  },
})
try {
  const { db, schema, ids } = database
  for (let offset = 0; offset < 4_000; offset += 100) {
    db.insert(schema.transactions)
      .values(
        Array.from({ length: 100 }, (_, index) => ({
          id: String(offset + index),
          accountId: ids.brlAccount,
          postedAt: '2026-08-01',
          description: 'Synthetic expense',
          normalizedDescription: 'synthetic expense',
          amountCents: -100,
          currency: 'BRL',
          fingerprint: String(offset + index),
          categoryId: ids.categories.food,
        })),
      )
      .run()
  }
  for (const [operation, read] of [
    ['fullSnapshot', () => getFinanceSnapshot()],
    ['configuration', () => getConfigurationSnapshot()],
    [
      'transactionsPage',
      () => getTransactionsPage(transactionFiltersSchema.parse({})),
    ],
    ['history3', () => getStrategyHistory({ months: 3 })],
    ['history12', () => getStrategyHistory({ months: 12 })],
  ] as const) {
    queries = 0
    const start = performance.now()
    const result = await read()
    console.log(
      JSON.stringify({
        operation,
        rows: 4_000,
        queries,
        ms: +(performance.now() - start).toFixed(2),
        bytes: Buffer.byteLength(JSON.stringify(result)),
      }),
    )
  }
} finally {
  database.close()
}
