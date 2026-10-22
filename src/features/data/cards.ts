import type {
  CardCycle,
  InstallmentPlan,
  ProviderCredit,
} from '@spendle/server/api'

type Cycle = typeof CardCycle.Type
type Plan = typeof InstallmentPlan.Type

export const cycleStatusCopy: Record<
  Cycle['status'],
  { label: string; tone: 'neutral' | 'success' | 'warning' | 'info' }
> = {
  open: { label: 'Aberta', tone: 'info' },
  due: { label: 'Fechada, a pagar', tone: 'warning' },
  paid: { label: 'Paga', tone: 'success' },
  partially_paid: { label: 'Paga em parte', tone: 'warning' },
  overdue: { label: 'Vencida', tone: 'warning' },
}

// Pending charges count: the bank posts them only when the bill comes due.
const unpaid = (cycle: Cycle) =>
  Math.max(0, cycle.projectedCents - cycle.paidCents)

/**
 * What a card owes and can still spend, from its cycles: the open bill,
 * what closed bills still owe, and the limit left after unpaid bills and the
 * instalments already scheduled for later bills. The limit the bank reports
 * through Open Finance wins over the configured one and the estimate.
 */
export function summarizeCard(input: {
  limitCents: number | null
  credit: ProviderCredit | null
  cycles: ReadonlyArray<Cycle>
  unappliedCents: number
  installments: ReadonlyArray<Plan>
}) {
  const open = input.cycles.findLast((cycle) => cycle.status === 'open') ?? null
  const owing = input.cycles.filter(
    (cycle) =>
      cycle.status === 'due' ||
      cycle.status === 'overdue' ||
      cycle.status === 'partially_paid',
  )
  const dueCents = owing.reduce((total, cycle) => total + unpaid(cycle), 0)
  const nextDue = owing.map((cycle) => cycle.dueOn).sort()[0] ?? null
  const scheduledCents = input.installments.reduce(
    (total, plan) => total + Math.abs(plan.remainingCents),
    0,
  )
  const usedCents = Math.max(
    0,
    dueCents +
      (open ? unpaid(open) : 0) +
      scheduledCents -
      input.unappliedCents,
  )
  const limitCents = input.credit?.limitCents ?? input.limitCents
  return {
    open,
    dueCents,
    nextDue,
    overdue: owing.some((cycle) => cycle.status === 'overdue'),
    scheduledCents,
    limitCents,
    availableLimitCents:
      input.credit?.availableCents ??
      (limitCents === null ? null : limitCents - usedCents),
    /** Issued statements the entries do not add up to. */
    statementGaps: input.cycles.filter(
      (cycle) =>
        cycle.statement !== null && cycle.statement.differenceCents !== 0,
    ),
  }
}
