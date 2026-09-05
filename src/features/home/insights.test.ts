import { describe, expect, it } from 'vitest'

import type { FamilyTransaction } from '#/domain/ledger'
import { shiftDays } from '#/domain/period'
import { addRecurrencePeriod } from '#/domain/recurrence-schedule'

import {
  operatingCashCents,
  buildInsights,
  accountInflowsByCurrency,
  categoryBreakdown,
  periodTotals,
  projectCash,
  topMerchants,
  upcomingCommitments,
} from './insights'
import type { FinanceSnapshot } from '#/features/finance/snapshot.types'

function snapshotWithMonthlyRecurrence() {
  const today = '2026-09-04'
  const firstDate = shiftDays(today, 1)
  const secondDate = addRecurrencePeriod(firstDate, 'monthly', firstDate)
  const thirdDate = addRecurrencePeriod(secondDate, 'monthly', firstDate)
  const expectedDates = [firstDate, secondDate, thirdDate]
  const snapshot = {
    accounts: [
      {
        id: 'operating-account',
        active: true,
        purpose: 'operating',
        currency: 'BRL',
        scope: null,
        balanceCents: 0,
      },
    ],
    cards: [],
    installmentPlans: [],
    reconciliations: [],
    transactions: [],
    recurrences: [
      {
        id: 'monthly-recurrence',
        name: 'Compromisso mensal',
        knowledgeReferences: [],
        nextDate: firstDate,
        amountCents: 10_000,
        currency: 'BRL',
        direction: 'expense',
        active: true,
        creditCardId: null,
        baseAmountCents: null,
        frequency: 'monthly',
        scheduleAnchor: firstDate,
        matchMode: 'single',
        occurrences: expectedDates.map((expectedDate, index) => ({
          id: `occurrence-${index + 1}`,
          expectedDate,
          expectedAmountCents: 10_000,
          currency: 'BRL',
          direction: 'expense',
          status: 'expected',
          matches: [],
        })),
      },
    ],
  } as unknown as FinanceSnapshot

  return { snapshot, expectedDates, today }
}

function entry(
  id: string,
  postedAt: string,
  amountCents: number,
  overrides: Partial<FamilyTransaction> = {},
): FamilyTransaction {
  return {
    id: `${id}-${postedAt}-${amountCents}`,
    postedAt,
    description: id,
    normalized: id,
    amountCents,
    categoryId: id,
    categoryName: id,
    color: '#123456',
    bucket: 'essential',
    source: 'account',
    uncategorized: false,
    ...overrides,
  }
}

describe('insights de recorrências futuras', () => {
  it('inclui todas as ocorrências mensais esperadas dentro de 90 dias', () => {
    const { snapshot, expectedDates, today } = snapshotWithMonthlyRecurrence()

    const commitments = upcomingCommitments(snapshot, 90, today)
    expect(commitments.map((event) => event.date)).toEqual(expectedDates)

    const projection = projectCash(snapshot, 0, 90, today)
    const todayPoint = projection.points[projection.todayIndex]
    const balanceChanges = projection.points
      .slice(projection.todayIndex + 1)
      .filter(
        (point, index, futurePoints) =>
          point.balanceCents !==
          (index === 0
            ? todayPoint.balanceCents
            : futurePoints[index - 1].balanceCents),
      )

    expect(balanceChanges.map((point) => point.date)).toEqual(expectedDates)
    expect(balanceChanges.map((point) => point.balanceCents)).toEqual([
      -10_000, -20_000, -30_000,
    ])
  })
})

