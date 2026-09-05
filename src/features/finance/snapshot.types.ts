import type {
  getFinanceSnapshotFn,
  getPlanningSnapshotFn,
} from './finance.functions'

export type FinanceSnapshot = Awaited<ReturnType<typeof getFinanceSnapshotFn>>
export type AccountSnapshot = FinanceSnapshot['accounts'][number]
export type CardSnapshot = FinanceSnapshot['cards'][number]
export type TransactionSnapshot = FinanceSnapshot['transactions'][number]
export type RecurrenceSnapshot = FinanceSnapshot['recurrences'][number]
export type DashboardSnapshot = FinanceSnapshot['dashboard']

export type PlanningSnapshot = Awaited<ReturnType<typeof getPlanningSnapshotFn>>
