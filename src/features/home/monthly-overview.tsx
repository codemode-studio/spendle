import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CalendarDays, ChevronLeft, ChevronRight, History } from 'lucide-react'

import type { MonthView } from '@spendle/server/api'

import { ExchangeNote } from '#/components/exchange'
import { EmptyState, Panel, ProgressBar } from '#/components/ui'
import { Button } from '#/components/ui/button'
import { Skeleton } from '#/components/ui/skeleton'
import { bucketLabels, formatCurrency, formatMonth } from '#/lib/finance'
import { GoalRing } from '#/features/finance/strategy-progress'
import { categoriesOptions, monthHistoryOptions } from '#/features/data/queries'
import { cn } from '#/lib/utils'
import { MonthlyAssistant } from './monthly-assistant'

const expenseBuckets = ['essential', 'lifestyle'] as const

export function MonthlyOverview({
  current,
  assistantConfigured = false,
}: {
  current: MonthView
  assistantConfigured?: boolean
}) {
  const history = useQuery(monthHistoryOptions(11))
  const [selectedMonth, setSelectedMonth] = useState(current.month)
  const months = [...[...(history.data ?? [])].reverse(), current].map(
    (item) => ({
      month: item.month,
      closed: item.closed,
      forecasting: item.forecasting,
      family: item.family,
      flow: item.cashFlow,
      hasData: item.family.hasData,
      exchange: item.exchange,
      chartCents: item.cashFlow.closingCashCents,
      targets: item.targets,
      actual: item.actual,
      other:
        item.family.expenses.find((group) => group.bucket === 'other')?.cents ??
        0,
    }),
  )
  const selected =
    months.find((month) => month.month === selectedMonth) ??
    months[months.length - 1]
  const selectedIndex = months.indexOf(selected)
  const maxSpending = Math.max(
    1,
    ...months.flatMap((month) => [
      Math.abs(month.chartCents ?? 0),
      month.flow.receivedCents,
      month.flow.paidCents,
    ]),
  )
  const belowZero = Math.max(
    0,
    ...months.map((month) => -(month.chartCents ?? 0)),
  )
  const chartRange = maxSpending + belowZero
  const zeroPosition = (belowZero / chartRange) * 100

  const overspending = expenseBuckets.reduce(
    (sum, bucket) =>
      sum + Math.max(0, selected.actual[bucket] - selected.targets[bucket]),
    0,
  )
  const flow = selected.flow

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
              const hasChartData = month.chartCents !== null && month.hasData
              const over = expenseBuckets.some(
                (bucket) => month.actual[bucket] > month.targets[bucket],
              )
              const series = [
                { value: month.flow.receivedCents, color: 'bg-emerald-600' },
                { value: month.flow.paidCents, color: 'bg-amber-600' },
                {
                  value: amount,
                  color: amount < 0 ? 'bg-destructive' : 'bg-primary/70',
                },
              ]
              return (
                <button
                  key={month.month}
                  type="button"
                  aria-pressed={selected.month === month.month}
                  aria-label={`${formatMonth(month.month)}: ${hasChartData ? `caixa ${month.forecasting ? 'previsto' : 'registrado'} ${formatCurrency(amount)}` : 'sem valores para comparar'}${month.hasData && over ? '; gastos acima dos limites' : ''}`}
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
                              index === 2 && month.forecasting && 'opacity-50',
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
          {
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
          }
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
                      Gastos {selected.forecasting ? 'previstos ' : ''}
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
                  {[
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
                  ].map((item) => (
                    <div key={item.label} className="min-w-0 text-left">
                      <dt className="text-xs text-muted-foreground">
                        {item.label}
                      </dt>
                      <dd className="mt-1 text-2xl font-medium tracking-tight tabular-nums">
                        {formatCurrency(item.value ?? 0)}
                      </dd>
                    </div>
                  ))}
                </dl>
                {/* The current month's rates already show beside today's cash. */}
                {selected.month !== current.month && (
                  <ExchangeNote exchange={selected.exchange} />
                )}
                {flow.forecasting && (
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
                            {formatCurrency(item.value ?? 0)}
                          </dd>
                        </div>
                      ))}
                    </dl>
                    <PayableBreakdown
                      remainingCents={flow.remainingExpenseCents}
                      lines={selected.family.lines}
                    />
                  </section>
                )}
                <MonthlyAssistant
                  month={selected.month}
                  closed={selected.closed}
                  configured={assistantConfigured}
                  revision={JSON.stringify({
                    flow,
                    expenses: selected.family.expenses,
                    estimated: selected.family.estimatedExpenseCents,
                    known: selected.family.knownExpenseCents,
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
                              {selected.forecasting
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

/**
 * What is still to pay, split into what schedules say (bills, instalments,
 * recurrences) and what category history suggests, with the categories
 * behind the estimate.
 */
function PayableBreakdown({
  remainingCents,
  lines,
}: {
  remainingCents: number
  lines: MonthView['family']['lines']
}) {
  const categories = useQuery(categoriesOptions(true))
  const estimates = lines
    .filter((line) => line.origin === 'history' && line.estimatedCents > 0)
    .sort((a, b) => b.estimatedCents - a.estimatedCents)
  const historyCents = estimates.reduce(
    (sum, line) => sum + line.estimatedCents,
    0,
  )
  if (historyCents === 0 || remainingCents <= 0) return null
  const scheduledCents = Math.max(0, remainingCents - historyCents)
  const nameOf = (id: string | null) =>
    categories.data?.find((category) => category.id === id)?.name ??
    'Outra categoria'
  return (
    <div className="mt-4 flex flex-col gap-3">
      <div
        className="flex h-2 overflow-hidden rounded-full bg-muted"
        aria-hidden="true"
      >
        <span
          className="bg-amber-600"
          style={{ width: `${(scheduledCents / remainingCents) * 100}%` }}
        />
        <span
          className="bg-[repeating-linear-gradient(135deg,var(--color-amber-600)_0_3px,transparent_3px_6px)] opacity-70"
          style={{ width: `${(historyCents / remainingCents) * 100}%` }}
        />
      </div>
      <dl
        aria-label="Composição do valor a pagar"
        className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2"
      >
        <div className="flex items-center gap-2">
          <span className="size-2 shrink-0 rounded-sm bg-amber-600" />
          <dt className="text-muted-foreground">Agendado</dt>
          <dd className="ml-auto font-medium tabular-nums sm:ml-0">
            {formatCurrency(scheduledCents)}
          </dd>
        </div>
        <div className="flex items-center gap-2">
          <History
            className="size-3.5 shrink-0 text-amber-700"
            aria-hidden="true"
          />
          <dt className="text-muted-foreground">Estimado pelo histórico</dt>
          <dd className="ml-auto font-medium tabular-nums sm:ml-0">
            {formatCurrency(historyCents)}
          </dd>
        </div>
      </dl>
      {categories.data && (
        <ul
          aria-label="Categorias estimadas pela mediana dos últimos 3 meses"
          className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"
        >
          {estimates.map((line) => (
            <li key={line.id}>
              {nameOf(line.categoryId)}{' '}
              <span className="tabular-nums">
                {formatCurrency(line.estimatedCents)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
