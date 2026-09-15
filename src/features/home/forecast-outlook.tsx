import { useMemo, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { ArrowRight, ChevronDown, Sparkles, TrendingUp } from 'lucide-react'
import { EmptyState } from '#/components/ui'
import { Button, buttonVariants } from '#/components/ui/button'
import { Field, FieldGroup, FieldLabel } from '#/components/ui/field'
import { Progress } from '#/components/ui/progress'
import { Input } from '#/components/ui/input'
import { SegmentedControl } from '#/components/segmented-control'
import { formatCurrency, toMinorUnits } from '#/domain/currency'
import { formatMonth } from '#/domain/finance'
import { trimCashProjection } from '#/domain/monthly-cash-flow'
import { formatLongDate, formatShortDate } from '#/domain/period'
import type { FinanceSnapshot } from '#/features/finance/snapshot.types'
import { cn } from '#/lib/utils'
import { CashChart } from './charts'
import { simulateRecovery } from './forecast'
import type { HomeView } from './insights'

export function ForecastOutlook({
  snapshot,
  view,
}: {
  snapshot: FinanceSnapshot
  view: HomeView
}) {
  const [days, setDays] = useState(60)
  const [reduction, setReduction] = useState(0)
  const [extra, setExtra] = useState('')
  const cash = useMemo(
    () => trimCashProjection(snapshot.cashProjection, days),
    [snapshot, days],
  )
  const dashboard = snapshot.dashboard
  const month = dashboard.familyMonth
  const savingsTarget =
    dashboard.budgetTargets.investment + dashboard.budgetTargets.reserve
  let extraCents = 0
  let invalid = false
  if (extra.trim()) {
    try {
      extraCents = toMinorUnits(extra)
      invalid = extraCents < 0 || extraCents > 100_000_000
    } catch {
      invalid = true
    }
  }
  const hasData =
    view.latestPostedAt !== null ||
    cash.assumptions.estimatedIncomeCents > 0 ||
    cash.assumptions.estimatedRecurrenceCents > 0
  if (!hasData)
    return (
      <EmptyState
        icon={TrendingUp}
        title="Complete os dados para prever o caixa"
        description="Importe extratos e cadastre receitas e despesas recorrentes para simular como voltar a acumular."
        action={
          <Link to="/importar" className={buttonVariants()}>
            Importar extrato
          </Link>
        }
      />
    )
  const startingCents = cash.assumptions.startingCents
  if (startingCents === null)
    return (
      <EmptyState
        icon={TrendingUp}
        title="Sem caixa em reais para prever"
        description="Uma conta operacional em moeda estrangeira está sem cotação. Cadastre a cotação para converter o saldo e liberar a previsão."
        action={
          <Link to="/configuracoes" className={buttonVariants()}>
            Abrir configurações
          </Link>
        }
      />
    )
  const scenario = simulateRecovery(
    cash,
    reduction,
    invalid ? 0 : extraCents,
    savingsTarget,
  )
  const changed = scenario.improvementMonthlyCents > 0
  const monthlyIncome = Math.round(
    (cash.assumptions.estimatedIncomeCents * 30) / days,
  )
  const monthlyExpenses = monthlyIncome - scenario.monthlyBalanceCents
  const title =
    startingCents < 0
      ? 'O caixa já está negativo'
      : scenario.firstNegative
        ? `O caixa aperta em ${formatShortDate(scenario.firstNegative.date)}`
        : scenario.monthlyBalanceCents < 0
          ? 'O caixa está perdendo fôlego'
          : 'Há espaço para acumular neste cenário'

  return (
    <div className="flex flex-col gap-6">
      <section
        aria-labelledby="forecast-title"
        className="min-w-0 rounded-xl border bg-card p-panel shadow-xs"
      >
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
          <div className="min-w-0">
            <p className="text-sm text-muted-foreground">
              Caixa previsto · antes dos aportes
            </p>
            <h2
              id="forecast-title"
              className="mt-1 text-xl font-semibold tracking-tight sm:text-2xl"
            >
              {title}
            </h2>
          </div>
          <SegmentedControl
            className="self-start"
            aria-label="Horizonte da previsão"
            value={String(days)}
            onValueChange={(value) => setDays(Number(value))}
            items={[
              { value: '30', label: '30 dias' },
              { value: '60', label: '60 dias' },
              { value: '90', label: '90 dias' },
            ]}
          />
        </div>
        <dl className="mt-6 grid grid-cols-2 gap-5 lg:grid-cols-4">
          <ForecastMetric label="Caixa hoje" cents={startingCents} />
          <ForecastMetric
            label="Em 30 dias"
            cents={cash.in30Cents ?? startingCents}
            detail={formatShortDate(
              cash.points[
                Math.min(cash.todayIndex + 30, cash.points.length - 1)
              ].date,
            )}
          />
          <ForecastMetric
            label="Menor saldo previsto"
            cents={scenario.minimum.balanceCents}
            detail={formatShortDate(scenario.minimum.date)}
          />
          <ForecastMetric
            label={`Ao final de ${days} dias`}
            cents={scenario.endingCents}
          />
        </dl>
        <div className="mt-7">
          <CashChart
            points={cash.points}
            todayIndex={cash.todayIndex}
            scenarioPoints={changed ? scenario.points : undefined}
            height={270}
            formatCents={formatCurrency}
            formatDate={formatLongDate}
          />
        </div>
        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-2">
            <span className="h-0.5 w-4 bg-success" />
            Histórico
          </span>
          <span className="flex items-center gap-2">
            <span className="h-0.5 w-4 bg-muted-foreground" />
            Ritmo atual
          </span>
          {changed && (
            <span className="flex items-center gap-2">
              <span className="w-4 border-t-2 border-dashed border-primary" />
              Com ajustes
            </span>
          )}
        </div>
        {(view.integrity.partial || !view.comparisonReady.month) && (
          <p className="mt-2 text-sm text-warning">
            Dados parciais.{' '}
            <Link className="underline underline-offset-4" to="/importar">
              Atualizar extratos
            </Link>{' '}
            e{' '}
            <Link
              className="underline underline-offset-4"
              to="/transacoes"
              search={{ category: 'uncategorized' }}
            >
              revisar pendências
            </Link>
            .
          </p>
        )}
      </section>

      <div className="grid items-start gap-6 lg:grid-cols-[1fr_1fr]">
        <section
          aria-labelledby="recovery-title"
          className="min-w-0 rounded-xl border bg-card p-panel shadow-xs"
        >
          <div className="flex items-center gap-2">
            <TrendingUp className="size-5 text-primary" />
            <h2 id="recovery-title" className="text-lg font-semibold">
              Melhora necessária
            </h2>
          </div>
          <p className="mt-5 text-3xl font-semibold tracking-tight tabular-nums">
            {formatCurrency(scenario.requiredMonthlyCents)}
            <span className="text-sm font-normal text-muted-foreground">
              {' '}
              / mês
            </span>
          </p>
          <dl className="my-5 flex flex-col gap-3 text-sm">
            <MoneyRow
              label="Saldo previsto / mês"
              cents={scenario.monthlyBalanceCents}
            />
            <MoneyRow label="Meta de aportes / mês" cents={savingsTarget} />
          </dl>
          <h3 className="mb-4 text-sm font-medium">Simular ajustes</h3>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="forecast-reduction">
                Reduzir consumo estimado{' '}
                <span className="ml-auto tabular-nums">{reduction}%</span>
              </FieldLabel>
              <input
                id="forecast-reduction"
                type="range"
                min={0}
                max={100}
                step={5}
                value={reduction}
                onChange={(event) => setReduction(Number(event.target.value))}
                className="h-11 accent-primary"
                disabled={cash.dailyVariableCents === 0}
                aria-valuetext={`${reduction}%, ${formatCurrency(scenario.reductionMonthlyCents)} por mês`}
              />
              <output
                htmlFor="forecast-reduction"
                className="text-sm font-medium text-primary tabular-nums"
              >
                +{formatCurrency(scenario.reductionMonthlyCents)}/mês
              </output>
            </Field>
            <Field data-invalid={invalid}>
              <FieldLabel htmlFor="forecast-extra">
                Entradas extras por mês · R$
              </FieldLabel>
              <Input
                id="forecast-extra"
                inputMode="decimal"
                placeholder="0,00"
                value={extra}
                onChange={(event) => setExtra(event.target.value)}
                aria-invalid={invalid}
                aria-describedby={invalid ? 'forecast-extra-error' : undefined}
              />
              {invalid && (
                <p
                  id="forecast-extra-error"
                  className="text-sm text-destructive"
                >
                  Informe um valor entre 0 e 1.000.000,00.
                </p>
              )}
            </Field>
          </FieldGroup>
          {changed && (
            <div className="mt-5" aria-live="polite" aria-atomic="true">
              <Progress
                max={1}
                value={
                  scenario.requiredMonthlyCents > 0
                    ? Math.min(
                        1,
                        scenario.improvementMonthlyCents /
                          scenario.requiredMonthlyCents,
                      )
                    : 1
                }
                aria-label="Melhora necessária coberta pela simulação"
              />
              <p className="mt-3 flex items-start gap-2 text-sm">
                <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" />
                <span>
                  {scenario.remainingMonthlyCents > 0 ? (
                    <>
                      Ainda faltam{' '}
                      <strong>
                        {formatCurrency(scenario.remainingMonthlyCents)}/mês
                      </strong>{' '}
                      para a meta.
                    </>
                  ) : (
                    'Meta coberta na simulação.'
                  )}
                </span>
              </p>
              <dl className="mt-4 grid grid-cols-2 gap-4">
                <ForecastMetric
                  label="Menor saldo com ajustes"
                  cents={scenario.simulatedMinimum.balanceCents}
                  detail={formatShortDate(scenario.simulatedMinimum.date)}
                />
                <ForecastMetric
                  label={`Com ajustes em ${days} dias`}
                  cents={scenario.simulatedEndingCents}
                />
              </dl>
            </div>
          )}
          {changed && (
            <Button
              variant="ghost"
              className="mt-3 min-h-11"
              onClick={() => {
                setReduction(0)
                setExtra('')
              }}
            >
              Limpar simulação
            </Button>
          )}
        </section>
        <section
          aria-labelledby="priorities-title"
          className="min-w-0 rounded-xl border bg-card p-panel shadow-xs"
        >
          <h2 id="priorities-title" className="text-lg font-semibold">
            Onde atacar primeiro
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {formatMonth(month.month)}
          </p>
          <div className="mt-5 flex flex-col gap-5">
            {month.expenses
              .filter((bucket) => bucket.targetCents !== null)
              .map((bucket) => {
                const target = bucket.targetCents ?? 0
                const excess = Math.max(0, bucket.cents - target)
                return (
                  <div key={bucket.bucket}>
                    <div className="flex items-baseline justify-between gap-3 text-sm">
                      <h3 className="font-medium">
                        {bucket.bucket === 'essential'
                          ? 'Essenciais'
                          : 'Estilo de vida'}
                      </h3>
                      <span
                        className={cn(
                          'text-right tabular-nums',
                          excess > 0 && 'text-destructive',
                        )}
                      >
                        {excess > 0
                          ? `${formatCurrency(excess)} acima`
                          : `${formatCurrency(target - bucket.cents)} até o limite`}
                      </span>
                    </div>
                    <div className="mt-2">
                      <Progress
                        max={1}
                        value={
                          target > 0
                            ? Math.min(1, bucket.cents / target)
                            : bucket.cents > 0
                              ? 1
                              : 0
                        }
                        aria-label={`${bucket.bucket === 'essential' ? 'Essenciais' : 'Estilo de vida'}: ${formatCurrency(bucket.cents)} de ${formatCurrency(target)}`}
                      />
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formatCurrency(bucket.cents)} comprometidos de{' '}
                      {formatCurrency(target)}
                    </p>
                  </div>
                )
              })}
            <p className="text-sm">
              <strong>{formatCurrency(month.savingsRemainingCents)}</strong>{' '}
              ainda faltam para os aportes do mês.
            </p>
            <Link
              className={buttonVariants({ variant: 'outline' })}
              to="/configuracoes"
              search={{ tab: 'orcamento' }}
            >
              Ajustar orçamento e metas <ArrowRight data-icon="inline-end" />
            </Link>
          </div>
          <h3 className="mt-7 text-sm font-medium">Revisar gastos · 30 dias</h3>
          {view.categories30.items
            .filter((item) => !item.folded && item.cents > 0)
            .slice(0, 4)
            .map((category) => (
              <Link
                key={category.id}
                to="/transacoes"
                search={{ category: category.id, direction: 'out' }}
                className="mt-3 flex min-h-11 items-center gap-3 rounded-lg py-1 focus-visible:outline-2 focus-visible:outline-ring"
              >
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: category.color }}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">
                    {category.name}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {view.comparisonReady.categories && category.deltaCents > 0
                      ? `${formatCurrency(category.deltaCents)} acima da média`
                      : `${category.count} ${category.count === 1 ? 'lançamento' : 'lançamentos'}`}
                  </span>
                </span>
                <span className="text-sm font-semibold tabular-nums">
                  {formatCurrency(category.cents)}
                </span>
                <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
              </Link>
            ))}
          {view.categories30.totalCents === 0 && (
            <p className="mt-3 text-sm text-muted-foreground">
              Classifique os gastos para encontrar categorias a revisar.
            </p>
          )}
          {view.last30.uncategorizedCents > 0 && (
            <Link
              to="/transacoes"
              search={{ category: 'uncategorized' }}
              className="mt-4 block text-sm underline underline-offset-4"
            >
              Classificar {formatCurrency(view.last30.uncategorizedCents)} em
              saídas
            </Link>
          )}
        </section>
      </div>
      <details className="group min-w-0 rounded-xl border bg-card p-panel shadow-xs">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 font-medium">
          Premissas · {days} dias
          <ChevronDown className="size-4 group-open:rotate-180" />
        </summary>
        <p className="mt-4 text-sm text-muted-foreground">
          Saldos antes de novos aportes. Compras no cartão reduzem o disponível
          desde a compra. Entradas e consumo histórico são estimados.
        </p>
        <p className="mt-3 text-sm text-muted-foreground">
          A simulação não salva alterações. Distribui os ajustes diariamente a
          partir de amanhã e mantém a meta mensal atual. As datas reais das
          entradas podem mudar o saldo mínimo.
        </p>
        <dl className="mt-4 flex flex-col gap-3 text-sm">
          <MoneyRow label="Entradas previstas / mês" cents={monthlyIncome} />
          <MoneyRow label="Saídas previstas / mês" cents={-monthlyExpenses} />
          <MoneyRow label="Caixa inicial" cents={startingCents} />
          <MoneyRow
            label="Entradas estimadas"
            cents={cash.assumptions.estimatedIncomeCents}
          />
          <MoneyRow
            label="Faturas fechadas"
            cents={-cash.assumptions.closedCardCents}
          />
          <MoneyRow
            label="Parcelas conhecidas"
            cents={-cash.assumptions.scheduledCardCents}
          />
          <MoneyRow
            label="Outros valores de cartão estimados"
            cents={-cash.assumptions.estimatedCardCents}
          />
          <MoneyRow
            label="Recorrências estimadas"
            cents={-cash.assumptions.estimatedRecurrenceCents}
          />
          <MoneyRow
            label="Repetição do consumo histórico"
            cents={-cash.assumptions.historicalEstimateCents}
          />
          <MoneyRow label="Saldo final previsto" cents={scenario.endingCents} />
        </dl>
        {cash.recurringEstimateTransactionIds.length > 0 && (
          <p className="mt-4 text-xs text-muted-foreground">
            {cash.recurringEstimateTransactionIds.length} pagamentos históricos
            descontados da média para evitar duplicidade.
          </p>
        )}
        {cash.observedAdvancePayments.length > 0 && (
          <div className="mt-5">
            <h3 className="text-sm font-medium">
              Pagamentos antecipados já descontados
            </h3>
            <ul className="mt-2 flex flex-col gap-2 text-sm">
              {cash.observedAdvancePayments.map((payment) => (
                <li key={payment.occurrenceId}>
                  {payment.name} · {formatCurrency(payment.cents)} pagos em{' '}
                  {formatShortDate(payment.paidDate)}, vencimento em{' '}
                  {formatShortDate(payment.dueDate)}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-muted-foreground">
              Vínculos ainda pendentes de confirmação.
            </p>
          </div>
        )}
        {cash.largestHistoricalExpenses.length > 0 && (
          <>
            <h3 className="mt-6 text-sm font-medium">
              Estes pagamentos vão se repetir?
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Maiores valores dos últimos 60 dias incluídos na média. Repetição
              ainda não confirmada.
            </p>
            <ul className="mt-3 flex flex-col gap-3">
              {cash.largestHistoricalExpenses.map((expense) => (
                <li
                  key={expense.id}
                  className="flex flex-col justify-between gap-1 text-sm sm:flex-row sm:gap-4"
                >
                  <Link
                    className="min-w-0 break-words underline underline-offset-4"
                    to="/transacoes"
                    search={{ search: expense.description.slice(0, 200) }}
                  >
                    {expense.description}
                  </Link>
                  <span className="shrink-0 text-muted-foreground">
                    {formatCurrency(expense.cents)} ·{' '}
                    {formatShortDate(expense.date)}
                  </span>
                </li>
              ))}
            </ul>
            <Link
              to="/configuracoes"
              search={{ tab: 'recorrencias' }}
              className={cn(buttonVariants({ variant: 'outline' }), 'mt-5')}
            >
              Revisar recorrências <ArrowRight data-icon="inline-end" />
            </Link>
          </>
        )}
      </details>
    </div>
  )
}

function MoneyRow({ label, cents }: { label: string; cents: number }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt>{label}</dt>
      <dd className="shrink-0 font-medium tabular-nums">
        {formatCurrency(cents)}
      </dd>
    </div>
  )
}

function ForecastMetric({
  label,
  cents,
  detail,
}: {
  label: string
  cents: number
  detail?: string
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          'mt-1 text-lg font-semibold tracking-tight tabular-nums sm:text-xl',
          cents < 0 && 'text-destructive',
        )}
      >
        {formatCurrency(cents)}
      </dd>
      {detail && (
        <dd className="mt-1 text-xs text-muted-foreground">{detail}</dd>
      )}
    </div>
  )
}
