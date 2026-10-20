// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vite-plus/test'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { LinkPaymentDialog } from './recurrence-dialogs'
import type { RecurrenceView } from './types'

const { fetchCandidates } = vi.hoisted(() => ({ fetchCandidates: vi.fn() }))
vi.mock('#/features/data/queries', () => ({
  recurrenceCandidatesOptions: () => ({
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
function candidate(
  id: string,
  categoryId: string | null,
  description: string,
  amountCents: number,
) {
  return {
    entryId: id,
    sameCategory: false,
    amountDifferenceCents: 0,
    daysApart: 1,
    rank: 0,
    entry: {
      id,
      accountId: 'checking',
      accountName: 'Conta',
      bookedOn: '2026-09-02',
      description,
      amountCents,
      currency: 'BRL',
      categoryId,
    },
  }
}
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
        id: 'r1|2026-09-01',
        status: 'expected',
        expectedDate: '2026-09-01',
        expectedAmountCents: 6000000,
        currency: 'BRL',
      },
    ],
  } as unknown as RecurrenceView
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
    ...Array.from({ length: 210 }, (_, i) =>
      candidate(`yield-${i}`, 'yield', `Rendimento ${i}`, 100),
    ),
    candidate('salary-1', 'salary', 'Pagamento cliente', 6000000),
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
  expect(onLink).toHaveBeenCalledWith('r1|2026-09-01', ['salary-1'])
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
    candidate('unknown', null, 'Compra sem categoria', -100),
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
