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

import type { MonthView } from '@spendle/server/api'

import { MonthlyOverview } from './monthly-overview'

vi.mock('#/features/v2/planning.functions', () => ({
  monthlyAnalysisFn: vi.fn(),
}))

const { fetchHistory } = vi.hoisted(() => ({ fetchHistory: vi.fn() }))
vi.mock('#/features/v2/queries', () => ({
  monthHistoryOptions: () => ({
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

function month(
  value: string,
  input: {
    closed?: boolean
    forecasting?: boolean
    targets?: MonthView['targets']
    expenses?: { essential?: number; lifestyle?: number; other?: number }
    saved?: { investment?: number; reserve?: number }
    cash?: Partial<MonthView['cashFlow']>
    hasData?: boolean
  } = {},
): MonthView {
  const goals = input.targets ?? targets
  const expenses = { essential: 0, lifestyle: 0, other: 0, ...input.expenses }
  const saved = { investment: 0, reserve: 0, ...input.saved }
  const forecasting = input.forecasting ?? false
  return {
    month: value,
    referenceMonth: '2026-09',
    closed: input.closed ?? false,
    forecasting,
    strategy: { id: 'strategy-balanced', name: 'Equilibrada' },
    baseIncomeCents: 100000,
    allocation: {
      essential: 4000,
      lifestyle: 2000,
      investment: 3000,
      reserve: 1000,
    },
    effectiveAllocation: {
      essential: 4000,
      lifestyle: 2000,
      investment: 3000,
      reserve: 1000,
    },
    targets: goals,
    reserve: {
      currentCents: 0,
      targetCents: 0,
      months: 6,
      complete: false,
      redirected: false,
    },
    incomeCents: 0,
    actual: {
      ...zero,
      essential: expenses.essential,
      lifestyle: expenses.lifestyle,
      ...saved,
    },
    family: {
      plannedIncomeCents: 100000,
      knownExpenseCents:
        expenses.essential + expenses.lifestyle + expenses.other,
      estimatedExpenseCents: 0,
      expenseCents: expenses.essential + expenses.lifestyle + expenses.other,
      savedCents: saved.investment + saved.reserve,
      savingsTargetCents: goals.investment + goals.reserve,
      savingsRemainingCents: 0,
      plannedBalanceCents: 0,
      expenses: (['essential', 'lifestyle', 'other'] as const).map(
        (bucket) => ({
          bucket,
          cents: expenses[bucket],
          knownCents: expenses[bucket],
          estimatedCents: 0,
          targetCents: bucket === 'other' ? null : goals[bucket],
        }),
      ),
      lines: [],
      needsCategoryCount: 0,
      warnings: [],
      hasData: input.hasData ?? true,
    },
    cashFlow: {
      forecasting,
      openingCashCents: 10000,
      cashCents: 50000,
      receivedCents: 70000,
      paidCents: 30000,
      expectedIncomeCents: 0,
      remainingExpenseCents: 0,
      closingCashCents: 50000,
      afterGoalsCents: 50000,
      ...input.cash,
    },
    integrity: { partial: false, issues: [], closingBlockerCount: 0 },
  }
}

const current = month('2026-09', {
  forecasting: true,
  expenses: { essential: 1001 },
  cash: {
    expectedIncomeCents: 20000,
    remainingExpenseCents: 15024,
    closingCashCents: 54976,
    afterGoalsCents: 14976,
  },
})
const closedAugust = month('2026-08', {
  closed: true,
  targets: { ...targets, essential: 80002 },
  expenses: { essential: 12345, lifestyle: 6789 },
  saved: { investment: 25001 },
})
const emptyJuly = month('2026-07', { hasData: false })

const clients: QueryClient[] = []
afterEach(() => {
  cleanup()
  clients.forEach((client) => client.clear())
  clients.length = 0
  vi.resetAllMocks()
})
function mount(view: MonthView = current, client?: QueryClient) {
  const queries =
    client ?? new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(queries)
  return render(
    <QueryClientProvider client={queries}>
      <MonthlyOverview current={view} />
    </QueryClientProvider>,
  )
}

describe('monthly overview', () => {
  it('switches months without replacing closed targets with the current strategy or losing cents', async () => {
    fetchHistory.mockResolvedValue([closedAugust, emptyJuly])
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
    expect(screen.getByText('R$ 250,01')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Julho de 2026:/ }))
    expect(screen.getByText('Sem valores para comparar')).toBeTruthy()
    expect(previous.hasAttribute('disabled')).toBe(true)
    expect(
      within(
        screen.getByRole('group', { name: 'Selecionar mês' }),
      ).getAllByRole('button'),
    ).toHaveLength(3)
  })

  it('marks individual overspending without offsetting unused budget or extra investments', async () => {
    fetchHistory.mockResolvedValue([
      month('2026-08', {
        closed: true,
        expenses: { essential: 50001 },
        saved: { investment: 90000 },
      }),
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
    expect(
      screen.getByText('Gastos acima dos limites', { selector: 'p' }),
    ).toBeTruthy()
    expect(screen.getByText(/R\$ 100,01 de excesso/)).toBeTruthy()
    expect(
      screen.getByRole('img', { name: '100% da meta de investimentos' }),
    ).toBeTruthy()
    expect(screen.getByText('Abaixo da meta: R$ 100,00')).toBeTruthy()
  })

  it('reports a closed current month honestly', async () => {
    fetchHistory.mockResolvedValue([closedAugust])
    mount(month('2026-09', { closed: true }))
    expect(await screen.findByText('Orçamento fechado')).toBeTruthy()
    expect(screen.queryByText('Em andamento')).toBeNull()
  })

  it('offers retry after a failed history read instead of showing an empty history', async () => {
    fetchHistory
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue([closedAugust])
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

  it('keeps cached months visible while stale history refreshes', () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    })
    client.setQueryData(['monthly-overview-test'], [closedAugust])
    fetchHistory.mockReturnValue(new Promise(() => {}))
    mount(current, client)
    expect(screen.queryByLabelText('Carregando histórico mensal')).toBeNull()
    expect(screen.getByRole('button', { name: /Agosto de 2026:/ })).toBeTruthy()
    expect(fetchHistory).toHaveBeenCalledOnce()
  })

  it('shows the month’s cash and its forecast only while the month is open', async () => {
    fetchHistory.mockResolvedValue([closedAugust])
    mount()
    await screen.findByRole('button', {
      name: /Setembro de 2026: caixa previsto.*549,76/,
    })
    const labels = () =>
      [
        ...screen.getByLabelText('Movimentação do mês').querySelectorAll('dt'),
      ].map((el) => el.textContent)
    expect(labels()).toEqual([
      'Caixa inicial',
      'Entradas recebidas',
      'Saídas pagas',
      'Caixa',
    ])
    expect(screen.getByRole('region', { name: 'Previsão do mês' })).toBeTruthy()
    expect(screen.getByText('R$ 150,24', { selector: 'dd' })).toBeTruthy()
    expect(screen.getByText('R$ 549,76', { selector: 'dd' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Agosto de 2026:/ }))
    expect(screen.queryByRole('region', { name: 'Previsão do mês' })).toBeNull()
    expect(
      within(screen.getByLabelText('Movimentação do mês')).getByText(
        'R$ 700,00',
      ),
    ).toBeTruthy()
  })
})
