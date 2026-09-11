import { describe, expect, it } from 'vitest'
import type { IntegrityIssue } from '#/domain/financial-summary'
import type { PlanningSnapshot } from '#/features/finance/snapshot.types'
import { pendingReviewItems, reviewDestination } from './review'

function snapshot(issues: IntegrityIssue[]) {
  return {
    dashboard: { currentMonth: '2026-09', integrity: { issues } },
    recurrences: [],
  } as unknown as PlanningSnapshot
}

describe('overview review', () => {
  it('has no review entry when no real items remain', () => {
    expect(pendingReviewItems(snapshot([]))).toEqual([])
    expect(
      pendingReviewItems(
        snapshot([{ code: 'review_import', count: 0, blocksClosing: true }]),
      ),
    ).toEqual([])
  })

  it('includes non-blocking balance warnings without changing closing rules', () => {
    const data = snapshot([
      { code: 'unverified_balance', count: 2, blocksClosing: false },
      { code: 'uncategorized_confirmed', count: 3, blocksClosing: true },
    ])
    const before = structuredClone(data)
    expect(
      pendingReviewItems(data).map(({ code, count, destination }) => ({
        code,
        count,
        destination,
      })),
    ).toEqual([
      {
        code: 'uncategorized_confirmed',
        count: 3,
        destination: 'uncategorized',
      },
      { code: 'unverified_balance', count: 2, destination: 'accounts' },
    ])
    expect(data).toEqual(before)
  })

  it('does not duplicate an already blocking balance issue', () => {
    expect(
      pendingReviewItems(
        snapshot([
          { code: 'unverified_balance', count: 2, blocksClosing: true },
        ]),
      ),
    ).toHaveLength(1)
  })

  it('reuses the review destination and starts uncategorized transactions on page one', () => {
    expect(reviewDestination('imports')).toEqual({
      to: '/importar',
      search: { view: 'review' },
    })
    expect(reviewDestination('uncategorized')).toMatchObject({
      to: '/transacoes',
      search: { category: 'uncategorized', page: 1, search: '', target: 'all' },
    })
    expect(reviewDestination('recurrences')).toEqual({
      to: '/configuracoes',
      search: { tab: 'recorrencias' },
    })
  })
})