describe('derivações sobre lançamentos planos', () => {
  const august = { start: '2026-08-01', end: '2026-08-31' }

  it('calcula entradas, gastos, aportes e pendências de categoria no período', () => {
    const totals = periodTotals(
      [
        entry('salary', '2026-08-02', 100_000, { bucket: 'income' }),
        entry('food', '2026-08-03', -10_000),
        entry('tax', '2026-08-04', -2_000, { bucket: 'tax' }),
        entry('reserve', '2026-08-05', -3_000, { bucket: 'reserve' }),
        entry('unknown', '2026-08-06', -500, {
          categoryId: null,
          bucket: null,
          uncategorized: true,
        }),
        entry('outside', '2026-07-31', -99_000),
      ],
      august,
    )

    expect(totals).toMatchObject({
      incomeCents: 100_000,
      spendingCents: 12_000,
      spendingCount: 2,
      allocationCents: 3_000,
      uncategorizedCents: 500,
      uncategorizedCount: 1,
    })
  })

  it('compara o gasto por categoria com a média da janela de referência', () => {
    const breakdown = categoryBreakdown(
      [
        entry('food', '2026-08-05', -9_000),
        entry('housing', '2026-08-10', -3_000),
        entry('food', '2026-07-15', -18_000),
        entry('housing', '2026-06-15', -9_000),
      ],
      { start: '2026-08-01', end: '2026-08-30' },
      90,
    )

    expect(breakdown.totalCents).toBe(12_000)
    expect(breakdown.referenceTotalCents).toBe(9_000)
    expect(breakdown.items.map((item) => item.id)).toEqual(['food', 'housing'])
    expect(breakdown.items[0]).toMatchObject({
      cents: 9_000,
      share: 0.75,
      referenceCents: 6_000,
      deltaCents: 3_000,
      deltaRatio: 0.5,
    })
    expect(breakdown.items[1]).toMatchObject({
      referenceCents: 3_000,
      deltaRatio: 0,
    })
  })

  it('agrupa estabelecimentos pela descrição normalizada e respeita o limite', () => {
    const merchants = topMerchants(
      [
        entry('first', '2026-08-01', -4_000, {
          description: 'Mercado Um',
          normalized: 'mercado um',
        }),
        entry('second', '2026-08-02', -6_000, {
          description: 'MERCADO UM',
          normalized: 'mercado um',
        }),
        entry('bakery', '2026-08-03', -2_000, {
          description: 'Padaria',
          normalized: '',
        }),
        entry('outside', '2026-07-31', -50_000),
      ],
      august,
      1,
    )

    expect(merchants).toEqual([
      {
        key: 'mercado um',
        name: 'Mercado Um',
        cents: 10_000,
        count: 2,
        categoryName: 'first',
        color: '#123456',
      },
    ])
  })
})

describe('caixa unificado PF e PJ', () => {
  it('inclui a conta operacional PJ e mantém reserva e dólares separados', () => {
    const snapshot = {
      accounts: [
        {
          active: true,
          purpose: 'operating',
          currency: 'BRL',
          scope: { type: 'person' },
          balanceCents: 43_667,
        },
        {
          active: true,
          purpose: 'operating',
          currency: 'BRL',
          scope: { type: 'company_br' },
          balanceCents: 4_801_903,
        },
        {
          active: true,
          purpose: 'reserve',
          currency: 'BRL',
          scope: { type: 'household' },
          balanceCents: 3_660_000,
        },
        {
          active: true,
          purpose: 'operating',
          currency: 'USD',
          scope: { type: 'person' },
          balanceCents: 1_200_000,
        },
      ],
    } as FinanceSnapshot
    expect(operatingCashCents(snapshot)).toBe(4_845_570)
  })
})

it('não melhora o caixa previsto quando a mesma saída perde a categoria', () => {
  const { snapshot, today } = snapshotWithMonthlyRecurrence()
  const transaction = {
    id: 'expense',
    description: 'Despesa sem identificação',
    accountId: 'operating-account',
    creditCardId: null,
    postedAt: shiftDays(today, -1),
    amountCents: -60_000,
    status: 'confirmed',
    counterpartyAccountId: null,
    category: { id: 'food', bucket: 'essential' },
  }
  const classified = {
    ...snapshot,
    recurrences: [],
    transactions: [transaction],
  } as unknown as FinanceSnapshot
  const unclassified = {
    ...classified,
    transactions: [
      { ...transaction, category: { id: 'uncategorized', bucket: 'excluded' } },
    ],
  } as unknown as FinanceSnapshot
  expect(projectCash(classified, 0, 30, today).in30Cents).toBe(-30_000)
  expect(projectCash(unclassified, 0, 30, today).in30Cents).toBe(-30_000)
})

it('reserva novas compras no cartão sem repetir parcelas já programadas', () => {
  const { snapshot, today } = snapshotWithMonthlyRecurrence()
  const scenario = {
    ...snapshot,
    recurrences: [],
    cards: [
      {
        id: 'card',
        currency: 'BRL',
        scope: null,
        upcomingStatements: [
          { dueDate: shiftDays(today, 5), amountCents: 20_000 },
        ],
      },
    ],
    installmentPlans: [{ sourceTransactionId: 'installment' }],
    transactions: ['groceries', 'installment'].map((id) => ({
      id,
      description: id,
      accountId: null,
      creditCardId: 'card',
      currency: 'BRL',
      postedAt: shiftDays(today, -1),
      amountCents: -60_000,
      status: 'confirmed',
      counterpartyAccountId: null,
      category: { id: 'food', bucket: 'essential' },
    })),
  } as unknown as FinanceSnapshot
  const projection = projectCash(scenario, 0, 30, today)
  expect(projection.dailyVariableCents).toBe(1_000)
  expect(projection.in30Cents).toBe(-50_000)
})

