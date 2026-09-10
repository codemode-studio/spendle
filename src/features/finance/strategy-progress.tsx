import { ShieldCheck, TrendingUp } from 'lucide-react'

import type { CommitmentBudget } from '#/domain/commitment-budget'
import type { FamilyMonth } from '#/domain/family-month'
import type { BucketAmounts } from '#/domain/strategy-progress'

export type StrategyDashboard = {
  currentMonth: string
  baseIncomeCents: number
  currentIncomeCents: number
  activeStrategy: { name: string }
  budgetTargets: BucketAmounts
  budgetActual: BucketAmounts
  budgetProjected: BucketAmounts
  monthlyCommitments?: CommitmentBudget
  familyMonth?: FamilyMonth
}

export function GoalRing({
  value,
  target,
  reserve,
}: {
  value: number
  target: number
  reserve: boolean
}) {
  const percent =
    target > 0 ? Math.min(100, Math.max(0, (value / target) * 100)) : 0
  const Icon = reserve ? ShieldCheck : TrendingUp
  return (
    <div
      className="relative size-12 shrink-0"
      role="img"
      aria-label={`${Math.round(percent)}% da meta de ${reserve ? 'reserva' : 'investimentos'}`}
    >
      <svg
        viewBox="0 0 48 48"
        className="size-full -rotate-90"
        aria-hidden="true"
      >
        <circle
          cx="24"
          cy="24"
          r="20"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          className="text-muted"
        />
        <circle
          cx="24"
          cy="24"
          r="20"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          pathLength="100"
          strokeDasharray={`${percent} 100`}
          opacity={percent > 0 ? 1 : 0}
          strokeLinecap="round"
          className="text-success"
        />
      </svg>
      <Icon
        aria-hidden="true"
        className="absolute top-3.5 left-3.5 size-5 text-muted-foreground"
      />
    </div>
  )
}
