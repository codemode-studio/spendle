import { useQuery } from '@tanstack/react-query'
import { Info } from 'lucide-react'

import { ProgressBar, StatusBadge } from '#/components/ui'
import { Skeleton } from '#/components/ui/skeleton'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '#/components/ui/tooltip'
import { formatCurrency, formatMonth } from '#/domain/finance'
import {
  buildStrategyProgress,
  bucketLabels,
  bucketStatusLabels,
} from '#/domain/strategy-progress'
import type {
  BucketAmounts,
  BucketStatus,
  StrategyBucketProgress,
} from '#/domain/strategy-progress'
import { cn } from '#/lib/utils'
import { strategyHistoryOptions } from './queries'

export type StrategyDashboard = {
  currentMonth: string
  baseIncomeCents: number
  currentIncomeCents: number
  activeStrategy: { name: string }
  budgetTargets: BucketAmounts
  budgetActual: BucketAmounts
  budgetProjected: BucketAmounts
}

const statusTone: Record<
  BucketStatus,
  'success' | 'warning' | 'danger' | 'info' | 'neutral'
> = {
  on_track: 'success',
  attention: 'warning',
  over: 'danger',
  done: 'success',
  behind: 'danger',
}

const overallLabel = {
  on_track: 'Dentro da estratégia',
  attention: 'Precisa de atenção',
  over: 'Estourou um envelope',
} as const

const overallTone = {
  on_track: 'success',
  attention: 'warning',
  over: 'danger',
} as const

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Metas da estratégia contra o realizado do mês, envelope a envelope.
 * O traço vertical em cada barra marca quanto do mês já passou: gasto à
 * esquerda dele está no ritmo, à direita está adiantado.
 */
export function StrategyProgressView({
  dashboard,
  today = todayIso(),
}: {
  dashboard: StrategyDashboard
  today?: string
}) {
  const progress = buildStrategyProgress({
    month: dashboard.currentMonth,
    today,
    baseIncomeCents: dashboard.baseIncomeCents,
    currentIncomeCents: dashboard.currentIncomeCents,
    targets: dashboard.budgetTargets,
    actual: dashboard.budgetActual,
    projected: dashboard.budgetProjected,
  })
  const spendingRatio =
    progress.spending.targetCents > 0
      ? progress.spending.actualCents / progress.spending.targetCents
      : 0

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <StatusBadge tone={overallTone[progress.overall]}>
          {overallLabel[progress.overall]}
        </StatusBadge>
        <span className="text-muted-foreground">
          <span className="font-medium text-foreground tabular-nums">
            {formatCurrency(progress.spending.actualCents)}
          </span>
          {' de '}
          <span className="tabular-nums">
            {formatCurrency(progress.spending.targetCents)}
          </span>
          {progress.spending.targetCents > 0 &&
            ` (${Math.round(spendingRatio * 100)}%)`}
          {progress.dayOfMonth !== null &&
            ` · dia ${progress.dayOfMonth} de ${progress.daysInMonth}`}
          {` · ${dashboard.activeStrategy.name}`}
        </span>
        <Tooltip>
          <TooltipTrigger
            aria-label="Como este acompanhamento é calculado"
            className="inline-flex size-4 items-center justify-center rounded-full text-muted-foreground/70 hover:text-foreground pointer-coarse:size-6"
          >
            <Info className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent className="max-w-72 text-xs leading-snug">
            Metas calculadas sobre a base de{' '}
            {formatCurrency(progress.income.baseCents)}. Renda confirmada no
            mês: {formatCurrency(progress.income.actualCents)}. O traço em cada
            barra marca o ponto do mês em que estamos; gasto à direita dele está
            adiantado.
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2 xl:grid-cols-4">
        {progress.buckets.map((item) => (
          <BucketRow key={item.bucket} item={item} elapsed={progress.elapsed} />
        ))}
      </div>
    </div>
  )
}

