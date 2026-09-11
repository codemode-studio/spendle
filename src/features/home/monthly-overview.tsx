import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react'

import { EmptyState, Panel, ProgressBar } from '#/components/ui'
import { Button } from '#/components/ui/button'
import { Skeleton } from '#/components/ui/skeleton'
import { formatCurrency, formatMonth } from '#/domain/finance'
import { bucketLabels } from '#/domain/strategy-progress'
import { strategyHistoryOptions } from '#/features/finance/queries'
import { GoalRing } from '#/features/finance/strategy-progress'
import type { StrategyDashboard } from '#/features/finance/strategy-progress'
import { cn } from '#/lib/utils'
import { MonthlyAssistant } from './monthly-assistant'

const expenseBuckets = ['essential', 'lifestyle'] as const

export function MonthlyOverview({
  dashboard,
  currentClosed = false,
  assistantConfigured = false,
}: {
  dashboard: StrategyDashboard
  currentClosed?: boolean
  assistantConfigured?: boolean
}) {
  const history = useQuery(strategyHistoryOptions(11))
  const [selectedMonth, setSelectedMonth] = useState(dashboard.currentMonth)
  const current = {
    month: dashboard.currentMonth,
    incomeCents: dashboard.currentIncomeCents,
    targets: dashboard.budgetTargets,
    actual: dashboard.budgetActual,
    closed: currentClosed,
    familyMonth: dashboard.familyMonth,
    hasData:
      dashboard.currentIncomeCents !== 0 ||
      Object.values(dashboard.budgetActual).some((value) => value !== 0),
  }
  const months = [...[...(history.data ?? [])].reverse(), current].map(
    (item) => {
      const family = item.familyMonth
      return {
        ...item,
        hasData: family?.hasData ?? item.hasData,
        spending:
          family?.expenseCents ?? item.actual.essential + item.actual.lifestyle,
        chartCents: family?.cashFlow
          ? family.cashFlow.closingCashCents
          : (family?.expenseCents ??
            item.actual.essential + item.actual.lifestyle),
        incomeCents: family?.plannedIncomeCents ?? item.incomeCents,
        actual: {
          ...item.actual,
          essential:
            family?.expenses.find((b) => b.bucket === 'essential')?.cents ??
            item.actual.essential,
          lifestyle:
            family?.expenses.find((b) => b.bucket === 'lifestyle')?.cents ??
            item.actual.lifestyle,
        },
        other: family?.expenses.find((b) => b.bucket === 'other')?.cents ?? 0,
      }
    },
  )
  const selected =
    months.find((month) => month.month === selectedMonth) ??
    months[months.length - 1]
  const selectedIndex = months.indexOf(selected)
  const maxSpending = Math.max(
    1,
    ...months.flatMap((month) => [
      Math.abs(month.chartCents ?? 0),
      month.familyMonth?.cashFlow?.receivedCents ?? 0,
      month.familyMonth?.cashFlow?.paidCents ?? 0,
    ]),
  )
  const belowZero = Math.max(
    0,
    ...months.map((month) => -(month.chartCents ?? 0)),
  )
  const chartRange = maxSpending + belowZero
  const zeroPosition = (belowZero / chartRange) * 100
  const spending = selected.spending
  const contributions =
    selected.familyMonth?.savedCents ??
    selected.actual.investment + selected.actual.reserve

  const overspending = expenseBuckets.reduce(
    (sum, bucket) =>
      sum + Math.max(0, selected.actual[bucket] - selected.targets[bucket]),
    0,
  )
  const flow = selected.familyMonth?.cashFlow

  return (
    <Panel
      className="monthly-overview"
      title="Mês a mês"
      action={
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Mês anterior"
            disabled={
              selectedIndex <= 0 || history.isPending || history.isError
            }
            onClick={() => setSelectedMonth(months[selectedIndex - 1].month)}
          >
            <ChevronLeft />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Próximo mês"
            disabled={
              selectedIndex >= months.length - 1 ||
              history.isPending ||
              history.isError
            }
            onClick={() => setSelectedMonth(months[selectedIndex + 1].month)}
          >
            <ChevronRight />
          </Button>
        </div>
      }
    >
      {history.isPending ? (
        <Skeleton className="h-64" aria-label="Carregando histórico mensal" />
      ) : history.isError ? (
        <EmptyState
          icon={CalendarDays}
          title="Não foi possível carregar os meses"
          description="Tente novamente para comparar o histórico."
          action={
            <Button variant="outline" onClick={() => void history.refetch()}>
              Tentar novamente
            </Button>
          }
        />
      ) : (
        <div className="@container flex flex-col gap-6">
          <div
            role="group"
            aria-label="Selecionar mês"
            className="grid grid-cols-4 gap-2 @min-[304px]:grid-cols-6 @min-[656px]:grid-cols-12"
          >
            {months.map((month) => {
              const amount = month.chartCents ?? 0
              const cashChart = Boolean(month.familyMonth?.cashFlow)
              const hasChartData = cashChart
                ? month.chartCents !== null && month.hasData
                : month.hasData
              const over = expenseBuckets.some(
                (bucket) => month.actual[bucket] > month.targets[bucket],
              )
              const series = cashChart
                ? [
                    {
                      value: month.familyMonth!.cashFlow!.receivedCents,
                      color: 'bg-emerald-600',
                    },
                    {
                      value: month.familyMonth!.cashFlow!.paidCents,
                      color: 'bg-amber-600',
                    },
                    {
                      value: amount,
                      color: amount < 0 ? 'bg-destructive' : 'bg-primary/70',
                    },
                  ]
                : [
                    {
                      value: amount,
                      color: over ? 'bg-destructive' : 'bg-primary/70',
                    },
                  ]
              return (
                <button
                  key={month.month}
                  type="button"
                  aria-pressed={selected.month === month.month}
                  aria-label={`${formatMonth(month.month)}: ${hasChartData ? (cashChart ? `caixa ${month.familyMonth?.forecasting ? 'previsto' : 'registrado'} ${formatCurrency(amount)}` : `${formatCurrency(amount)} em despesas registradas`) : 'sem valores para comparar'}${month.hasData && over ? '; gastos acima dos limites' : ''}`}
                  onClick={() => setSelectedMonth(month.month)}
                  className={cn(
                    'flex min-w-0 flex-col items-center gap-2 rounded-lg border px-2 py-3 outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring',
                    selected.month === month.month
                      ? 'border-foreground/30 bg-muted'
                      : 'border-transparent',
                  )}
                >
                  <span
                    className="relative flex h-16 w-full items-end justify-center sm:h-24"
                    aria-hidden="true"
                  >
                    {hasChartData ? (
                      <span className="relative flex h-full w-full justify-center gap-1">
                        <span
                          className="absolute w-full border-t"
                          style={{ bottom: `${zeroPosition}%` }}
                        />
                        {series.map((bar, index) => (
                          <span
                            key={index}
                            className={cn(
                              'absolute rounded-sm',
                              bar.color,
                              index === 2 &&
                                month.familyMonth?.forecasting &&
                                'opacity-50',
                            )}
                            style={{
                              width: `${80 / series.length}%`,
                              left: `${(index / series.length) * 100}%`,
                              height: `${(Math.abs(bar.value) / chartRange) * 100}%`,
                              ...(bar.value < 0
                                ? { top: `${100 - zeroPosition}%` }
                                : { bottom: `${zeroPosition}%` }),
                            }}
                          />
                        ))}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </span>
                  <span className="text-xs font-medium">
                    {formatMonth(month.month).split(' ')[0].slice(0, 3)}
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    {month.month.slice(0, 4)}
                  </span>
                  <span
                    className={cn(
                      'h-1 w-5 rounded-full',
                      month.hasData && over
                        ? 'bg-destructive'
                        : 'bg-transparent',
                    )}
                    aria-hidden="true"
                  />
                </button>
              )
            })}
          </div>
          {dashboard.familyMonth?.cashFlow && (
            <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-2">
                <span className="size-2 rounded-sm bg-emerald-600" />
                Entradas recebidas
              </span>
              <span className="flex items-center gap-2">
                <span className="size-2 rounded-sm bg-amber-600" />
                Saídas pagas
              </span>
              <span className="flex items-center gap-2">
                <span className="size-2 rounded-sm bg-primary/70" />
                Caixa final
              </span>
              <span className="flex items-center gap-2">
                <span className="h-1 w-3 rounded-full bg-destructive" />
                Gastos acima dos limites
              </span>
            </div>
          )}
          <div
            aria-live="polite"
            aria-atomic="true"
            className="flex flex-col gap-5 border-t pt-5"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-lg font-medium tracking-tight">
                {formatMonth(selected.month)}
              </h3>
              <span className="text-xs text-muted-foreground">
                {selected.closed
                  ? 'Orçamento fechado'
                  : selected.month === current.month
                    ? 'Em andamento'
                    : 'Orçamento aberto'}
              </span>
            </div>
            {!selected.hasData ? (
              <EmptyState
                icon={CalendarDays}
                title="Sem valores para comparar"
                description="Nenhum valor classificado neste período."
              />
            ) : (
              <>
                {overspending > 0 && (
                  <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3">
                    <p className="text-sm font-medium text-destructive">
                      Gastos{' '}
                      {selected.familyMonth?.forecasting ? 'previstos ' : ''}
                      acima dos limites
                    </p>
                    <p className="mt-1 text-sm">
                      {formatCurrency(overspending)} de excesso em essenciais e
                      estilo de vida, somando apenas os grupos que ultrapassaram
                      o limite.
                    </p>
                  </div>
                )}
                <dl
                  aria-label="Movimentação do mês"
                  className="grid grid-cols-1 gap-4 text-left sm:grid-cols-2"
                >
                  {(flow
                    ? [
                        {
                          label: 'Caixa inicial',
                          value: flow.openingCashCents,
                        },
                        {
                          label: 'Entradas recebidas',
                          value: flow.receivedCents,
                        },
                        { label: 'Saídas pagas', value: flow.paidCents },
                        { label: 'Caixa', value: flow.cashCents },
                      ]
                    : [
                        { label: 'Renda', value: selected.incomeCents },
                        { label: 'Despesas registradas', value: spending },
                        { label: 'Aportes registrados', value: contributions },
                      ]
                  ).map((item) => (
                    <div key={item.label} className="min-w-0 text-left">
                      <dt className="text-xs text-muted-foreground">
                        {item.label}
                      </dt>
                      <dd className="mt-1 text-2xl font-medium tracking-tight tabular-nums">
                        {item.value === null
                          ? 'Sem saldo registrado'
                          : formatCurrency(item.value)}
                      </dd>
                    </div>
                  ))}
                </dl>
                {flow?.forecasting && (
                  <section
                    className="border-t pt-4"
                    aria-label="Previsão do mês"
                  >
                    <h3 className="mb-3 text-sm font-semibold">
                      Previsão do mês
                    </h3>
                    <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      {[
                        { label: 'A receber', value: flow.expectedIncomeCents },
                        { label: 'A pagar', value: flow.remainingExpenseCents },
                        {
                          label: 'Caixa previsto no fim do mês',
                          value: flow.closingCashCents,
                        },
                        {
                          label: 'Depois das metas',
                          value: flow.afterGoalsCents,
                        },
                      ].map((item) => (
                        <div key={item.label}>
                          <dt className="text-xs text-muted-foreground">
                            {item.label}
                          </dt>
                          <dd
                            className={cn(
                              'mt-1 font-medium tabular-nums',
                              item.value !== null &&
                                item.value < 0 &&
                                'text-destructive',
                            )}
                          >
                            {item.value === null
                              ? 'Sem saldo registrado'
                              : formatCurrency(item.value)}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                )}
                <MonthlyAssistant
                  month={selected.month}
                  closed={selected.familyMonth?.closed ?? false}
                  configured={assistantConfigured}
                  revision={JSON.stringify({
                    flow,
                    expenses: selected.familyMonth?.expenses,
                    estimated: selected.familyMonth?.estimatedExpenseCents,
                    known: selected.familyMonth?.knownExpenseCents,
                    actual: selected.actual,
                    targets: selected.targets,
                  })}
                />
                <div className="grid gap-8 border-t pt-5 md:grid-cols-2">
                  <div className="flex flex-col gap-5">
                    <h3 className="text-sm font-semibold">Despesas do mês</h3>
                    {expenseBuckets.map((bucket) => {
                      const actual = selected.actual[bucket]
                      const target = selected.targets[bucket]
                      const remaining = target - actual
                      return (
                        <div key={bucket} className="flex flex-col gap-2">
                          <div className="flex items-baseline justify-between gap-2 text-sm">
                            <span>{bucketLabels[bucket]}</span>
                            <strong className="tabular-nums">
                              {formatCurrency(actual)}
                            </strong>
                          </div>
                          <ProgressBar
                            value={actual}
                            max={target}
                            className={cn(
                              remaining < 0 &&
                                '[&_[data-slot=progress-indicator]]:bg-destructive',
                            )}
                          />
                          <div className="flex flex-wrap justify-between gap-1 text-xs">
                            <span className="text-muted-foreground">
                              Limite {formatCurrency(target)}
                            </span>
                            <span
                              className={cn(
                                remaining < 0
                                  ? 'text-destructive'
                                  : 'text-muted-foreground',
                              )}
                            >
                              {formatCurrency(Math.abs(remaining))}{' '}
                              {remaining < 0 ? 'acima' : 'restantes'}
                            </span>
                          </div>
                        </div>
                      )
                    })}
                    {selected.other !== 0 && (
                      <div className="flex items-baseline justify-between gap-2 text-sm">
                        <span>Outras despesas</span>
                        <strong className="tabular-nums">
                          {formatCurrency(selected.other)}
                        </strong>
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col gap-5">
                    <h3 className="text-sm font-semibold">Metas de aporte</h3>
                    {(['investment', 'reserve'] as const).map((bucket) => {
                      const actual = selected.actual[bucket]
                      const target = selected.targets[bucket]
                      return (
                        <div key={bucket} className="flex flex-col gap-2">
                          <div className="flex items-center gap-3">
                            <GoalRing
                              value={actual}
                              target={target}
                              reserve={bucket === 'reserve'}
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                                <span>{bucketLabels[bucket]}</span>
                                <strong className="tabular-nums">
                                  {formatCurrency(actual)}
                                </strong>
                              </div>
                              <div className="mt-1 flex flex-wrap justify-between gap-1 text-xs text-muted-foreground">
                                <span>
                                  {target > 0
                                    ? `Meta ${formatCurrency(target)}`
                                    : 'Sem meta'}
                                </span>
                                <span>
                                  {target > 0 && actual >= target
                                    ? 'Concluída'
                                    : 'Aportado'}
                                </span>
                              </div>
                            </div>
                          </div>
                          {actual < target && (
                            <p className="text-xs text-muted-foreground">
                              {selected.familyMonth?.forecasting
                                ? 'Falta guardar'
                                : 'Abaixo da meta'}
                              : {formatCurrency(target - actual)}
                            </p>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </Panel>
  )
}
