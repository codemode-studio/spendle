import { ArrowRight, Check, Plus, Target } from 'lucide-react'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import type * as React from 'react'

import { EmptyState, Panel, ProgressBar, StatusBadge } from '#/components/ui'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '#/components/ui/alert-dialog'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '#/components/ui/field'
import { Input } from '#/components/ui/input'
import { NativeSelect, NativeSelectOption } from '#/components/ui/native-select'
import { Spinner } from '#/components/ui/spinner'
import { Switch } from '#/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '#/components/ui/toggle-group'
import {
  formatCurrency,
  formatMinorUnitsForInput,
  toMinorUnits as toCents,
} from '#/domain/currency'
import {
  allocationAmount,
  percentFromBps,
  strategyPresets,
} from '#/domain/finance'
import { formatMonthLong as formatMonth } from '#/domain/period'
import { transactionSearchDefaults } from '#/features/finance/transactions.search'
import type { PlanningData } from './types'
import { cn } from '#/lib/utils'
import { buildClosingIssuePresentations } from './closing-issues'
import type { ClosingIssueDestination } from './closing-issues'

type Allocation = Record<
  'essential' | 'lifestyle' | 'investment' | 'reserve',
  number
>

export interface PlanInput {
  monthlyIncomeTargetCents: number
  reserveMonths: number
  keepReserveContributions: boolean
}

const bucketLabels: Record<keyof Allocation, string> = {
  essential: 'Essenciais',
  lifestyle: 'Estilo de vida',
  investment: 'Investimentos',
  reserve: 'Reserva',
}
const bucketOrder = ['essential', 'lifestyle', 'investment', 'reserve'] as const

function parseIncome(value: string) {
  try {
    return toCents(value)
  } catch {
    return null
  }
}

/**
 * Um painel, um botão. Renda, estratégia e reserva são a mesma decisão:
 * quanto entra e para onde vai. A prévia em reais mostra o efeito na hora.
 */
