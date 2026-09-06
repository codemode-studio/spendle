import { useState } from 'react'
import { SegmentedControl } from '#/components/segmented-control'
import type { CommitmentBudget } from '#/domain/commitment-budget'
import { useQuery } from '@tanstack/react-query'
import { Info } from 'lucide-react'

import { StatusBadge } from '#/components/ui'
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
  monthlyCommitments?: CommitmentBudget
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
  const [view, setView] = useState('commitments')
  const budget = dashboard.monthlyCommitments
  return (
    <div className="space-y-4">
      <SegmentedControl
        aria-label="Visão da estratégia"
        value={view}
        onValueChange={setView}
        items={[
          { value: 'commitments', label: 'Compromissos do mês' },
          { value: 'consumption', label: 'Consumo por mês' },
        ]}
      />
      {view === 'consumption' ? (
        <>
          <p className="text-sm text-muted-foreground">
            Compras pelas datas dos lançamentos em{' '}
            {formatMonth(dashboard.currentMonth)}. O pagamento de uma fatura não
            conta como uma nova compra. Cobertura parcial pode reduzir os
            valores observados.
          </p>
          <ConsumptionProgressView dashboard={dashboard} today={today} />
          <details>
            <summary className="cursor-pointer text-sm">
              Ver meses anteriores
            </summary>
            <div className="mt-3">
              <StrategyHistory />
            </div>
          </details>
        </>
      ) : budget ? (
        <CommitmentProgress budget={budget} />
      ) : (
        <p>Os compromissos ainda não foram carregados.</p>
      )}
    </div>
  )
}

