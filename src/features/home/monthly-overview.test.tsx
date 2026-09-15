// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MonthlyOverview } from './monthly-overview'
import { buildFamilyMonth } from '#/domain/family-month'
import { buildCommitmentBudget } from '#/domain/commitment-budget'
import type { StrategyDashboard } from '#/features/finance/strategy-progress'

vi.mock('./analysis.functions', () => ({ generateMonthlyAnalysisFn: vi.fn() }))

const { fetchHistory } = vi.hoisted(() => ({ fetchHistory: vi.fn() }))
vi.mock('#/features/finance/queries', () => ({
  strategyHistoryOptions: () => ({
    queryKey: ['monthly-overview-test'],
    queryFn: fetchHistory,
    retry: false,
  }),
}))
const targets = {
  essential: 40000,
  lifestyle: 20000,
  investment: 30000,
  reserve: 10000,
}
const zero = { essential: 0, lifestyle: 0, investment: 0, reserve: 0 }
const dashboard: StrategyDashboard = {
  currentMonth: '2026-09',
  activeStrategy: { name: 'Atual' },
  baseIncomeCents: 100000,
  currentIncomeCents: 100001,
  budgetTargets: targets,
  budgetActual: { ...zero, essential: 1001 },
  budgetProjected: zero,
}
const closedMonth = {
  month: '2026-08',
  strategyName: 'Estratégia anterior',
  incomeCents: 200003,
  targets: { ...targets, essential: 80002 },
  actual: { ...zero, essential: 12345, lifestyle: 6789, investment: 25001 },
  closed: true,
  hasData: true,
}
const emptyMonth = {
  ...closedMonth,
  month: '2026-07',
  closed: false,
  hasData: false,
  actual: zero,
  incomeCents: 0,
}
const clients: QueryClient[] = []
afterEach(() => {
  cleanup()
  clients.forEach((client) => client.clear())
  clients.length = 0
  vi.resetAllMocks()
})
function mount(currentClosed = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      <MonthlyOverview dashboard={dashboard} currentClosed={currentClosed} />
    </QueryClientProvider>,
  )
}

