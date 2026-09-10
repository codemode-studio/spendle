import { expect, it } from 'vitest'

import {
  transactionSearchSchema,
  transactionSearchToFilters,
} from './transactions.search'

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
