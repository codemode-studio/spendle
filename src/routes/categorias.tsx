import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { ArrowUpRight, Tags, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { z } from 'zod'

import { SegmentedControl } from '#/components/segmented-control'
import { EmptyState, Page, PageHeader, Panel } from '#/components/ui'
import { Button } from '#/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '#/components/ui/table'
import { formatCurrency } from '#/lib/currency'
import { fullPeriod } from '#/lib/ledger'
import { formatPeriod, trailingPeriod } from '#/lib/period'
import type { Period } from '#/lib/period'
import { analyzeCategories } from '#/features/categories/analysis'
import {
  CategoryHeatmap,
  Sparkline,
  StackedMonthly,
} from '#/features/categories/monthly-chart'
import { CategoryReviewQueue } from '#/features/categories/review-queue'
import {
  categoriesOptions,
  categoryLedgerOptions,
  categoryReviewOptions,
} from '#/features/data/queries'
import { cn } from '#/lib/utils'

const PERIODS = {
  '30d': { label: '30 dias', days: 30 },
  '3m': { label: '3 meses', days: 91 },
  '6m': { label: '6 meses', days: 182 },
  '12m': { label: '12 meses', days: 365 },
  tudo: { label: 'Tudo', days: null },
} as const
type PeriodKey = keyof typeof PERIODS

const searchSchema = z.object({
  periodo: z
    .enum(['30d', '3m', '6m', '12m', 'tudo'])
    .optional()
    .catch(undefined),
})

export const Route = createFileRoute('/categorias')({
  validateSearch: searchSchema,
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(categoryLedgerOptions()),
      context.queryClient.ensureQueryData(categoryReviewOptions()),
      context.queryClient.ensureQueryData(categoriesOptions()),
    ]),
  component: CategoriesPage,
})

