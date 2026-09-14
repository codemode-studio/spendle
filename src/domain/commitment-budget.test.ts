import { expect, it } from 'vitest'
import { buildCommitmentBudget } from './commitment-budget'
import type {
  CommitmentInput,
  CommitmentLine,
  CommitmentRecurrence,
  CommitmentTransaction,
} from './commitment-budget'

const line: CommitmentLine = {
  id: 'purchase',
  description: 'Compra de agosto',
  date: '2026-09-09',
  cents: 886250,
  categoryId: 'shopping',
  bucket: 'lifestyle',
  transactionId: 'purchase',
  certainty: 'documented',
  paidCents: 0,
  origin: 'card',
}
const tx: CommitmentTransaction = {
  id: 'bank',
  description: 'Despesa',
  date: '2026-09-03',
  cents: -20000,
  nativeCents: -20000,
  currency: 'BRL',
  categoryId: 'personal',
  bucket: 'lifestyle',
  cardId: null,
  importId: null,
  status: 'confirmed',
  excluded: false,
}
const base: CommitmentInput = {
  month: '2026-09',
  today: '2026-09-06',
  incomeCents: 6000000,
  targets: {
    essential: 3000000,
    lifestyle: 1800000,
    investment: 900000,
    reserve: 300000,
  },
  transactions: [tx],
  statements: [
    {
      id: 'bill',
      cardId: 'nu',
      name: 'Nubank',
      dueDate: '2026-09-09',
      cents: 886250,
      closed: true,
      lines: [line],
      paymentIds: [],
    },
  ],
  recurrences: [],
  coveragePartial: true,
}
const recurrence: CommitmentRecurrence = {
  id: 'rec',
  name: 'Plano',
  date: '2026-09-10',
  cents: 20000,
  nativeCents: 20000,
  currency: 'BRL',
  categoryId: 'personal',
  bucket: 'lifestyle',
  variable: false,
  categoryWide: true,
  patterns: [],
  transactionIds: ['bank'],
  status: 'expected',
  cardId: null,
  toleranceDays: 10,
}
it('inclui compras de outro mês pela fatura sem somá-las como compras do mês', () => {
  const result = buildCommitmentBudget({
    ...base,
    transactions: [
      tx,
      {
        ...tx,
        id: 'purchase',
        cardId: 'nu',
        date: '2026-08-10',
        cents: -886250,
        nativeCents: -886250,
      },
    ],
  })
  expect(result.buckets.find((b) => b.bucket === 'lifestyle')).toMatchObject({
    paidCents: 20000,
    dueCents: 886250,
    committedCents: 906250,
    remainingCents: 893750,
  })
})
it('reduz fatura paga sem contar novamente a saída bancária', () => {
  const r = buildCommitmentBudget({
    ...base,
    transactions: [
      tx,
      {
        ...tx,
        id: 'payment',
        categoryId: 'card_payment',
        cents: -886250,
        nativeCents: -886250,
      },
    ],
  })
  expect(r.committedCents).toBe(906250)
  expect(r.buckets.find((b) => b.bucket === 'lifestyle')).toMatchObject({
    paidCents: 906250,
    dueCents: 0,
  })
})
it('não atribui um pagamento ambíguo a duas faturas', () => {
  const r = buildCommitmentBudget({
    ...base,
    statements: [
      base.statements[0],
      { ...base.statements[0], id: 'other', cardId: 'other' },
    ],
    transactions: [
      {
        ...tx,
        id: 'payment',
        categoryId: 'card_payment',
        cents: -886250,
        nativeCents: -886250,
      },
    ],
  })
  expect(r.buckets.find((b) => b.bucket === 'lifestyle')?.paidCents).toBe(0)
  expect(r.warnings.some((w) => w.includes('sem vínculo'))).toBe(true)
})
it('abate compras já faturadas da estimativa variável e preserva o excesso observado', () => {
  const r = buildCommitmentBudget({
    ...base,
    recurrences: [
      { ...recurrence, variable: true, categoryId: 'shopping', cents: 900000 },
    ],
  })
  expect(r.buckets.find((b) => b.bucket === 'lifestyle')?.variableCents).toBe(
    13750,
  )
  expect(
    buildCommitmentBudget({
      ...base,
      recurrences: [
        {
          ...recurrence,
          variable: true,
          categoryId: 'shopping',
          cents: 800000,
        },
      ],
    }).buckets.find((b) => b.bucket === 'lifestyle')?.variableCents,
  ).toBe(0)
})
it('não reserva recorrência paga novamente e preserva categoria humana da compra', () => {
  const r = buildCommitmentBudget({ ...base, recurrences: [recurrence] })
  expect(r.committedCents).toBe(906250)
})
it('mantém sobra sem composição fora dos envelopes', () => {
  const r = buildCommitmentBudget({
    ...base,
    statements: [{ ...base.statements[0], cents: 900000 }],
  })
  expect(r.buckets.find((b) => b.bucket === 'other')?.dueCents).toBe(13750)
})
it('rateia pagamento parcial explícito com estorno sem perder centavos', () => {
  const r = buildCommitmentBudget({
    ...base,
    statements: [
      {
        ...base.statements[0],
        cents: 101,
        paymentIds: ['payment'],
        lines: [
          { ...line, cents: 110 },
          { ...line, id: 'refund', cents: -9 },
        ],
      },
    ],
    transactions: [
      {
        ...tx,
        id: 'payment',
        categoryId: 'card_payment',
        cents: -51,
        nativeCents: -51,
      },
    ],
  })
  expect(r.lines.reduce((n, l) => n + l.paidCents, 0)).toBe(51)
  expect(r.lines.reduce((n, l) => n + l.cents, 0)).toBe(101)
})
it('exclui transferências próprias e explica valores sem câmbio', () => {
  const r = buildCommitmentBudget({
    ...base,
    statements: [],
    transactions: [
      { ...tx, excluded: true },
      { ...tx, id: 'usd', cents: null, currency: 'USD' },
    ],
  })
  expect(r.committedCents).toBe(0)
  expect(r.warnings.some((w) => w.includes('conversão'))).toBe(true)
})

