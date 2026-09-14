import { expect, it } from 'vitest'
import { cardBudgetLines } from './card-budget'

it('mantém valores explícitos das próximas parcelas e trata parcela fixa temporária como essencial', () => {
  const lines = cardBudgetLines({
    id: 'bill',
    dueDate: '2026-09-15',
    totalCents: 101895,
    importId: 'import',
    futureOffset: 1,
    purchases: [
      {
        id: 'purchase',
        description: 'Compra ()',
        categoryId: 'shopping',
        bucket: 'lifestyle',
        amountCents: -101897,
        importId: 'import',
      },
    ],
    plans: [
      {
        description: 'Compra ()',
        sourceTransactionId: 'purchase',
        currentInstallment: 1,
        totalInstallments: 12,
        installmentAmountCents: 101897,
      },
    ],
    explicitInstallments: [
      { description: 'Compra', amountCents: 101895, current: 2, total: 12 },
    ],
  })
  expect(lines[0]).toMatchObject({
    cents: 101895,
    categoryId: 'shopping',
    bucket: 'essential',
    installment: '2/12',
    temporaryUntil: '2027-07-15',
    certainty: 'scheduled',
  })
  expect(lines[0].transactionId).toBeUndefined()
})
it('não adivinha categoria de descrição ambígua e encerra parcela já concluída', () => {
  const lines = cardBudgetLines({
    id: 'bill',
    dueDate: '2026-09-15',
    totalCents: 100,
    importId: 'import',
    futureOffset: 2,
    purchases: [],
    plans: [],
    explicitInstallments: [
      { description: 'Compra', amountCents: 100, current: 1, total: 2 },
      { description: 'Encerrada', amountCents: 100, current: 2, total: 2 },
    ],
  })
  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatchObject({
    bucket: 'other',
    cents: 100,
    installment: '2/2',
  })
})