function CommitmentProgress({ budget }: { budget: CommitmentBudget }) {
  const names = { ...bucketLabels, other: 'Fora dos envelopes / a classificar' }
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Despesas pagas e compromissos com vencimento em{' '}
        {formatMonth(budget.month)}. A pagar inclui faturas, parcelas e
        recorrências estimadas. Variáveis representam somente o restante da
        estimativa após os valores já conhecidos.
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <p className="text-xs text-muted-foreground">
            Base de renda estimada
          </p>
          <p className="text-xl font-semibold tabular-nums">
            {formatCurrency(budget.incomeCents)}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">
            Comprometido, incluindo estimativas
          </p>
          <p className="text-xl font-semibold tabular-nums">
            {formatCurrency(budget.committedCents)}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">
            Margem estimada da renda
          </p>
          <p
            className={cn(
              'text-xl font-semibold tabular-nums',
              budget.remainingCents < 0 && 'text-destructive',
            )}
          >
            {formatCurrency(budget.remainingCents)}
          </p>
        </div>
      </div>
      <p className="text-sm">
        <strong>
          Margem após as metas de investimento e reserva:{' '}
          {formatCurrency(budget.remainingAfterGoalsCents)}
        </strong>
        <span className="block text-xs text-muted-foreground">
          Inclui {formatCurrency(budget.unfundedGoalsCents)} de metas de aporte
          ainda não realizadas.
        </span>
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[650px] text-sm">
          <thead>
            <tr className="border-b text-muted-foreground">
              {[
                'Grupo',
                'Pago',
                'A pagar',
                'Variável estimado',
                'Meta',
                'Margem',
              ].map((h) => (
                <th key={h} className="px-2 py-2 text-right first:text-left">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {budget.buckets.map((b) => (
              <tr key={b.bucket} className="border-b last:border-0">
                <th className="py-3 pr-3 text-left font-medium">
                  {names[b.bucket]}
                </th>
                <td className="px-2 text-right tabular-nums">
                  {formatCurrency(b.paidCents)}
                </td>
                <td className="px-2 text-right tabular-nums">
                  {formatCurrency(b.dueCents)}
                </td>
                <td className="px-2 text-right tabular-nums">
                  {formatCurrency(b.variableCents)}
                </td>
                <td className="px-2 text-right tabular-nums">
                  {b.bucket === 'other' ? '—' : formatCurrency(b.targetCents)}
                </td>
                <td
                  className={cn(
                    'px-2 text-right tabular-nums',
                    b.bucket !== 'other' &&
                      b.remainingCents < 0 &&
                      'text-destructive',
                  )}
                >
                  {b.bucket === 'other'
                    ? '—'
                    : formatCurrency(b.remainingCents)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        A margem não é saldo bancário nem dinheiro garantido para gastar. Metas
        de investimento e reserva ainda não realizadas continuam como objetivos;
        compromissos dessas categorias entram apenas quando observados.
      </p>
      {budget.warnings.length > 0 && (
        <details
          open
          className="rounded-lg border border-warning/30 p-3 text-sm"
        >
          <summary className="cursor-pointer font-medium">
            Limites desta estimativa
          </summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
            {budget.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </details>
      )}
      <details>
        <summary className="cursor-pointer text-sm font-medium">
          Parcelamentos fixos temporários
        </summary>
        <ul className="mt-3 space-y-2 text-sm">
          {budget.lines
            .filter((l) => l.temporaryUntil)
            .map((l) => (
              <li key={l.id}>
                {l.description} · {formatCurrency(l.cents)} · parcela{' '}
                {l.installment} · termina em{' '}
                {formatMonth(l.temporaryUntil!.slice(0, 7))}
              </li>
            ))}
          {!budget.lines.some((l) => l.temporaryUntil) && (
            <li>
              Nenhum parcelamento temporário identificado neste vencimento.
            </li>
          )}
        </ul>
      </details>
      <details>
        <summary className="cursor-pointer text-sm font-medium">
          Conferir composição ({budget.lines.length} itens)
        </summary>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[620px] text-sm">
            <thead>
              <tr className="border-b">
                <th className="p-2 text-left">Data</th>
                <th className="p-2 text-left">Descrição / grupo</th>
                <th className="p-2 text-right">Compromisso</th>
                <th className="p-2 text-left">Base</th>
              </tr>
            </thead>
            <tbody>
              {budget.lines.map((l) => (
                <tr key={l.id} className="border-b">
                  <td className="p-2">
                    {l.date.split('-').reverse().join('/')}
                  </td>
                  <td className="p-2">
                    {l.description}
                    <span className="block text-xs text-muted-foreground">
                      {names[l.bucket]}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {l.transactionId
                        ? 'Lançamento ' + l.transactionId
                        : l.importId
                          ? 'Documento ' + l.importId
                          : ''}
                    </span>
                  </td>
                  <td className="p-2 text-right tabular-nums">
                    {formatCurrency(l.cents)}
                  </td>
                  <td className="p-2">
                    {l.certainty === 'estimated'
                      ? 'Estimativa'
                      : l.certainty === 'scheduled'
                        ? 'Parcela programada'
                        : 'Documentado'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  )
}

function ConsumptionProgressView({
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
          {progress.dayOfMonth !== null &&
            `Dia ${progress.dayOfMonth} de ${progress.daysInMonth} · `}
          {dashboard.activeStrategy.name}
          {' · gastos '}
          <span className="font-medium text-foreground tabular-nums">
            {formatCurrency(progress.spending.actualCents)}
          </span>
          {progress.spending.targetCents > 0 &&
            ` (${Math.round(spendingRatio * 100)}% de ${formatCurrency(progress.spending.targetCents)})`}
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
      <div className="@container">
        <div className="grid @md:grid-cols-2 @3xl:grid-cols-4">
          {progress.buckets.map((item, index) => (
            <BucketRow
              key={item.bucket}
              item={item}
              index={index}
              elapsed={progress.elapsed}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

// Posição na grade: 2 colunas a partir de @md, 4 a partir de @3xl. As bordas
// e o recuo lateral seguem a posição, sem depender de seletores nth-child.
const bucketCellClasses = [
  '@md:border-r @md:pr-5',
  '@md:pl-5 @3xl:border-r @3xl:pr-5',
  '@md:border-r @md:pr-5 @3xl:pl-5',
  '@md:pl-5',
]

function BucketRow({
  item,
  index,
  elapsed,
}: {
  item: StrategyBucketProgress
  index: number
  elapsed: number
}) {
  const percent =
    item.targetCents > 0
      ? Math.round((item.actualCents / item.targetCents) * 100)
      : null
  const fillShare = Math.min(1, item.ratio)
  const projectedShare =
    item.kind === 'spending' && item.targetCents > 0
      ? Math.min(1, item.projectedCents / item.targetCents)
      : 0
  const fillColor =
    item.status === 'over' || item.status === 'behind'
      ? 'bg-destructive'
      : item.status === 'attention'
        ? 'bg-warning'
        : item.status === 'done'
          ? 'bg-success'
          : 'bg-primary'
  const headline =
    item.kind === 'spending'
      ? item.remainingCents >= 0
        ? `Sobram ${formatCurrency(item.remainingCents)}`
        : `Passou ${formatCurrency(-item.remainingCents)}`
      : item.status === 'done'
        ? item.targetCents > 0
          ? 'Aporte do mês feito'
          : 'Sem meta neste mês'
        : `Faltam ${formatCurrency(item.remainingCents)}`
  const projection =
    item.kind === 'spending' && item.projectedCents > item.actualCents
      ? `Registrado + recorrências: ${formatCurrency(item.projectedCents)}`
      : null

  return (
    <div
      className={cn(
        'flex min-w-0 flex-col border-b py-4 last:border-b-0 @md:border-b-0 @md:py-1',
        bucketCellClasses[index] ?? '',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 text-sm font-medium">{item.label}</span>
        <StatusBadge className="shrink-0" tone={statusTone[item.status]}>
          {bucketStatusLabels[item.status]}
        </StatusBadge>
      </div>
      <p className="mt-2 text-xl font-semibold tracking-tight tabular-nums">
        {formatCurrency(item.actualCents)}
      </p>
      <p className="text-xs text-muted-foreground tabular-nums">
        de {formatCurrency(item.targetCents)}
        {percent !== null && ` · ${percent}%`}
      </p>
      <div className="relative mt-3 h-3">
        <div
          role="progressbar"
          aria-label={`${item.label}: ${percent ?? 0}% da meta`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.min(100, Math.max(0, percent ?? 0))}
          className="absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 overflow-hidden rounded-full bg-muted"
        >
          {projectedShare > fillShare && (
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-foreground/15"
              style={{ width: `${projectedShare * 100}%` }}
            />
          )}
          <div
            className={cn('absolute inset-y-0 left-0 rounded-full', fillColor)}
            style={{ width: `${fillShare * 100}%` }}
          />
        </div>
        {item.kind === 'spending' && elapsed > 0 && elapsed < 1 && (
          <span
            aria-hidden="true"
            title="Ponto do mês em que estamos"
            className="absolute inset-y-0 w-0.5 rounded-full bg-foreground/60"
            style={{ left: `calc(${elapsed * 100}% - 1px)` }}
          />
        )}
      </div>
      <p className="mt-3 text-sm">{headline}</p>
      {projection && (
        <p className="text-xs text-muted-foreground">{projection}</p>
      )}
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