it('não usa aluguel para abater gás nem uma consulta para abater dois terapeutas', () => {
  const result = buildCommitmentBudget({
    ...base,
    statements: [],
    transactions: [
      {
        ...tx,
        categoryId: 'health',
        bucket: 'essential',
        cents: -80000,
        nativeCents: -80000,
      },
    ],
    recurrences: [
      {
        ...recurrence,
        id: 'one',
        variable: true,
        categoryWide: false,
        transactionIds: [],
        categoryId: 'health',
        bucket: 'essential',
        cents: 150000,
      },
      {
        ...recurrence,
        id: 'two',
        variable: true,
        categoryWide: false,
        transactionIds: [],
        categoryId: 'health',
        bucket: 'essential',
        cents: 120000,
      },
    ],
  })
  expect(
    result.buckets.find((b) => b.bucket === 'essential')?.variableCents,
  ).toBe(270000)
})

it('não duplica lançamento pendente vinculado a uma recorrência', () => {
  const result = buildCommitmentBudget({
    ...base,
    statements: [],
    transactions: [{ ...tx, status: 'pending' }],
    recurrences: [recurrence],
  })
  expect(result.buckets.find((b) => b.bucket === 'lifestyle')).toMatchObject({
    dueCents: 20000,
    paidCents: 0,
    committedCents: 20000,
  })
})
it('mostra separadamente a margem após metas de aporte ainda não realizadas', () => {
  const result = buildCommitmentBudget({ ...base, statements: [] })
  expect(result.unfundedGoalsCents).toBe(1200000)
  expect(result.remainingAfterGoalsCents).toBe(4780000)
})

it('abate pagamento antecipado de recorrência variável com vínculo aceito', () => {
  const result = buildCommitmentBudget({
    ...base,
    statements: [],
    transactions: [{ ...tx, date: '2026-08-31' }],
    recurrences: [
      { ...recurrence, variable: true, categoryWide: false, status: 'matched' },
    ],
  })
  expect(result.buckets.find((b) => b.bucket === 'lifestyle')).toMatchObject({
    paidCents: 20000,
    dueCents: 0,
    variableCents: 0,
  })
})

it('abate recorrência cobrada em agosto dentro da fatura que vence em setembro', () => {
  const purchase = {
    ...tx,
    id: 'purchase',
    date: '2026-08-11',
    cardId: 'nu',
    cents: -886250,
    nativeCents: -886250,
  }
  const r = {
    ...recurrence,
    cardId: 'nu',
    chargeDate: '2026-08-11',
    date: '2026-09-09',
    cents: 886250,
    nativeCents: 886250,
    transactionIds: ['purchase'],
  }
  const result = buildCommitmentBudget({
    ...base,
    transactions: [tx, purchase],
    recurrences: [r],
  })
  expect(
    result.buckets.find((b) => b.bucket === 'lifestyle')?.committedCents,
  ).toBe(906250)
})
it('alerta pagamento de fatura categorizado como despesa', () => {
  const byDescription = buildCommitmentBudget({
    ...base,
    transactions: [
      { ...tx, id: 'pay', description: 'PAGTO FATURA CARTAO 1234' },
    ],
  })
  expect(
    byDescription.warnings.some((w) => w.includes('categorizado como despesa')),
  ).toBe(true)

  const byAmount = buildCommitmentBudget({
    ...base,
    transactions: [
      {
        ...tx,
        id: 'pay',
        description: 'Débito',
        cents: -886250,
        nativeCents: -886250,
        date: '2026-09-08',
      },
    ],
  })
  expect(
    byAmount.warnings.some((w) => w.includes('categorizado como despesa')),
  ).toBe(true)

  const ordinary = buildCommitmentBudget(base)
  expect(
    ordinary.warnings.some((w) => w.includes('categorizado como despesa')),
  ).toBe(false)
})
