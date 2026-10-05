import { linkOptions } from '@tanstack/react-router'
import type { IntegrityIssue } from '@spendle/server/api'

import { transactionSearchDefaults } from '#/features/finance/transactions.search'
import { presentIssues } from '#/features/planning/closing-issues'
import type { ClosingIssueDestination } from '#/features/planning/closing-issues'

/** The month's pending decisions, blocking ones first, then data gaps that do not block closing. */
export function pendingReviewItems(
  issues: ReadonlyArray<IntegrityIssue>,
  month: string,
) {
  const items = presentIssues(issues, { month })
  return [
    ...items.filter((item) => item.blocksClosing),
    ...items.filter((item) => !item.blocksClosing),
  ]
}

export function reviewDestination(destination: ClosingIssueDestination) {
  switch (destination) {
    case 'accounts':
      return linkOptions({ to: '/configuracoes', search: { tab: 'contas' } })
    case 'recurrences':
      return linkOptions({
        to: '/configuracoes',
        search: { tab: 'recorrencias' },
      })
    case 'uncategorized':
      return linkOptions({
        to: '/transacoes',
        search: { ...transactionSearchDefaults, category: 'uncategorized' },
      })
    case 'review':
      return linkOptions({
        to: '/transacoes',
        search: { ...transactionSearchDefaults, category: 'review' },
      })
    default:
      return linkOptions({
        to: '/transacoes',
        search: transactionSearchDefaults,
      })
  }
}
