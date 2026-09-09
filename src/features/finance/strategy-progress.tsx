import type { CommitmentBudget } from '#/domain/commitment-budget'
import type { FamilyMonth } from '#/domain/family-month'
import { useQuery } from '@tanstack/react-query'
import {
  CircleCheck,
  CircleHelp,
  CircleX,
  Info,
  ShieldCheck,
  TrendingUp,
  TriangleAlert,
} from 'lucide-react'

import { financialHealth } from '#/domain/financial-health'
import { ProgressBar } from '#/components/ui'
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
  familyMonth?: FamilyMonth
}

const overallLabel = {
  on_track: 'Dentro da estratégia',
  attention: 'Precisa de atenção',
  over: 'Estourou um envelope',
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
  cashCents,
  detailed = false,
}: {
  dashboard: StrategyDashboard
  today?: string
  cashCents?: number
  detailed?: boolean
}) {
  const budget = dashboard.monthlyCommitments
  return (
    <div className="flex flex-col gap-6">
      {budget ? (
        <CommitmentOverview
          budget={budget}
          cashCents={cashCents}
          month={dashboard.familyMonth}
          actual={dashboard.budgetActual}
        />
      ) : (
        <p>Orçamento indisponível.</p>
      )}
      {detailed && (
        <>
          <section className="border-t pt-6">
            <h2 className="mb-4 text-lg font-semibold">
              Composição do orçamento
            </h2>
            {budget && <CommitmentProgress budget={budget} />}
          </section>
          <section className="border-t pt-6">
            <h2 className="mb-4 text-lg font-semibold">
              Compras de {formatMonth(dashboard.currentMonth)}
            </h2>
            <ConsumptionProgressView dashboard={dashboard} today={today} />
          </section>
        </>
      )}
    </div>
  )
}

