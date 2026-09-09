// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  stripSearchParams,
} from '@tanstack/react-router'
import {
  transactionSearchDefaults,
  transactionSearchSchema,
  transactionSearchToFilters,
} from './transactions.search'

afterEach(cleanup)

it('validates URL values and preserves centavo precision and legacy category links', () => {
  const load = (value: string) =>
    transactionSearchSchema.parse(
      Object.fromEntries(
        [...new URLSearchParams(value)].map(([key, val]) => [
          key,
          key === 'page' ? Number(val) : val,
        ]),
      ),
    )
  for (const page of ['0', '-1', '1.5', '2oops', '1000002', 'NaN']) {
    expect(load(`?page=${page}`).page).toBe(1)
  }
  const state = load(
    '?page=3&category=uncategorized&direction=invalid&minAmount=1.500%2C51',
  )
  expect(transactionSearchToFilters(state)).toMatchObject({
    page: 2,
    category: 'all',
    onlyUncategorized: true,
    direction: 'all',
    minCents: 150051,
  })
  expect(load(`?search=${'x'.repeat(250)}`).search).toHaveLength(200)
})

it('keeps URL state, loader dependencies and back/forward navigation in sync', async () => {
  function Controls() {
    const state = route.useSearch()
    const navigate = route.useNavigate()
    const setState = (updates: Partial<typeof state> | null) =>
      navigate({
        search: (previous) =>
          updates === null
            ? transactionSearchDefaults
            : { ...previous, ...updates },
      })
    return (
      <>
        <output data-testid="state">
          {JSON.stringify(transactionSearchToFilters(state))}
        </output>
        <button onClick={() => void setState({ page: state.page + 1 })}>
          Next
        </button>
        <button
          onClick={() => void setState({ search: 'Despesa 121', page: 1 })}
        >
          Filter
        </button>
        <button onClick={() => void setState(null)}>Clear</button>
      </>
    )
  }
  const root = createRootRoute({ component: () => <Outlet /> })
  const route = createRoute({
    getParentRoute: () => root,
    path: '/transacoes',
    validateSearch: transactionSearchSchema,
    search: { middlewares: [stripSearchParams(transactionSearchDefaults)] },
    loaderDeps: ({ search }) => transactionSearchToFilters(search),
    loader: ({ deps }) => deps,
    component: Controls,
  })
  const history = createMemoryHistory({
    initialEntries: ['/transacoes?page=2&category=uncategorized'],
  })
  const router = createRouter({ routeTree: root.addChildren([route]), history })
  render(<RouterProvider router={router} />)
  const state = () => JSON.parse(screen.getByTestId('state').textContent)
  await waitFor(() => expect(state().page).toBe(1))
  fireEvent.click(screen.getByText('Next'))
  await waitFor(() =>
    expect(router.state.location.search).toMatchObject({ page: 3 }),
  )
  expect(state().onlyUncategorized).toBe(true)
  fireEvent.click(screen.getByText('Filter'))
  await waitFor(() =>
    expect(router.state.location.search).toMatchObject({
      search: 'Despesa 121',
    }),
  )
  expect(state().page).toBe(0)
  history.back()
  await waitFor(() => expect(state()).toMatchObject({ page: 2, search: '' }))
  history.forward()
  await waitFor(() =>
    expect(state()).toMatchObject({ page: 0, search: 'Despesa 121' }),
  )
  fireEvent.click(screen.getByText('Clear'))
  await waitFor(() => expect(router.state.location.searchStr).toBe(''))
})
