// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { LinkPaymentDialog } from './recurrence-dialogs'
import type { RecurrenceSnapshot } from '#/features/finance/snapshot.types'

const { fetchCandidates } = vi.hoisted(() => ({ fetchCandidates: vi.fn() }))
vi.mock('#/features/finance/queries', () => ({
  recurrenceLinkCandidatesOptions: () => ({
    queryKey: ['link-test'],
    queryFn: fetchCandidates,
  }),
}))
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})
const categories = [
  { id: 'salary', name: 'Salário', bucket: 'income' as const },
  { id: 'yield', name: 'Rendimentos', bucket: 'income' as const },
  { id: 'food', name: 'Mercado', bucket: 'essential' as const },
  { id: 'leisure', name: 'Lazer', bucket: 'lifestyle' as const },
]
function mount(direction: 'income' | 'expense') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const recurrence = {
    name: 'Recorrência de teste',
    direction,
    matchMode: 'aggregate',
    occurrences: [
      {
        id: 'o1',
        status: 'expected',
        expectedDate: '2026-09-01',
        expectedAmountCents: 6000000,
        currency: 'BRL',
      },
    ],
  } as RecurrenceSnapshot
  const onLink = vi.fn()
  render(
    <QueryClientProvider client={client}>
      <LinkPaymentDialog
        recurrence={recurrence}
        categories={categories}
        pending={false}
        open
        onOpenChange={vi.fn()}
        onLink={onLink}
      />
    </QueryClientProvider>,
  )
  return { client, onLink }
}
it('filters by income category and search before limiting candidates, and clears hidden selections', async () => {
  fetchCandidates.mockResolvedValue([
    ...Array.from({ length: 210 }, (_, i) => ({
      id: `yield-${i}`,
      categoryId: 'yield',
      description: `Rendimento ${i}`,
      postedAt: '2026-09-02',
      amountCents: 100,
      currency: 'BRL',
      inWindow: true,
    })),
    {
      id: 'salary-1',
      categoryId: 'salary',
      description: 'Pagamento cliente',
      postedAt: '2026-09-02',
      amountCents: 6000000,
      currency: 'BRL',
      inWindow: true,
    },
  ])
  const { client, onLink } = mount('income')
  await screen.findByText('Rendimento 0')
  const filter = screen.getByRole('combobox', { name: 'Filtrar por categoria' })
  expect(within(filter).queryByRole('option', { name: 'Mercado' })).toBeNull()
  fireEvent.change(filter, { target: { value: 'salary' } })
  fireEvent.change(screen.getByRole('textbox', { name: 'Buscar transação' }), {
    target: { value: 'cliente' },
  })
  fireEvent.click(screen.getByRole('button', { name: /Pagamento cliente/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Vincular e conciliar' }))
  expect(onLink).toHaveBeenCalledWith('o1', ['salary-1'])
  fireEvent.change(filter, { target: { value: 'yield' } })
  expect(
    screen
      .getByRole('button', {
        name: 'Vincular e conciliar',
      })
      .hasAttribute('disabled'),
  ).toBe(true)
  expect(screen.queryByText('Pagamento cliente')).toBeNull()
  client.clear()
})
it('offers expense categories and uncategorized transactions for expenses', async () => {
  fetchCandidates.mockResolvedValue([
    {
      id: 'unknown',
      categoryId: null,
      description: 'Compra sem categoria',
      postedAt: '2026-09-02',
      amountCents: -100,
      currency: 'BRL',
      inWindow: true,
    },
  ])
  const { client } = mount('expense')
  await screen.findByText('Compra sem categoria')
  const filter = screen.getByRole('combobox', { name: 'Filtrar por categoria' })
  expect(within(filter).queryByRole('option', { name: 'Salário' })).toBeNull()
  expect(within(filter).getByRole('option', { name: 'Mercado' })).toBeTruthy()
  expect(within(filter).getByRole('option', { name: 'Lazer' })).toBeTruthy()
  fireEvent.change(filter, { target: { value: 'uncategorized' } })
  expect(screen.getByText('Compra sem categoria')).toBeTruthy()
  client.clear()
})
