import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  Landmark,
  ReceiptText,
  Upload,
} from 'lucide-react'
import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { z } from 'zod'

import {
  EmptyState,
  MetricCard,
  PageHeader,
  Panel,
  ProgressBar,
} from '#/components/ui'
import { Alert, AlertDescription } from '#/components/ui/alert'
import { Button } from '#/components/ui/button'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '#/components/ui/table'
import {
  formatCurrency,
  formatInstrumentName,
  percentFromBps,
} from '#/domain/finance'
import { financeSnapshotOptions } from '#/features/finance/queries'

const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/
const dashboardSearchSchema = z.object({
  month: z.string().regex(monthPattern).optional().catch(undefined),
})

export const Route = createFileRoute('/')({
  validateSearch: dashboardSearchSchema,
  loaderDeps: ({ search }) => ({ month: search.month ?? getCurrentMonth() }),
  loader: ({ context, deps }) =>
    context.queryClient.ensureQueryData(financeSnapshotOptions(deps.month)),
  component: Dashboard,
})

const bucketLabels = {
  essential: 'Essenciais',
  lifestyle: 'Estilo de vida',
  investment: 'Investimentos',
  reserve: 'Reserva',
} as const

function getCurrentMonth() {
  return new Date().toISOString().slice(0, 7)
}

function shiftMonth(month: string, amount: number) {
  const [year, monthNumber] = month.split('-').map(Number)
  return new Date(Date.UTC(year, monthNumber - 1 + amount, 1))
    .toISOString()
    .slice(0, 7)
}

