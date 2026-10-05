import { describe, expect, it } from 'vitest'

import { pendingReviewItems, reviewDestination } from './review'

describe('overview review', () => {
  it('has no review entry when no real items remain', () => {
    expect(pendingReviewItems([], '2026-09')).toEqual([])
    expect(
      pendingReviewItems(
        [{ code: 'pending_entry', count: 0, blocksClosing: true }],
        '2026-09',
      ),
    ).toEqual([])
  })

  it('lists blocking decisions first and keeps data gaps that do not block closing', () => {
    expect(
      pendingReviewItems(
        [
          { code: 'missing_balance', count: 2, blocksClosing: false },
          { code: 'uncategorized', count: 3, blocksClosing: true },
        ],
        '2026-09',
      ).map(({ code, count, destination }) => ({ code, count, destination })),
    ).toEqual([
      { code: 'uncategorized', count: 3, destination: 'uncategorized' },
      { code: 'missing_balance', count: 2, destination: 'accounts' },
    ])
  })

  it('sends each decision where it is made, starting transactions on page one', () => {
    expect(reviewDestination('uncategorized')).toMatchObject({
      to: '/transacoes',
      search: { category: 'uncategorized', page: 1, search: '', target: 'all' },
    })
    expect(reviewDestination('review')).toMatchObject({
      to: '/transacoes',
      search: { category: 'review' },
    })
    expect(reviewDestination('recurrences')).toEqual({
      to: '/configuracoes',
      search: { tab: 'recorrencias' },
    })
  })
})