it('não projeta aporte passado como nova despesa de consumo', () => {
  const { snapshot, today } = snapshotWithMonthlyRecurrence()
  const scenario = {
    ...snapshot,
    recurrences: [],
    installmentPlans: [],
    transactions: [
      {
        id: 'reserve',
        accountId: 'operating-account',
        creditCardId: null,
        postedAt: shiftDays(today, -1),
        amountCents: -60_000,
        currency: 'BRL',
        status: 'confirmed',
        counterpartyAccountId: null,
        category: { id: 'reserve', bucket: 'reserve' },
      },
    ],
  } as unknown as FinanceSnapshot
  expect(projectCash(scenario, 0, 30, today).in30Cents).toBe(0)
})

it('mantém a média de assinatura no cartão mesmo com recorrência vinculada', () => {
  const { snapshot, today } = snapshotWithMonthlyRecurrence()
  const scenario = {
    ...snapshot,
    installmentPlans: [],
    cards: [
      { id: 'card', currency: 'BRL', scope: null, upcomingStatements: [] },
    ],
    recurrences: [
      {
        ...snapshot.recurrences[0],
        creditCardId: 'card',
        occurrences: [
          {
            ...snapshot.recurrences[0].occurrences[0],
            matches: [{ transactionId: 'subscription', status: 'confirmed' }],
          },
        ],
      },
    ],
    transactions: [
      {
        id: 'subscription',
        description: 'Assinatura',
        accountId: null,
        creditCardId: 'card',
        currency: 'BRL',
        postedAt: shiftDays(today, -1),
        amountCents: -6_000,
        status: 'confirmed',
        counterpartyAccountId: null,
        category: { id: 'subscriptions', bucket: 'essential' },
      },
    ],
  } as unknown as FinanceSnapshot
  expect(projectCash(scenario, 0, 30, today).in30Cents).toBe(-3_000)
})

it('projeta até 90 dias mesmo quando só a próxima ocorrência está gravada', () => {
  const { snapshot, expectedDates, today } = snapshotWithMonthlyRecurrence()
  snapshot.recurrences[0].occurrences =
    snapshot.recurrences[0].occurrences.slice(0, 1)
  expect(
    upcomingCommitments(snapshot, 90, today).map((event) => event.date),
  ).toEqual(expectedDates)
  expect(projectCash(snapshot, 0, 90, today).points.at(-1)?.balanceCents).toBe(
    -30_000,
  )
  expect(snapshot.recurrences[0].occurrences).toHaveLength(1)
})

it('não recria compromisso já pago ou dispensado ao completar o horizonte', () => {
  const { snapshot, expectedDates, today } = snapshotWithMonthlyRecurrence()
  snapshot.recurrences[0].occurrences[1].status = 'skipped'
  snapshot.recurrences[0].occurrences[2].status = 'matched'
  expect(
    upcomingCommitments(snapshot, 90, today).map((event) => event.date),
  ).toEqual([expectedDates[0]])
  expect(projectCash(snapshot, 0, 90, today).points.at(-1)?.balanceCents).toBe(
    -10_000,
  )
})

it('não repete no consumo variável um pagamento reconhecido pela KB da recorrência', () => {
  const { snapshot, today } = snapshotWithMonthlyRecurrence()
  const recurrence = snapshot.recurrences[0]
  Object.assign(recurrence, {
    amountCents: 60_000,
    amountMode: 'fixed',
    amountToleranceBps: 500,
    knowledgeReferences: [
      { id: 'human-rule', description: 'LOCADORA EXEMPLO' },
    ],
  })
  recurrence.occurrences.forEach((occurrence) => {
    occurrence.expectedAmountCents = 60_000
  })
  snapshot.transactions = [
    {
      id: 'rent-paid',
      accountId: 'operating-account',
      creditCardId: null,
      description: 'Pix enviado: "Cp :12345678-LOCADORA EXEMPLO"',
      currency: 'BRL',
      postedAt: shiftDays(today, -1),
      amountCents: -60_000,
      status: 'confirmed',
      counterpartyAccountId: null,
      category: { id: 'housing', bucket: 'essential' },
    },
  ] as unknown as FinanceSnapshot['transactions']
  const before = JSON.stringify(snapshot)
  const projection = projectCash(snapshot, 0, 30, today)
  expect(projection.in30Cents).toBe(-60_000)
  expect(projection.recurringEstimateTransactionIds).toEqual(['rent-paid'])
  expect(JSON.stringify(snapshot)).toBe(before)
  snapshot.recurrences.push({ ...recurrence, id: 'ambiguous' })
  expect(
    projectCash(snapshot, 0, 30, today).recurringEstimateTransactionIds,
  ).toEqual([])
  snapshot.recurrences.pop()
  recurrence.active = false
  expect(projectCash(snapshot, 0, 30, today).in30Cents).toBe(-30_000)
})