function formatMonth(month: string) {
  const label = new Intl.DateTimeFormat('pt-BR', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${month}-01T12:00:00Z`))
  return label.charAt(0).toUpperCase() + label.slice(1)
}

function getMonthOptions(months: Array<string>, selectedMonth: string) {
  const currentMonth = getCurrentMonth()
  const knownMonths = months.filter((month) => monthPattern.test(month))
  const earliestMonth = [...knownMonths, selectedMonth, currentMonth].sort()[0]
  const options: Array<string> = []

  for (
    let month = currentMonth;
    month >= earliestMonth && options.length < 120;
    month = shiftMonth(month, -1)
  ) {
    options.push(month)
  }

  if (!options.includes(selectedMonth)) options.push(selectedMonth)
  return options.sort((left, right) => right.localeCompare(left))
}

function Dashboard() {
  const { month } = Route.useSearch()
  const navigate = Route.useNavigate()
  const selectedMonth = month ?? getCurrentMonth()
  const { data } = useSuspenseQuery(financeSnapshotOptions(selectedMonth))
  const { dashboard } = data
  const recentTransactions = data.transactions
    .filter((transaction) => transaction.postedAt.startsWith(selectedMonth))
    .slice(0, 6)
  const monthOptions = getMonthOptions(
    [
      ...data.transactions.map((transaction) =>
        transaction.postedAt.slice(0, 7),
      ),
      ...data.monthlyBudgets.map((budget) => budget.month),
    ],
    selectedMonth,
  )
  const monthItems = monthOptions.map((option) => ({
    label: formatMonth(option),
    value: option,
  }))
  const currentMonth = getCurrentMonth()

  const selectMonth = (nextMonth: string | null) => {
    if (!nextMonth) return
    void navigate({
      search: (previous) => ({ ...previous, month: nextMonth }),
    })
  }

  return (
    <div className="page">
      <PageHeader
        eyebrow={formatMonth(dashboard.currentMonth)}
        title="Visão geral"
        description="Patrimônio, orçamento e pendências do mês."
        actions={
          <>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="Ver mês anterior"
                onClick={() => selectMonth(shiftMonth(selectedMonth, -1))}
              >
                <ChevronLeft />
              </Button>
              <Select
                items={monthItems}
                value={selectedMonth}
                onValueChange={selectMonth}
              >
                <SelectTrigger aria-label="Selecionar mês" className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  <SelectGroup>
                    {monthItems.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="Ver próximo mês"
                disabled={selectedMonth >= currentMonth}
                onClick={() => selectMonth(shiftMonth(selectedMonth, 1))}
              >
                <ChevronRight />
              </Button>
            </div>
            <Button
              nativeButton={false}
              render={<Link to="/importar" search={{ view: 'upload' }} />}
            >
              <Upload data-icon="inline-start" /> Importar extrato
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <MetricCard
          label="Patrimônio em BRL"
          value={formatCurrency(dashboard.netWorthCents)}
          detail={`${data.accounts.length} conta${data.accounts.length === 1 ? '' : 's'} acompanhada${data.accounts.length === 1 ? '' : 's'}`}
          icon={Landmark}
          tone="positive"
        />
        <MetricCard
          label="Renda familiar no mês"
          value={formatCurrency(dashboard.currentIncomeCents)}
          detail={`Base conservadora: ${formatCurrency(dashboard.baseIncomeCents)}`}
          icon={ArrowUpRight}
          tone="positive"
        />
        <MetricCard
          label="Gastos no mês"
          value={formatCurrency(dashboard.currentExpenseCents)}
          detail="Essenciais + estilo de vida"
          icon={ArrowDownRight}
          tone={
            dashboard.currentExpenseCents > dashboard.baseIncomeCents * 0.6
              ? 'warning'
              : 'default'
          }
        />
        <Link
          to="/importar"
          search={{ view: 'review' }}
          className="rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <MetricCard
            className="h-full transition-colors hover:bg-muted/40"
            label="Pendências"
            value={String(
              dashboard.reviewTransactionCount + dashboard.reconciliationCount,
            )}
            detail={`${dashboard.reviewTransactionCount} lançamentos em ${dashboard.reviewImportCount} lote${dashboard.reviewImportCount === 1 ? '' : 's'} · ${dashboard.reconciliationCount} conciliações`}
            icon={ReceiptText}
            tone={dashboard.reviewTransactionCount ? 'warning' : 'default'}
          />
        </Link>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.8fr)_minmax(280px,1fr)]">
        <Panel
          title={`Estratégia ${dashboard.activeStrategy.name}`}
          description={`Orçamento calculado sobre ${formatCurrency(dashboard.baseIncomeCents)} neste mês.`}
          action={
            <Button
              nativeButton={false}
              size="sm"
              variant="ghost"
              render={
                <Link to="/planejamento" search={{ section: 'budget' }} />
              }
            >
              Ajustar <ArrowRight data-icon="inline-end" />
            </Button>
          }
        >
          <div className="grid gap-4">
            {(
              Object.keys(bucketLabels) as Array<keyof typeof bucketLabels>
            ).map((bucket) => {
              const target = dashboard.budgetTargets[bucket]
              const actual = dashboard.budgetActual[bucket]
              const bps = dashboard.effectiveAllocation[bucket]
              return (
                <div key={bucket}>
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
                    <strong>
                      {bucketLabels[bucket]} · {percentFromBps(bps)}
                    </strong>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {formatCurrency(actual)} de {formatCurrency(target)}
                    </span>
                  </div>
                  <ProgressBar value={actual} max={target} />
                </div>
              )
            })}
          </div>
          {dashboard.reserve.redirected && (
            <Alert className="mt-4">
              <AlertDescription>
                A reserva atingiu a meta. Os{' '}
                {percentFromBps(dashboard.originalAllocation.reserve)} de novos
                aportes foram redirecionados para investimentos.
              </AlertDescription>
            </Alert>
          )}
        </Panel>

        <Panel
          title="Reserva de emergência"
          description={`${dashboard.reserve.months} meses de despesas essenciais`}
        >
          <div className="rounded-lg border p-4">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-medium">
                  {dashboard.reserve.complete
                    ? 'Meta concluída'
                    : 'Construindo sua segurança'}
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  {dashboard.reserve.complete
                    ? 'Aportes futuros seguem para investimentos.'
                    : 'Continue com os aportes mensais planejados.'}
                </p>
              </div>
              <CircleDollarSign size={20} color="var(--primary)" />
            </div>
            <ProgressBar
              value={dashboard.reserve.currentCents}
              max={dashboard.reserve.targetCents}
            />
            <div className="mt-2 flex justify-between text-xs text-muted-foreground tabular-nums">
              <span>{formatCurrency(dashboard.reserve.currentCents)}</span>
              <span>{formatCurrency(dashboard.reserve.targetCents)}</span>
            </div>
          </div>
          <Button
            nativeButton={false}
            variant="outline"
            className="mt-3 w-full"
            render={<Link to="/planejamento" search={{ section: 'goals' }} />}
          >
            Ver metas e aportes
          </Button>
        </Panel>
      </div>

      <Panel
        title="Movimentações recentes"
        description={`Lançamentos consolidados de ${formatMonth(selectedMonth).toLocaleLowerCase('pt-BR')}.`}
        action={
          <Button
            nativeButton={false}
            size="sm"
            variant="ghost"
            render={<Link to="/transacoes" />}
          >
            Ver todas <ArrowRight data-icon="inline-end" />
          </Button>
        }
        className="mt-4"
      >
        {recentTransactions.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Data</TableHead>
                <TableHead>Descrição</TableHead>
                <TableHead>Origem</TableHead>
                <TableHead>Categoria</TableHead>
                <TableHead className="text-right">Valor</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recentTransactions.map((transaction) => (
                <TableRow key={transaction.id}>
                  <TableCell className="text-muted-foreground tabular-nums">
                    {new Date(
                      `${transaction.postedAt}T12:00:00`,
                    ).toLocaleDateString('pt-BR')}
                  </TableCell>
                  <TableCell className="font-medium">
                    {transaction.description}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatInstrumentName(
                      transaction.account?.name ??
                        transaction.creditCard?.name ??
                        '—',
                    )}
                  </TableCell>
                  <TableCell>
                    {transaction.category?.name ?? 'Sem categoria'}
                  </TableCell>
                  <TableCell
                    className={
                      transaction.amountCents >= 0
                        ? 'text-right font-medium tabular-nums text-success'
                        : 'text-right font-medium tabular-nums text-destructive'
                    }
                  >
                    {formatCurrency(
                      transaction.amountCents,
                      transaction.currency,
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <EmptyState
            icon={ReceiptText}
            title="Nenhuma movimentação ainda"
            description="Cadastre suas contas e importe o primeiro extrato para começar a reconciliação."
            action={
              <Button
                nativeButton={false}
                render={<Link to="/importar" search={{ view: 'upload' }} />}
              >
                Importar extrato
              </Button>
            }
          />
        )}
      </Panel>
    </div>
  )
}