function BudgetSection({
  data,
  selectedId,
  allocation,
  totalBps,
  selectStrategy,
  setAllocation,
  savePlan,
  planPending,
}: {
  data: PlanningData
  selectedId: string
  allocation: Allocation
  totalBps: number
  selectStrategy: (id: string) => void
  setAllocation: React.Dispatch<React.SetStateAction<Allocation>>
  savePlan: (input: PlanInput) => void
  planPending: boolean
}) {
  const [income, setIncome] = useState(
    formatMinorUnitsForInput(
      data.state.settings.monthlyIncomeTargetCents,
      'BRL',
    ),
  )
  const [reserveMonths, setReserveMonths] = useState(
    String(data.state.settings.reserveMonths),
  )
  const [keepContributions, setKeepContributions] = useState(
    data.state.settings.keepReserveContributions,
  )
  const incomeCents = parseIncome(income)
  const months = Number(reserveMonths)
  const selectedStrategy = data.state.strategies.find(
    (s) => s.id === selectedId,
  )
  const matchesPreset =
    selectedStrategy &&
    selectedStrategy.allocation.essential === allocation.essential &&
    selectedStrategy.allocation.lifestyle === allocation.lifestyle &&
    selectedStrategy.allocation.investment === allocation.investment &&
    selectedStrategy.allocation.reserve === allocation.reserve
  const emergencyGoal = data.state.goals.find(
    (goal) => goal.type === 'emergency_reserve' && goal.targetCents > 0,
  )
  const essentialCents =
    incomeCents === null
      ? null
      : allocationAmount(incomeCents, allocation.essential)
  const reserveTargetCents =
    essentialCents === null || !Number.isInteger(months)
      ? null
      : essentialCents * months
  // A closed month keeps its plan; changes wait for the next month.
  const frozen = data.month.closed
  const valid =
    !frozen &&
    incomeCents !== null &&
    incomeCents >= 0 &&
    totalBps === 10_000 &&
    Number.isInteger(months) &&
    months >= 1 &&
    months <= 36
  const baseDiffers =
    data.month.baseIncomeCents !== data.state.settings.monthlyIncomeTargetCents

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!valid) return
    savePlan({
      monthlyIncomeTargetCents: incomeCents,
      reserveMonths: months,
      keepReserveContributions: keepContributions,
    })
  }

  return (
    <Panel
      title="Seu plano"
      description="Quanto entra por mês e como esse valor se divide. Tudo aqui é salvo de uma vez."
      footer={
        <Button type="submit" form="plan-form" disabled={!valid || planPending}>
          {planPending && <Spinner data-icon="inline-start" />}
          Salvar plano
        </Button>
      }
    >
      <form id="plan-form" onSubmit={submit} className="grid gap-6">
        {frozen && (
          <p className="rounded-lg border bg-muted/40 px-3 py-2 text-sm">
            {formatMonth(data.month.month, { capitalize: true })} está fechado:
            o plano dele fica como foi. Ajustes valem a partir do próximo mês.
          </p>
        )}
        <Field className="max-w-sm">
          <FieldLabel htmlFor="plan-income">
            Renda mensal de referência
          </FieldLabel>
          <Input
            id="plan-income"
            inputMode="decimal"
            value={income}
            onChange={(event) => setIncome(event.target.value)}
            aria-invalid={incomeCents === null}
            required
          />
          <FieldDescription>
            {baseDiffers
              ? `Este mês o app usa ${formatCurrency(data.month.baseIncomeCents)}, a média conservadora dos últimos meses fechados.`
              : 'Use o valor líquido que costuma entrar. O app ajusta pela média quando houver meses fechados.'}
          </FieldDescription>
        </Field>

        <div className="grid gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <FieldLabel>Estratégia</FieldLabel>
            {!matchesPreset && (
              <StatusBadge tone="info">Personalizada</StatusBadge>
            )}
          </div>
          <NativeSelect
            value={selectedId}
            onChange={(event) => selectStrategy(event.target.value)}
            className="w-full md:hidden"
            aria-label="Selecionar estratégia"
          >
            {data.state.strategies.map((strategy) => (
              <NativeSelectOption key={strategy.id} value={strategy.id}>
                {strategy.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <ToggleGroup
            value={[selectedId]}
            onValueChange={(values) => values[0] && selectStrategy(values[0])}
            className="hidden w-full grid-cols-2 items-stretch md:grid xl:grid-cols-4"
            spacing={2}
          >
            {data.state.strategies.map((strategy) => {
              const preset = strategyPresets[strategy.template]
              return (
                <ToggleGroupItem
                  key={strategy.id}
                  value={strategy.id}
                  variant="outline"
                  className="h-auto min-h-24 w-full min-w-0 shrink flex-col items-start justify-start overflow-hidden p-3 text-left whitespace-normal"
                >
                  <strong className="w-full leading-snug">
                    {strategy.name}
                  </strong>
                  <span className="w-full flex-1 text-pretty text-xs leading-relaxed font-normal text-muted-foreground">
                    {preset.description}
                  </span>
                </ToggleGroupItem>
              )
            })}
          </ToggleGroup>
        </div>

        <div className="grid gap-2">
          <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
            {bucketOrder.map((bucket) => (
              <div
                key={bucket}
                className={cn(
                  'rounded-lg border p-3',
                  bucket === 'essential' && 'border-l-4 border-l-primary',
                )}
              >
                <p className="text-xs text-muted-foreground">
                  {bucketLabels[bucket]}
                </p>
                <p className="mt-1 text-sm font-medium tabular-nums">
                  {incomeCents === null
                    ? '—'
                    : formatCurrency(
                        allocationAmount(incomeCents, allocation[bucket]),
                      )}
                </p>
                <div className="mt-2 flex items-center gap-1">
                  <Input
                    aria-label={`${bucketLabels[bucket]} (%)`}
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    className="h-8 md:h-8"
                    value={allocation[bucket] / 100}
                    onChange={(event) =>
                      setAllocation((current) => ({
                        ...current,
                        [bucket]: Math.round(Number(event.target.value) * 100),
                      }))
                    }
                  />
                  <span className="text-xs text-muted-foreground">%</span>
                </div>
              </div>
            ))}
          </div>
          {totalBps !== 10_000 && (
            <p className="text-xs text-destructive">
              A soma está em {percentFromBps(totalBps)}. Ajuste para 100%.
            </p>
          )}
        </div>

        <div className="grid gap-3 border-t pt-5">
          <FieldLabel>Reserva de emergência</FieldLabel>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,200px)_1fr] sm:items-end">
            <Field>
              <FieldLabel
                htmlFor="plan-reserve-months"
                className="text-xs font-normal text-muted-foreground"
              >
                Meses de despesas essenciais
              </FieldLabel>
              <Input
                id="plan-reserve-months"
                type="number"
                min="1"
                max="36"
                value={reserveMonths}
                onChange={(event) => setReserveMonths(event.target.value)}
                required
              />
            </Field>
            <label className="flex h-11 items-center gap-3 rounded-lg border px-3 text-sm md:h-8">
              <Switch
                checked={keepContributions}
                onCheckedChange={setKeepContributions}
              />
              Continuar aportes após atingir o alvo
            </label>
          </div>
          <p className="text-sm text-muted-foreground">
            {emergencyGoal
              ? `Alvo definido na meta "${emergencyGoal.name}": ${formatCurrency(emergencyGoal.targetCents)}.`
              : reserveTargetCents === null || essentialCents === null
                ? 'Alvo calculado a partir dos meses e dos essenciais.'
                : `Alvo: ${formatCurrency(reserveTargetCents)} (${months} × ${formatCurrency(essentialCents)} de essenciais).`}
          </p>
        </div>
      </form>
    </Panel>
  )
}

function ClosingSection({
  data,
  closeMonth,
  closePending,
}: {
  data: PlanningData
  closeMonth: () => void
  closePending: boolean
}) {
  const closed = data.month.closed
  const pendingCount = data.month.integrity.closingBlockerCount
  const closingIssues = buildClosingIssuePresentations(
    data.month.integrity.issues,
    { month: data.month.month, book: data.book },
  )
  const closingIssueAction = (destination: ClosingIssueDestination) => {
    if (destination === 'accounts') {
      return <Link to="/configuracoes" search={{ tab: 'contas' }} />
    }
    if (destination === 'review') {
      return (
        <Link
          to="/transacoes"
          search={{ ...transactionSearchDefaults, category: 'review' }}
        />
      )
    }
    if (destination === 'recurrences') {
      return <Link to="/configuracoes" search={{ tab: 'recorrencias' }} />
    }
    if (destination === 'uncategorized') {
      return (
        <Link
          to="/transacoes"
          search={{
            ...transactionSearchDefaults,
            category: 'uncategorized',
          }}
        />
      )
    }
    return <Link to="/transacoes" search={transactionSearchDefaults} />
  }

  return (
    <Panel
      title={`Fechamento de ${formatMonth(data.month.month).toLocaleLowerCase('pt-BR')}`}
      description="Preserva o retrato do orçamento deste mês."
      action={
        <StatusBadge
          tone={closed ? 'success' : pendingCount ? 'warning' : 'info'}
        >
          {closed
            ? 'Fechado'
            : pendingCount
              ? `${pendingCount} pendências`
              : 'Pronto'}
        </StatusBadge>
      }
    >
      {closed ? (
        <p className="text-sm text-muted-foreground">
          Este mês já está fechado.
        </p>
      ) : pendingCount ? (
        <div className="grid gap-3">
          <p className="text-sm text-muted-foreground">
            Resolva os itens abaixo para liberar o fechamento.
          </p>
          <ul className="divide-y divide-border overflow-hidden rounded-lg border">
            {closingIssues.map((issue) => (
              <li
                key={issue.code}
                className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <StatusBadge tone="warning">{issue.count}</StatusBadge>
                    <span className="text-sm font-medium">{issue.label}</span>
                  </div>
                  {issue.detail && (
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      {issue.detail}
                    </p>
                  )}
                </div>
                <Button
                  nativeButton={false}
                  variant="outline"
                  size="sm"
                  className="w-full shrink-0 sm:w-auto"
                  aria-label={`${issue.actionLabel}: ${issue.label}`}
                  render={closingIssueAction(issue.destination)}
                >
                  {issue.actionLabel}
                  <ArrowRight data-icon="inline-end" />
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <AlertDialog>
          <AlertDialogTrigger render={<Button />}>
            <Check data-icon="inline-start" />
            Fechar mês
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Fechar{' '}
                {formatMonth(data.month.month).toLocaleLowerCase('pt-BR')}?
              </AlertDialogTitle>
              <AlertDialogDescription>
                O orçamento será preservado como concluído para consulta.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancelar</AlertDialogCancel>
              <AlertDialogAction onClick={closeMonth} disabled={closePending}>
                Fechar mês
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </Panel>
  )
}

function GoalsSection({
  data,
  openGoal,
}: {
  data: PlanningData
  openGoal: () => void
}) {
  return (
    <Panel
      title="Metas"
      description="A reserva de emergência usa o alvo do plano acima; outras metas têm valor próprio."
      action={
        <Button onClick={openGoal}>
          <Plus data-icon="inline-start" />
          Nova meta
        </Button>
      }
    >
      {data.state.goals.length ? (
        <div className="divide-y rounded-lg border">
          {data.state.goals.map((goal) => {
            const target =
              goal.type === 'emergency_reserve' && !goal.targetCents
                ? data.month.reserve.targetCents
                : goal.targetCents
            return (
              <div key={goal.id} className="p-4">
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div>
                    <strong className="text-sm">{goal.name}</strong>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {goal.targetDate
                        ? `Prazo: ${new Date(`${goal.targetDate}T12:00:00`).toLocaleDateString('pt-BR')}`
                        : 'Sem prazo definido'}
                    </p>
                  </div>
                  <Target className="size-4 text-primary" />
                </div>
                <ProgressBar value={goal.currentCents} max={target} />
                <div className="mt-2 flex justify-between text-xs text-muted-foreground">
                  <span>{formatCurrency(goal.currentCents)}</span>
                  <span>{formatCurrency(target)}</span>
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <EmptyState
          icon={Target}
          title="Nenhuma meta ainda"
          description="Crie uma meta para acompanhar o progresso."
          action={<Button onClick={openGoal}>Criar meta</Button>}
        />
      )}
    </Panel>
  )
}
function GoalDialog({
  open,
  onOpenChange,
  onSubmit,
  pending,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void
  pending: boolean
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nova meta</DialogTitle>
          <DialogDescription>
            Defina um valor e, se necessário, um prazo.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit}>
          <FieldGroup>
            <Field>
              <FieldLabel>Nome</FieldLabel>
              <Input name="name" required autoFocus />
            </Field>
            <Field>
              <FieldLabel>Tipo</FieldLabel>
              <NativeSelect name="type" className="w-full">
                <NativeSelectOption value="medium_term">
                  Médio prazo
                </NativeSelectOption>
                <NativeSelectOption value="retirement">
                  Aposentadoria
                </NativeSelectOption>
                <NativeSelectOption value="other">Outro</NativeSelectOption>
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel>Valor-alvo</FieldLabel>
              <Input name="target" placeholder="100.000,00" required />
            </Field>
            <Field>
              <FieldLabel>Prazo</FieldLabel>
              <Input name="targetDate" type="date" />
            </Field>
          </FieldGroup>
          <DialogFooter className="mt-4">
            <Button type="submit" disabled={pending}>
              {pending && <Spinner data-icon="inline-start" />}
              Criar meta
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export { BudgetSection, ClosingSection, GoalDialog, GoalsSection }
export type { Allocation }