function CategoriesPage() {
  const { data } = useSuspenseQuery(categoryLedgerOptions())
  const { periodo = '30d' } = Route.useSearch()
  const navigate = Route.useNavigate()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [chart, setChart] = useState<'stack' | 'heat'>('stack')

  const transactions = data
  const period = useMemo<Period>(() => {
    const config = PERIODS[periodo]
    if (config.days) return trailingPeriod(config.days)
    return fullPeriod(transactions)
  }, [periodo, transactions])
  const analysis = useMemo(
    () => analyzeCategories(transactions, period),
    [transactions, period],
  )
  const highlight =
    analysis.items.find((item) => item.id === selectedId) ?? null
  const hasPartialMonth = analysis.months.some((month) => month.partial)
  const showAverage = analysis.periodDays > 45
  const maxShare = analysis.items[0]?.share ?? 0

  const setPeriod = (value: string) =>
    void navigate({ search: { periodo: value as PeriodKey }, replace: true })

  return (
    <Page>
      <PageHeader
        title="Categorias"
        description={
          analysis.spendingCount > 0
            ? `${analysis.spendingCount} lançamentos de gasto · ${formatPeriod(period)}`
            : `Nenhum gasto categorizado em ${formatPeriod(period)}.`
        }
        actions={
          <SegmentedControl
            aria-label="Período"
            value={periodo}
            onValueChange={setPeriod}
            items={Object.entries(PERIODS).map(([value, config]) => ({
              value,
              label: config.label,
            }))}
          />
        }
      />

      <CategoryReviewQueue />

      <Panel className="mb-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-muted-foreground">
              Gastos classificados no período
            </p>
            <p className="mt-1 text-3xl font-semibold tracking-tight">
              {formatCurrency(analysis.totalCents)}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              A cobertura dos extratos não foi validada nesta visão. Os valores
              classificados não comprovam aumento ou queda do consumo.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              {showAverage && (
                <span className="text-xs text-muted-foreground tabular-nums">
                  ≈ {formatCurrency(analysis.averageMonthlyCents)}/mês
                </span>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {highlight && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSelectedId(null)}
              >
                <span
                  className="size-2 rounded-full"
                  style={{ background: highlight.color }}
                />
                {highlight.name}
                <X data-icon="inline-end" />
              </Button>
            )}
            {analysis.months.length > 1 && (
              <SegmentedControl
                aria-label="Tipo de gráfico"
                value={chart}
                onValueChange={(value) => setChart(value as 'stack' | 'heat')}
                items={[
                  { value: 'stack', label: 'Por mês' },
                  { value: 'heat', label: 'Mapa de calor' },
                ]}
              />
            )}
          </div>
        </div>

        {analysis.items.length > 0 && (
          <div
            className="mt-5 flex h-2 w-full gap-0.5 overflow-hidden rounded-full"
            aria-hidden="true"
          >
            {analysis.items
              .filter((item) => item.share > 0)
              .map((item) => (
                <div
                  key={item.id}
                  title={`${item.name}: ${Math.round(item.share * 100)}%`}
                  className="h-full min-w-1 rounded-full transition-opacity duration-150"
                  style={{
                    width: `${item.share * 100}%`,
                    background: item.color,
                    opacity: highlight && highlight.id !== item.id ? 0.3 : 1,
                  }}
                />
              ))}
          </div>
        )}

        {analysis.months.length > 1 && (
          <div className="mt-6">
            {chart === 'stack' ? (
              <StackedMonthly
                months={analysis.months}
                items={analysis.items}
                highlightId={selectedId}
                onHighlight={setSelectedId}
              />
            ) : (
              <CategoryHeatmap
                months={analysis.months}
                items={analysis.items}
                highlightId={selectedId}
                onHighlight={setSelectedId}
              />
            )}
            {hasPartialMonth && (
              <p className="mt-1 text-right text-[11px] text-muted-foreground">
                * mês parcial
              </p>
            )}
          </div>
        )}
      </Panel>

      <Panel title="Por categoria">
        {analysis.items.length === 0 && analysis.uncategorizedCount === 0 ? (
          <EmptyState
            icon={Tags}
            title="Sem gastos no período"
            description="Importe extratos ou amplie o período para ver a distribuição por categoria."
          />
        ) : (
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead>Categoria</TableHead>
                <TableHead className="w-32 text-right">%</TableHead>
                <TableHead className="w-32 text-right">Gasto</TableHead>
                {showAverage && (
                  <TableHead className="hidden w-32 text-right md:table-cell">
                    Média/mês
                  </TableHead>
                )}
                {analysis.months.length > 1 && (
                  <TableHead className="hidden w-24 text-right lg:table-cell">
                    Tendência
                  </TableHead>
                )}
                <TableHead className="w-10">
                  <span className="sr-only">Lançamentos</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {analysis.items.map((item) => {
                const selected = item.id === selectedId
                const dimmed = highlight !== null && !selected
                return (
                  <TableRow
                    key={item.id}
                    aria-selected={selected}
                    onClick={() => setSelectedId(selected ? null : item.id)}
                    className={cn(
                      'cursor-pointer transition-[background-color,opacity] duration-150',
                      selected && 'bg-muted/60',
                      dimmed && 'opacity-60',
                    )}
                  >
                    <TableCell>
                      <button
                        type="button"
                        aria-pressed={selected}
                        onClick={(event) => {
                          event.stopPropagation()
                          setSelectedId(selected ? null : item.id)
                        }}
                        className="flex max-w-full items-center gap-2.5 rounded-md text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                      >
                        <span
                          className="flex size-6 shrink-0 items-center justify-center rounded-md"
                          style={{ background: `${item.color}1f` }}
                        >
                          <span
                            className="size-2 rounded-full"
                            style={{ background: item.color }}
                          />
                        </span>
                        <span className="truncate font-medium">
                          {item.name}
                        </span>
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {item.count}
                        </span>
                      </button>
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground tabular-nums">
                      <span className="flex items-center justify-end gap-2">
                        <span
                          aria-hidden="true"
                          className="h-1.5 w-16 overflow-hidden rounded-full bg-muted"
                        >
                          <span
                            className="block h-full rounded-full"
                            style={{
                              width: `${maxShare > 0 ? (item.share / maxShare) * 100 : 0}%`,
                              background: item.color,
                            }}
                          />
                        </span>
                        <span className="w-8">
                          {Math.round(item.share * 100)}%
                        </span>
                      </span>
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {formatCurrency(item.cents)}
                    </TableCell>
                    {showAverage && (
                      <TableCell className="hidden text-right text-muted-foreground tabular-nums md:table-cell">
                        {formatCurrency(item.averageMonthlyCents)}
                      </TableCell>
                    )}
                    {analysis.months.length > 1 && (
                      <TableCell className="hidden text-right lg:table-cell">
                        <Sparkline
                          values={item.monthly}
                          color={item.color}
                          className="ml-auto block"
                        />
                      </TableCell>
                    )}
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        nativeButton={false}
                        aria-label={`Ver lançamentos de ${item.name}`}
                        onClick={(event) => event.stopPropagation()}
                        render={
                          <Link
                            to="/transacoes"
                            search={{ category: item.id }}
                          />
                        }
                      >
                        <ArrowUpRight />
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })}
              {analysis.uncategorizedCount > 0 && (
                <TableRow className="text-muted-foreground">
                  <TableCell>
                    <span className="flex items-center gap-2.5">
                      <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-amber-100">
                        <span className="size-2 rounded-full bg-amber-500" />
                      </span>
                      <span className="truncate">Sem categoria</span>
                      <span className="text-xs tabular-nums">
                        {analysis.uncategorizedCount}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell className="text-right">—</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {formatCurrency(analysis.uncategorizedCents)}
                  </TableCell>
                  {showAverage && (
                    <TableCell className="hidden md:table-cell" />
                  )}
                  {analysis.months.length > 1 && (
                    <TableCell className="hidden lg:table-cell" />
                  )}
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      nativeButton={false}
                      aria-label="Ver lançamentos sem categoria"
                      render={
                        <Link
                          to="/transacoes"
                          search={{ category: 'uncategorized' }}
                        />
                      }
                    >
                      <ArrowUpRight />
                    </Button>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </Panel>
    </Page>
  )
}