describe('monthly overview', () => {
  it('switches months without replacing closed targets with the current strategy or losing cents', async () => {
    fetchHistory.mockResolvedValue([closedMonth, emptyMonth])
    mount()
    const previous = await screen.findByRole('button', { name: 'Mês anterior' })
    await screen.findByRole('button', { name: /Agosto de 2026:/ })
    expect(
      screen
        .getByRole('button', { name: 'Próximo mês' })
        .hasAttribute('disabled'),
    ).toBe(true)
    fireEvent.click(previous)
    expect(screen.getByRole('heading', { name: 'Agosto de 2026' })).toBeTruthy()
    expect(screen.getByText('Orçamento fechado')).toBeTruthy()
    expect(screen.getByText('Limite R$ 800,02', { exact: false })).toBeTruthy()
    expect(screen.getByText('R$ 191,34')).toBeTruthy()
    expect(screen.getByText('R$ 250,01', { selector: 'dd' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Julho de 2026:/ }))
    expect(screen.getByText('Sem valores para comparar')).toBeTruthy()
    expect(screen.queryByText('Renda do orçamento')).toBeNull()
    expect(previous.hasAttribute('disabled')).toBe(true)
    expect(
      within(
        screen.getByRole('group', { name: 'Selecionar mês' }),
      ).getAllByRole('button'),
    ).toHaveLength(3)
  })
  it('marks individual overspending without offsetting unused lifestyle budget or extra investments', async () => {
    fetchHistory.mockResolvedValue([
      {
        ...closedMonth,
        actual: { ...zero, essential: 90003, investment: 90000 },
      },
    ])
    mount()
    const august = await screen.findByRole('button', {
      name: /Agosto de 2026:.*gastos acima dos limites/,
    })
    expect(
      screen
        .getByRole('button', { name: /Setembro de 2026:/ })
        .getAttribute('aria-pressed'),
    ).toBe('true')
    fireEvent.click(august)
    expect(screen.getByText('Gastos acima dos limites')).toBeTruthy()
    expect(screen.getByText(/R\$ 100,01 de excesso/)).toBeTruthy()
    expect(
      screen.getByRole('img', { name: '100% da meta de investimentos' }),
    ).toBeTruthy()
    expect(screen.getByText('Abaixo da meta: R$ 100,00')).toBeTruthy()
  })
  it('reports a closed current month honestly', async () => {
    fetchHistory.mockResolvedValue([closedMonth])
    mount(true)
    expect(await screen.findByText('Orçamento fechado')).toBeTruthy()
    expect(screen.queryByText('Em andamento')).toBeNull()
  })
  it('offers retry after a failed history read instead of showing an empty history', async () => {
    fetchHistory
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue([closedMonth])
    mount()
    fireEvent.click(
      await screen.findByRole('button', { name: 'Tentar novamente' }),
    )
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Agosto de 2026:/ }),
      ).toBeTruthy(),
    )
  })
  it('keeps cached months visible while stale history refreshes', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    })
    clients.push(client)
    client.setQueryData(['monthly-overview-test'], [closedMonth])
    fetchHistory.mockReturnValue(new Promise(() => {}))

    render(
      <QueryClientProvider client={client}>
        <MonthlyOverview dashboard={dashboard} />
      </QueryClientProvider>,
    )

    expect(
      screen.queryByLabelText('Carregando histórico mensal'),
    ).toBeNull()
    expect(
      screen.getByRole('button', { name: /Agosto de 2026:/ }),
    ).toBeTruthy()
    expect(fetchHistory).toHaveBeenCalledOnce()
  })
  it('shows monthly cash projections with spending bars and contribution rings', async () => {
    fetchHistory.mockResolvedValue([])
    const budget = buildCommitmentBudget({
      month: '2026-09',
      today: '2026-09-08',
      incomeCents: 100000,
      targets,
      transactions: [],
      statements: [],
      recurrences: [],
      coveragePartial: false,
    })
    budget.lines = [
      {
        id: 'bill',
        date: '2026-09-12',
        description: 'Compra de agosto',
        cents: 12345,
        categoryId: 'shopping',
        bucket: 'lifestyle',
        certainty: 'documented',
        paidCents: 0,
        origin: 'card',
      },
      {
        id: 'other',
        date: '2026-09-12',
        description: 'Compra a classificar',
        cents: 678,
        categoryId: null,
        bucket: 'other',
        certainty: 'documented',
        paidCents: 0,
        origin: 'card',
      },
      {
        id: 'estimate',
        date: '2026-09-30',
        description: 'Mercado estimado',
        cents: 2001,
        categoryId: 'groceries',
        bucket: 'essential',
        certainty: 'estimated',
        paidCents: 0,
        origin: 'variable',
      },
    ]
    const familyMonth = buildFamilyMonth({
      month: '2026-09',
      referenceMonth: '2026-09',
      closed: false,
      incomeCents: 0,
      plannedIncomeCents: 100000,
      targets,
      saved: { investment: 0, reserve: 0 },
      budget,
    })
    const consistent = {
      ...dashboard,
      currentIncomeCents: 0,
      budgetActual: zero,
      monthlyCommitments: budget,
      familyMonth: {
        ...familyMonth,
        cashFlow: {
          forecasting: true,
          openingCashCents: 50000,
          cashCents: 50000,
          receivedCents: 0,
          paidCents: 0,
          expectedIncomeCents: 20000,
          remainingExpenseCents: 15024,
          goalRemainingCents: 40000,
          closingCashCents: 54976,
          afterGoalsCents: 14976,
          unexplainedChangeCents: 0,
        },
      },
    }
    fetchHistory.mockResolvedValue([
      {
        ...closedMonth,
        familyMonth: {
          ...consistent.familyMonth,
          forecasting: false,
          cashFlow: {
            forecasting: false,
            openingCashCents: 10000,
            cashCents: 50000,
            receivedCents: 70000,
            paidCents: 30000,
            expectedIncomeCents: 0,
            remainingExpenseCents: 0,
            goalRemainingCents: 0,
            closingCashCents: 50000,
            afterGoalsCents: 50000,
            unexplainedChangeCents: 0,
          },
        },
      },
    ])
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    clients.push(client)
    render(
      <QueryClientProvider client={client}>
        <MonthlyOverview dashboard={consistent} />
      </QueryClientProvider>,
    )
    await screen.findByRole('button', {
      name: /Setembro de 2026: caixa previsto.*549,76/,
    })
    expect(screen.getAllByText('R$ 123,45')).toHaveLength(1)
    expect(screen.getAllByText('R$ 20,01')).toHaveLength(1)
    expect(screen.getAllByText('R$ 6,78')).toHaveLength(1)
    expect(screen.getByText('R$ 150,24', { selector: 'dd' })).toBeTruthy()
    expect(screen.getAllByText('R$ 500,00')).toHaveLength(2)
    expect(screen.getByText('R$ 149,76')).toBeTruthy()
    expect(screen.getByText('R$ 549,76', { selector: 'dd' })).toBeTruthy()
    expect(screen.queryByText(/Renda base|Renda confirmada/)).toBeNull()
    const labels = () =>
      [
        ...screen.getByLabelText('Movimentação do mês').querySelectorAll('dt'),
      ].map((el) => el.textContent)
    const currentLabels = labels()
    expect(currentLabels).toEqual([
      'Caixa inicial',
      'Entradas recebidas',
      'Saídas pagas',
      'Caixa',
    ])
    expect(screen.getByRole('region', { name: 'Previsão do mês' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Agosto de 2026:/ }))
    expect(labels()).toEqual(currentLabels)
    expect(screen.queryByRole('region', { name: 'Previsão do mês' })).toBeNull()
    expect(
      within(screen.getByLabelText('Movimentação do mês')).getByText(
        'R$ 700,00',
      ),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Setembro de 2026:/ }))
    expect(labels()).toEqual(currentLabels)
    expect(screen.getAllByRole('progressbar')).toHaveLength(2)
    expect(
      screen.getByRole('img', { name: '0% da meta de investimentos' }),
    ).toBeTruthy()
  })
})