function BucketRow({
  item,
  elapsed,
}: {
  item: StrategyBucketProgress
  elapsed: number
}) {
  const detail =
    item.kind === 'spending'
      ? item.remainingCents >= 0
        ? item.projectedCents > item.actualCents
          ? `Sobram ${formatCurrency(item.remainingCents)} · previsão ${formatCurrency(item.projectedCents)}`
          : `Sobram ${formatCurrency(item.remainingCents)}`
        : `Passou ${formatCurrency(-item.remainingCents)}`
      : item.status === 'done'
        ? item.targetCents > 0
          ? 'Aporte feito'
          : 'Sem meta'
        : `Faltam ${formatCurrency(item.remainingCents)}`
  const projectedShare =
    item.kind === 'spending' && item.targetCents > 0
      ? Math.min(1, item.projectedCents / item.targetCents)
      : 0
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <span className="flex items-center gap-2 text-sm">
          <span className="font-medium">{item.label}</span>
          {item.status !== 'on_track' && (
            <StatusBadge tone={statusTone[item.status]}>
              {bucketStatusLabels[item.status]}
            </StatusBadge>
          )}
        </span>
        <span className="shrink-0 text-sm tabular-nums">
          <span className="font-medium">
            {formatCurrency(item.actualCents)}
          </span>
          <span className="text-muted-foreground">
            {' '}
            de {formatCurrency(item.targetCents)}
          </span>
        </span>
      </div>
      <div className="relative mt-2">
        {projectedShare > 0 && (
          <span
            aria-hidden="true"
            className="absolute top-1/2 left-0 h-1 -translate-y-1/2 rounded-full bg-foreground/15"
            style={{ width: `${projectedShare * 100}%` }}
          />
        )}
        <ProgressBar
          value={item.actualCents}
          max={item.targetCents}
          className={cn(
            'relative',
            item.status === 'over' || item.status === 'behind'
              ? '[&_[data-slot=progress-indicator]]:bg-destructive'
              : item.status === 'attention'
                ? '[&_[data-slot=progress-indicator]]:bg-warning'
                : item.status === 'done'
                  ? '[&_[data-slot=progress-indicator]]:bg-success'
                  : undefined,
            '[&_[data-slot=progress-track]]:bg-transparent',
          )}
        />
        <span
          aria-hidden="true"
          className="absolute inset-x-0 top-1/2 -z-10 h-1 -translate-y-1/2 rounded-full bg-muted"
        />
        {item.kind === 'spending' && elapsed > 0 && elapsed < 1 && (
          <span
            aria-hidden="true"
            className="absolute top-1/2 h-2.5 w-px -translate-y-1/2 bg-foreground/50"
            style={{ left: `${elapsed * 100}%` }}
          />
        )}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </div>
  )
}

/** Últimos meses: realizado contra a meta de cada envelope. */
export function StrategyHistory({ months = 3 }: { months?: number }) {
  const history = useQuery(strategyHistoryOptions(months))
  if (history.isPending) {
    return <Skeleton className="h-24 w-full" />
  }
  const rows = (history.data ?? []).filter((item) => item.hasData)
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Ainda não há meses anteriores com lançamentos para comparar.
      </p>
    )
  }
  const buckets = ['essential', 'lifestyle', 'investment', 'reserve'] as const
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-xs font-medium text-muted-foreground">
            <th className="pb-2 text-left font-medium">Mês</th>
            <th className="pb-2 text-right font-medium">Renda</th>
            {buckets.map((bucket) => (
              <th key={bucket} className="pb-2 text-right font-medium">
                {bucketLabels[bucket]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.month} className="border-b last:border-b-0">
              <td className="py-2.5">
                <span className="font-medium">{formatMonth(row.month)}</span>
                <span className="block text-xs text-muted-foreground">
                  {row.strategyName}
                  {row.closed ? ' · fechado' : ''}
                </span>
              </td>
              <td className="py-2.5 text-right tabular-nums">
                {formatCurrency(row.incomeCents)}
              </td>
              {buckets.map((bucket) => {
                const actual = row.actual[bucket]
                const target = row.targets[bucket]
                const spending =
                  bucket === 'essential' || bucket === 'lifestyle'
                const bad = spending ? actual > target : actual < target
                return (
                  <td key={bucket} className="py-2.5 text-right tabular-nums">
                    <span
                      className={cn(
                        'font-medium',
                        bad ? 'text-destructive' : 'text-success',
                      )}
                    >
                      {formatCurrency(actual)}
                    </span>
                    <span
                      className="block text-xs text-muted-foreground"
                      title={`Meta ${formatCurrency(target)}`}
                    >
                      {target > 0
                        ? `${Math.round((actual / target) * 100)}% da meta`
                        : 'sem meta'}
                    </span>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
