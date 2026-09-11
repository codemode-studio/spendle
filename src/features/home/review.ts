import { linkOptions } from '@tanstack/react-router'
import { todayIso } from '#/domain/period'
import type { PlanningSnapshot } from '#/features/finance/snapshot.types'
import { transactionSearchDefaults } from '#/features/finance/transactions.search'
import { buildClosingIssuePresentations } from '#/features/planning/closing-issues'
import type { ClosingIssueDestination } from '#/features/planning/closing-issues'

/** Same pending decisions as planning, plus the non-blocking balance warning. */
export function pendingReviewItems(data: PlanningSnapshot, today = todayIso()) {
  const items = buildClosingIssuePresentations(data, { today })
  const balance = data.dashboard.integrity.issues.find(
    (issue) => issue.code === 'unverified_balance' && !issue.blocksClosing,
  )
  if (balance) {
    items.push({
      code: balance.code,
      count: balance.count,
      label: 'Saldos sem verificação recente',
      actionLabel: 'Conferir contas',
      destination: 'accounts',
      detail: 'Atualize os extratos para conferir os saldos.',
    })
  }
  return items.filter((item) => item.count > 0)
}

export function reviewDestination(destination: ClosingIssueDestination) {
  switch (destination) {
    case 'accounts':
      return linkOptions({ to: '/configuracoes', search: { tab: 'contas' } })
    case 'imports':
      return linkOptions({ to: '/importar', search: { view: 'review' } })
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
    default:
      return linkOptions({
        to: '/transacoes',
        search: transactionSearchDefaults,
      })
  }
}