function CommitmentOverview({
  budget,
  cashCents,
  month,
  actual,
}: {
  budget: CommitmentBudget
  cashCents?: number
  month?: FamilyMonth
  actual: BucketAmounts
}) {
  const flow = month?.cashFlow
  const legacyHealth = financialHealth(budget)
  const health = month
    ? {
        deficit: flow
          ? (flow.closingCashCents ?? 0) < 0
          : month.plannedBalanceCents < 0,
        incomplete:
          (flow ? flow.cashCents === null : month.plannedIncomeCents <= 0) ||
          !month.hasData ||
          month.warnings.length > 0,
        spendingOver: month.expenses.filter(
          (b) => b.targetCents !== null && b.cents > b.targetCents,
        ),
        label: flow
          ? flow.cashCents === null
            ? 'Saldo não disponível para esta data'
            : `${formatCurrency(flow.cashCents)} em caixa + ${formatCurrency(flow.expectedIncomeCents)} a entrar − ${formatCurrency(flow.remainingExpenseCents)} a pagar`
          : month.forecasting
            ? `Renda base ${formatCurrency(month.plannedIncomeCents)} − despesas previstas ${formatCurrency(month.expenseCents)}`
            : `Renda confirmada ${formatCurrency(month.incomeCents)} − despesas registradas ${formatCurrency(month.expenseCents)}`,
      }
    : legacyHealth
  const needsAttention =
    health.spendingOver.length > 0 ||
    (month !== undefined &&
      (flow?.afterGoalsCents ?? month.balanceAfterGoalsCents) < 0)
  const HealthIcon = health.deficit
    ? CircleX
    : health.incomplete
      ? CircleHelp
      : needsAttention
        ? TriangleAlert
        : CircleCheck
  const headline = health.deficit
    ? 'Precisamos ajustar o caixa'
    : flow
      ? flow.cashCents === null
        ? 'Saldo não disponível'
        : (flow.afterGoalsCents ?? 0) < 0
          ? 'As metas precisam de ajuste'
          : 'O mês deve terminar com saldo'
      : health.incomplete
        ? 'Projeção a conferir'
        : month && month.balanceAfterGoalsCents < 0
          ? 'As metas precisam de ajuste'
          : month
            ? month.forecasting
              ? 'O mês deve terminar com saldo'
              : 'Caixa registrado no fim do mês'
            : health.spendingOver.length > 0
              ? 'Vamos cuidar dos gastos'
              : 'Estamos no caminho'
  const spending = month
    ? month.expenses
        .filter((b) => b.bucket !== 'other')
        .map((b) => ({
          ...b,
          committedCents: b.cents,
          targetCents: b.targetCents ?? 0,
          remainingCents: (b.targetCents ?? 0) - b.cents,
        }))
    : budget.buckets.filter(
        (b) => b.bucket === 'essential' || b.bucket === 'lifestyle',
      )
  const goals = budget.buckets
    .filter((b) => b.bucket === 'investment' || b.bucket === 'reserve')
    .map((b) => ({
      ...b,
      paidCents: month
        ? actual[b.bucket as 'investment' | 'reserve']
        : b.paidCents,
    }))
  const other = month?.expenses.find((b) => b.bucket === 'other')?.cents ?? 0
  const balance =
    flow?.cashCents ??
    month?.plannedBalanceCents ??
    budget.remainingAfterGoalsCents
  return (
    <div className="flex flex-col gap-6">
      <div className="grid items-center gap-6 border-b pb-6 lg:grid-cols-[1.4fr_1fr]">
        <div className="flex items-start gap-4">
          <HealthIcon
            aria-hidden="true"
            strokeWidth={1.5}
            className={cn(
              'mt-1 size-9 shrink-0 sm:size-16',
              health.deficit
                ? 'text-destructive'
                : health.incomplete
                  ? 'text-muted-foreground'
                  : needsAttention
                    ? 'text-warning'
                    : 'text-success',
            )}
          />
          <div>
            <h2 className="text-xl font-medium tracking-tight sm:text-3xl">
              {headline}
            </h2>
            {(month ||
              !health.incomplete ||
              health.deficit ||
              health.spendingOver.length > 0) && (
              <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
                {health.label}.
              </p>
            )}
          </div>
        </div>
        <div className="flex flex-col gap-2 lg:border-l lg:pl-6">
          <p className="text-xs text-muted-foreground">
            {flow
              ? 'Caixa'
              : health.deficit
                ? 'Falta para cobrir o mês'
                : 'Margem estimada após as metas'}
          </p>
          <p
            className={cn(
              'text-3xl font-medium tracking-tight tabular-nums sm:text-4xl',
              (flow ? (flow.cashCents ?? 0) < 0 : health.deficit) &&
                'text-destructive',
            )}
          >
            {flow
              ? flow.cashCents === null
                ? 'Sem saldo registrado'
                : formatCurrency(flow.cashCents)
              : formatCurrency(Math.abs(balance))}
          </p>
          {flow ? (
            <p className="text-xs leading-relaxed text-muted-foreground">
              Previsto no fim do mês:{' '}
              {flow.closingCashCents === null
                ? 'indisponível'
                : formatCurrency(flow.closingCashCents)}
            </p>
          ) : (
            cashCents !== undefined && (
              <p className="text-xs leading-relaxed text-muted-foreground">
                Caixa {formatCurrency(cashCents)}
              </p>
            )
          )}
        </div>
      </div>
      <div className="grid gap-6 md:grid-cols-2">
        <div className="flex flex-col gap-5">
          <div>
            <h3 className="text-sm font-semibold">
              {month && !month.forecasting
                ? 'Despesas registradas'
                : 'Despesas do mês'}
            </h3>
            {month && (
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {formatCurrency(month.knownExpenseCents)} em contas e compras
                {month.estimatedExpenseCents !== 0 &&
                  ` + ${formatCurrency(month.estimatedExpenseCents)} em estimativas`}
                .
              </p>
            )}
          </div>
          {spending.map((b) => (
            <div key={b.bucket} className="flex flex-col gap-2">
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span>
                  {bucketLabels[b.bucket as keyof typeof bucketLabels]}
                </span>
                <strong className="tabular-nums">
                  {formatCurrency(b.committedCents)}
                </strong>
              </div>
              <ProgressBar
                value={b.committedCents}
                max={b.targetCents}
                className={cn(
                  b.remainingCents < 0 &&
                    '[&_[data-slot=progress-indicator]]:bg-destructive',
                )}
              />
              <div className="flex flex-wrap justify-between gap-1 text-xs">
                <span className="text-muted-foreground">
                  Limite {formatCurrency(b.targetCents)}
                </span>
                <span
                  className={cn(
                    'font-medium',
                    b.remainingCents < 0
                      ? 'text-destructive'
                      : 'text-muted-foreground',
                  )}
                >
                  {formatCurrency(Math.abs(b.remainingCents))}{' '}
                  {b.remainingCents < 0 ? 'acima' : 'restantes'}
                </span>
              </div>
            </div>
          ))}
          {other !== 0 && (
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span>Outras despesas</span>
              <strong className="tabular-nums">{formatCurrency(other)}</strong>
            </div>
          )}
        </div>
        <div className="flex flex-col gap-5">
          <div>
            <h3 className="text-sm font-semibold">Metas de aporte</h3>
          </div>
          {goals.map((b) => (
            <div key={b.bucket} className="flex flex-col gap-2">
              <div className="flex items-center gap-3">
                <GoalRing
                  value={b.paidCents}
                  target={b.targetCents}
                  reserve={b.bucket === 'reserve'}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                    <span>
                      {bucketLabels[b.bucket as keyof typeof bucketLabels]}
                    </span>
                    <strong className="tabular-nums">
                      {formatCurrency(b.paidCents)}
                    </strong>
                  </div>
                  <div className="mt-1 flex flex-wrap justify-between gap-1 text-xs text-muted-foreground">
                    <span>
                      {b.targetCents <= 0
                        ? 'Sem meta'
                        : `Meta ${formatCurrency(b.targetCents)}`}
                    </span>
                    <span>
                      {b.targetCents > 0 && b.paidCents >= b.targetCents
                        ? 'Concluída'
                        : 'Aportado'}
                    </span>
                  </div>
                </div>
              </div>
              {(month
                ? b.targetCents > b.paidCents
                : b.dueCents + b.variableCents > 0) && (
                <p className="text-xs text-muted-foreground">
                  Falta guardar:{' '}
                  {formatCurrency(
                    month
                      ? Math.max(0, b.targetCents - b.paidCents)
                      : b.dueCents + b.variableCents,
                  )}
                </p>
              )}
            </div>
          ))}
          {month && (!flow || flow.afterGoalsCents !== null) && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {(flow?.afterGoalsCents ?? month.balanceAfterGoalsCents) < 0
                ? `Para pagar as despesas e cumprir as metas, faltam ${formatCurrency(-(flow?.afterGoalsCents ?? month.balanceAfterGoalsCents))}.`
                : `Depois das despesas e das metas, ${month.forecasting ? 'devem sobrar' : 'sobram'} ${formatCurrency(flow?.afterGoalsCents ?? month.balanceAfterGoalsCents)}.`}
            </p>
          )}
        </div>
      </div>
    </div>
  )
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
        <section className="rounded-lg border border-warning/30 p-3 text-sm">
          <h3 className="font-medium">Limites desta estimativa</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
            {budget.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </section>
      )}
      <section className="border-t pt-4">
        <h3 className="text-sm font-medium">Parcelamentos fixos temporários</h3>
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
      </section>
      <section className="border-t pt-4">
        <h3 className="text-sm font-medium">
          Conferir composição ({budget.lines.length} itens)
        </h3>
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
      </section>
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
        <span className="font-medium">{overallLabel[progress.overall]}</span>
        <span className="text-muted-foreground">
          {progress.dayOfMonth !== null &&
            `Dia ${progress.dayOfMonth} de ${progress.daysInMonth} · `}
          {'Gastos '}
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
        <span className="text-right text-xs text-muted-foreground">
          {bucketStatusLabels[item.status]}
        </span>
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
                  {row.closed ? 'Fechado' : ''}
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