it('não apresenta dados parciais como queda de consumo ou categoria acima da média', () => {
  const view = {
    latestPostedAt: '2026-09-05',
    integrity: { partial: true, issues: [], totalCount: 1 },
    comparisonReady: { fortnight: false, month: false, categories: false },
    last14: { spendingCents: 1_000 },
    previous14: { spendingCents: 10_000 },
    last30: { spendingCents: 1_000, uncategorizedCents: 0 },
    categories14: { items: [] },
    categories30: {
      items: [
        {
          id: 'food',
          name: 'Mercado',
          cents: 20_000,
          deltaRatio: 1,
          deltaCents: 20_000,
          referenceCents: 10_000,
          folded: false,
        },
      ],
    },
    merchants30: [],
    commitments30: [],
    cash: { lowPoint: null },
    reserve: { targetCents: 0 },
  } as unknown as Parameters<typeof buildInsights>[0]
  const messages = buildInsights(view, String, '2026-09-05')
  expect(messages.find((item) => item.id === 'fortnight')?.title).not.toMatch(
    /caíram|subiram/,
  )
  expect(messages.filter((item) => item.id.startsWith('leak-'))).toEqual([])
})

it('mostra entradas na moeda original sem duplicar a remessa para outra conta própria', () => {
  const snapshot = {
    transactions: [
      {
        id: 'salary-usd',
        accountId: 'global',
        status: 'confirmed',
        postedAt: '2026-08-31',
        currency: 'USD',
        amountCents: 1_200_000,
        baseAmountCents: null,
        counterpartyAccountId: null,
        categoryId: 'uncategorized',
      },
      {
        id: 'fx-brl',
        accountId: 'pj',
        status: 'confirmed',
        postedAt: '2026-09-02',
        currency: 'BRL',
        amountCents: 6_108_937,
        counterpartyAccountId: null,
      },
      {
        id: 'interest',
        accountId: 'pj',
        status: 'confirmed',
        postedAt: '2026-09-01',
        currency: 'BRL',
        amountCents: 1_663,
        counterpartyAccountId: null,
        categoryId: 'interest',
      },
    ],
    reconciliations: [
      {
        status: 'confirmed',
        type: 'fx_transfer',
        links: [{ transactionId: 'fx-brl' }],
      },
    ],
  } as unknown as FinanceSnapshot
  expect(
    accountInflowsByCurrency(snapshot, {
      start: '2026-08-07',
      end: '2026-09-05',
    }),
  ).toEqual([
    {
      currency: 'BRL',
      cents: 1_663,
      transactionIds: ['interest'],
      uncategorizedCount: 0,
    },
    {
      currency: 'USD',
      cents: 1_200_000,
      transactionIds: ['salary-usd'],
      uncategorizedCount: 1,
    },
  ])
})

it('explica separadamente recebimentos estimados, documentos e repetição do histórico', () => {
  const { snapshot, today } = snapshotWithMonthlyRecurrence()
  const income = {
    ...snapshot.recurrences[0],
    id: 'income',
    direction: 'income' as const,
    amountCents: 60_000,
    occurrences: [
      {
        ...snapshot.recurrences[0].occurrences[0],
        direction: 'income' as const,
        expectedAmountCents: 60_000,
      },
    ],
  }
  snapshot.recurrences.push(income)
  snapshot.cards = [
    {
      currency: 'BRL',
      scope: null,
      upcomingStatements: [
        {
          dueDate: shiftDays(today, 2),
          amountCents: 20_000,
          certainty: 'closed',
        },
        {
          dueDate: shiftDays(today, 3),
          amountCents: 30_000,
          certainty: 'installment_schedule',
        },
        { dueDate: shiftDays(today, 4), amountCents: 5_000 },
      ],
    },
  ] as unknown as FinanceSnapshot['cards']
  snapshot.transactions = [
    {
      id: 'one-off',
      accountId: 'operating-account',
      creditCardId: null,
      description: 'Pagamento a esclarecer',
      postedAt: shiftDays(today, -1),
      currency: 'BRL',
      amountCents: -60_000,
      status: 'confirmed',
      categoryId: 'uncategorized',
      category: { id: 'uncategorized', bucket: 'excluded' },
    },
  ] as unknown as FinanceSnapshot['transactions']
  const projection = projectCash(snapshot, 0, 30, today)
  expect(projection.assumptions).toMatchObject({
    days: 30,
    startingCents: 0,
    estimatedIncomeCents: 60_000,
    estimatedRecurrenceCents: 10_000,
    closedCardCents: 20_000,
    scheduledCardCents: 30_000,
    estimatedCardCents: 5_000,
    historicalEstimateCents: 30_000,
  })
  expect(projection.in30Cents).toBe(-35_000)
  expect(projection.largestHistoricalExpenses[0]).toMatchObject({
    id: 'one-off',
    cents: 60_000,
  })
})
