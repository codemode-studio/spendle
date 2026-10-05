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
  expect(transactionSearchToFilters(state)).toEqual({
    page: 2,
    categoryStatus: 'none',
    minAmountCents: 150051,
  })
  expect(
    transactionSearchToFilters(
      load('?category=review&direction=out&target=acc-1&search=%20pao%20'),
    ),
  ).toEqual({
    page: 0,
    categoryStatus: 'review',
    direction: 'outflow',
    accountId: 'acc-1',
    text: 'pao',
  })
  expect(load(`?search=${'x'.repeat(250)}`).search).toHaveLength(200)
  expect(load('?dateFrom=2026-02-29&dateTo=invalid')).toMatchObject({
    dateFrom: '',
    dateTo: '',
  })
  expect(
    transactionSearchToFilters(load('?dateFrom=2026-08-05&dateTo=2026-08-21')),
  ).toMatchObject({ from: '2026-08-05', to: '2026-08-21' })
})
