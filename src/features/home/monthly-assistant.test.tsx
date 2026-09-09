// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MonthlyAssistant } from './monthly-assistant'

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
  let finishSeptember!: (value: { headline: string; summary: string }) => void
  generate
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSeptember = resolve
        }),
    )
    .mockResolvedValueOnce({
      headline: 'Agosto',
      summary: 'Gastos acima dos limites em agosto.',
    })
    .mockResolvedValueOnce({
      headline: 'Agosto atualizado',
      summary: 'Novos números de agosto.',
    })
  const client = new QueryClient()
  const view = (month: string, revision: string) => (
    <QueryClientProvider client={client}>
      <MonthlyAssistant month={month} revision={revision} configured />
    </QueryClientProvider>
  )
  const { rerender } = render(view('2026-09', 'a'))
  await waitFor(() =>
    expect(generate).toHaveBeenCalledWith({ data: { month: '2026-09' } }),
  )
  rerender(view('2026-08', 'a'))
  await screen.findByText('Gastos acima dos limites em agosto.')
  finishSeptember({
    headline: 'Setembro',
    summary: 'Resposta atrasada de setembro.',
  })
  expect(screen.queryByText('Resposta atrasada de setembro.')).toBeNull()
  rerender(view('2026-08', 'b'))
  await screen.findByText('Novos números de agosto.')
  expect(generate).toHaveBeenCalledTimes(3)
  client.clear()
})
