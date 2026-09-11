// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MonthlyAssistant } from './monthly-assistant'

const report = {
  healthScore: 50,
  healthLabel: 'Atenção',
  findings: [],
  actions: [],
}

const { generate } = vi.hoisted(() => ({ generate: vi.fn() }))
vi.mock('./analysis.functions', () => ({ generateMonthlyAnalysisFn: generate }))
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})
it('never calls the model when the assistant is disabled', () => {
  const client = new QueryClient()
  render(
    <QueryClientProvider client={client}>
      <MonthlyAssistant month="2026-09" revision="a" configured={false} />
    </QueryClientProvider>,
  )
  expect(screen.getByText(/Ative o assistente/)).toBeTruthy()
  expect(generate).not.toHaveBeenCalled()
  client.clear()
})
it('keeps responses scoped to month and refreshes when its figures change', async () => {
  let finishSeptember!: (value: {
    headline: string
    summary: string
    healthScore: number
    healthLabel: string
    findings: never[]
    actions: never[]
  }) => void
  generate
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSeptember = resolve
        }),
    )
    .mockResolvedValueOnce({
      ...report,
      headline: 'Agosto',
      summary: 'Gastos acima dos limites em agosto.',
    })
    .mockResolvedValueOnce({
      ...report,
      headline: 'Agosto atualizado',
      summary: 'Novos números de agosto.',
    })
  const client = new QueryClient()
  const view = (month: string, revision: string) => (
    <QueryClientProvider client={client}>
      <MonthlyAssistant month={month} revision={revision} configured closed />
    </QueryClientProvider>
  )
  const { rerender } = render(view('2026-09', 'a'))
  await waitFor(() =>
    expect(generate).toHaveBeenCalledWith({ data: { month: '2026-09' } }),
  )
  rerender(view('2026-08', 'a'))
  await screen.findByText('Gastos acima dos limites em agosto.')
  finishSeptember({
    ...report,
    headline: 'Setembro',
    summary: 'Resposta atrasada de setembro.',
  })
  expect(screen.queryByText('Resposta atrasada de setembro.')).toBeNull()
  rerender(view('2026-08', 'b'))
  await screen.findByText('Novos números de agosto.')
  expect(generate).toHaveBeenCalledTimes(3)
  client.clear()
})

it('waits for closing before generating and starts after closing', async () => {
  generate.mockResolvedValue({
    ...report,
    headline: 'Fechamento',
    summary: 'Plano do mês.',
  })
  const client = new QueryClient()
  const view = (closed: boolean) => (
    <QueryClientProvider client={client}>
      <MonthlyAssistant
        month="2026-08"
        revision="same"
        configured
        closed={closed}
      />
    </QueryClientProvider>
  )
  const { rerender } = render(view(false))
  expect(screen.getByText(/A análise será gerada ao fechar/)).toBeTruthy()
  expect(generate).not.toHaveBeenCalled()
  rerender(view(true))
  await screen.findByText('Plano do mês.')
  expect(generate).toHaveBeenCalledTimes(1)
  client.clear()
})
