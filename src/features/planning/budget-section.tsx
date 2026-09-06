import { Check, PiggyBank, Plus, Target } from 'lucide-react'
import { Link } from '@tanstack/react-router'
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
import { Field, FieldGroup, FieldLabel } from '#/components/ui/field'
import { Input } from '#/components/ui/input'
import { NativeSelect, NativeSelectOption } from '#/components/ui/native-select'
import { Spinner } from '#/components/ui/spinner'
import { Switch } from '#/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '#/components/ui/toggle-group'
import { formatCurrency } from '#/domain/currency'
import { percentFromBps, strategyPresets } from '#/domain/finance'
import { formatMonthLong as formatMonth } from '#/domain/period'
import {
  StrategyHistory,
  StrategyProgressView,
} from '#/features/finance/strategy-progress'
import type { PlanningSnapshot } from '#/features/finance/snapshot.types'

type Allocation = Record<
  'essential' | 'lifestyle' | 'investment' | 'reserve',
  number
>

function BudgetSection({
  data,
  selectedId,
  allocation,
  totalBps,
  closed,
  pendingCount,
  selectStrategy,
  setAllocation,
  submitIncome,
  saveStrategy,
  closeMonth,
  strategyPending,
  settingsPending,
  closePending,
}: {
  data: PlanningSnapshot
  selectedId: string
  allocation: Allocation
  totalBps: number
  closed: boolean
  pendingCount: number
  selectStrategy: (id: string) => void
  setAllocation: React.Dispatch<React.SetStateAction<Allocation>>
  submitIncome: (event: React.FormEvent<HTMLFormElement>) => void
  saveStrategy: () => void
  closeMonth: () => void
  strategyPending: boolean
  settingsPending: boolean
  closePending: boolean
}) {
  return (
    <div className="grid gap-4">
      <Panel
        title="Base do orçamento"
        description="Valor mensal usado para calcular os envelopes."
      >
        <form
          onSubmit={submitIncome}
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
        >
          <Field className="max-w-sm flex-1">
            <FieldLabel>Renda mensal de referência</FieldLabel>
            <Input
              name="income"
              defaultValue={(data.settings.monthlyIncomeTargetCents / 100)
                .toFixed(2)
                .replace('.', ',')}
              required
            />
          </Field>
          <Button type="submit" variant="outline" disabled={settingsPending}>
            {settingsPending && <Spinner data-icon="inline-start" />}
            Salvar base
          </Button>
        </form>
      </Panel>

      <Panel
        title="Estratégia do mês"
        description={`Base atual: ${formatCurrency(data.dashboard.baseIncomeCents)}.`}
      >
        <NativeSelect
          value={selectedId}
          onChange={(event) => selectStrategy(event.target.value)}
          className="w-full md:hidden"
          aria-label="Selecionar estratégia"
        >
          {data.strategies.map((strategy) => (
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
          {data.strategies.map((strategy) => {
            const preset = strategyPresets[strategy.template]
            return (
              <ToggleGroupItem
                key={strategy.id}
                value={strategy.id}
                variant="outline"
                className="h-auto min-h-28 w-full min-w-0 shrink flex-col items-start justify-start overflow-hidden p-4 text-left whitespace-normal"
              >
                <strong className="w-full leading-snug">{strategy.name}</strong>
                <span className="w-full flex-1 text-pretty text-xs leading-relaxed font-normal text-muted-foreground">
                  {preset.description}
                </span>
                <span className="mt-2 w-full text-xs leading-none tabular-nums">
                  {percentFromBps(strategy.essentialBps)} ·{' '}
                  {percentFromBps(strategy.lifestyleBps)} ·{' '}
                  {percentFromBps(strategy.investmentBps)} ·{' '}
                  {percentFromBps(strategy.reserveBps)}
                </span>
              </ToggleGroupItem>
            )
          })}
        </ToggleGroup>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {(['essential', 'lifestyle', 'investment', 'reserve'] as const).map(
            (bucket) => (
              <Field key={bucket}>
                <FieldLabel htmlFor={`allocation-${bucket}`}>
                  {bucket === 'essential'
                    ? 'Essenciais'
                    : bucket === 'lifestyle'
                      ? 'Estilo de vida'
                      : bucket === 'investment'
                        ? 'Investimentos'
                        : 'Reserva'}{' '}
                  (%)
                </FieldLabel>
                <Input
                  id={`allocation-${bucket}`}
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  value={allocation[bucket] / 100}
                  onChange={(event) =>
                    setAllocation((current) => ({
                      ...current,
                      [bucket]: Math.round(Number(event.target.value) * 100),
                    }))
                  }
                />
              </Field>
            ),
          )}
        </div>
        {totalBps !== 10_000 && (
          <p className="mt-3 text-sm text-destructive">
            A soma atual é {percentFromBps(totalBps)}. Ajuste para 100%.
          </p>
        )}
        <Button
          className="mt-4"
          onClick={saveStrategy}
          disabled={strategyPending || totalBps !== 10_000}
        >
          {strategyPending && <Spinner data-icon="inline-start" />}
          Salvar estratégia
        </Button>
      </Panel>

      <Panel
        title="Acompanhamento da estratégia"
        description="Compromissos por vencimento e consumo pelas datas dos lançamentos."
      >
        <StrategyProgressView dashboard={data.dashboard} />
        <h3 className="mt-6 mb-2 text-sm font-semibold">Meses anteriores</h3>
        <StrategyHistory />
      </Panel>

      <Panel
        title={`Fechamento de ${formatMonth(data.dashboard.currentMonth).toLocaleLowerCase('pt-BR')}`}
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
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">
              Revise importações e conciliações antes de fechar.
            </p>
            {data.dashboard.reviewTransactionCount > 0 ? (
              <Button
                nativeButton={false}
                variant="outline"
                render={<Link to="/importar" search={{ view: 'review' }} />}
              >
                Revisar importação
              </Button>
            ) : (
              <Button
                nativeButton={false}
                variant="outline"
                render={<Link to="/transacoes" />}
              >
                Revisar conciliações
              </Button>
            )}
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
                  {formatMonth(data.dashboard.currentMonth).toLocaleLowerCase(
                    'pt-BR',
                  )}
                  ?
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
    </div>
  )
}

function GoalsSection({
  data,
  submitReserve,
  settingsPending,
  openGoal,
  openContribution,
}: {
  data: PlanningSnapshot
  submitReserve: (event: React.FormEvent<HTMLFormElement>) => void
  settingsPending: boolean
  openGoal: () => void
  openContribution: () => void
}) {
  return (
    <div className="grid gap-4">
      <Panel
        title="Metas financeiras"
        description="Objetivos com valor, progresso e prazo."
        action={
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={openContribution}
              disabled={!data.goals.length}
            >
              <PiggyBank data-icon="inline-start" />
              <span className="hidden sm:inline">Registrar aporte</span>
              <span className="sm:hidden">Aporte</span>
            </Button>
            <Button onClick={openGoal}>
              <Plus data-icon="inline-start" />
              Nova meta
            </Button>
          </div>
        }
      >
        {data.goals.length ? (
          <div className="divide-y rounded-lg border">
            {data.goals.map((goal) => {
              const target =
                goal.type === 'emergency_reserve' && !goal.targetCents
                  ? data.dashboard.reserve.targetCents
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

      <Panel
        title="Reserva de emergência"
        description="Defina o alvo a partir dos meses de despesas essenciais."
      >
        <form onSubmit={submitReserve}>
          <div className="grid gap-4 sm:grid-cols-[minmax(0,240px)_1fr] sm:items-end">
            <Field>
              <FieldLabel>Meses de despesas essenciais</FieldLabel>
              <Input
                name="reserveMonths"
                type="number"
                min="1"
                max="36"
                defaultValue={data.settings.reserveMonths}
                required
              />
            </Field>
            <label className="flex min-h-11 items-center gap-3 rounded-lg border px-3 text-sm">
              <Switch
                name="keepReserveContributions"
                defaultChecked={data.settings.keepReserveContributions}
              />
              Continuar aportes após atingir o alvo
            </label>
          </div>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">
              Alvo atual: {formatCurrency(data.dashboard.reserve.targetCents)}
            </p>
            <Button type="submit" variant="outline" disabled={settingsPending}>
              Salvar reserva
            </Button>
          </div>
        </form>
      </Panel>
    </div>
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
            <div className="grid gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel>Valor-alvo</FieldLabel>
                <Input name="target" placeholder="100.000,00" required />
              </Field>
              <Field>
                <FieldLabel>Saldo atual</FieldLabel>
                <Input name="current" defaultValue="0,00" />
              </Field>
            </div>
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

function ContributionDialog({
  open,
  onOpenChange,
  data,
  onSubmit,
  pending,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  data: PlanningSnapshot
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void
  pending: boolean
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Registrar aporte</DialogTitle>
          <DialogDescription>
            Adicione um valor ao progresso de uma meta.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit}>
          <FieldGroup>
            <Field>
              <FieldLabel>Meta</FieldLabel>
              <NativeSelect name="goalId" className="w-full" required>
                {data.goals.map((goal) => (
                  <NativeSelectOption key={goal.id} value={goal.id}>
                    {goal.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel>Valor</FieldLabel>
                <Input name="amount" required />
              </Field>
              <Field>
                <FieldLabel>Data</FieldLabel>
                <Input
                  name="date"
                  type="date"
                  defaultValue={new Date().toISOString().slice(0, 10)}
                  required
                />
              </Field>
            </div>
            <Field>
              <FieldLabel>Observação</FieldLabel>
              <Input name="notes" />
            </Field>
          </FieldGroup>
          <DialogFooter className="mt-4">
            <Button type="submit" disabled={pending}>
              {pending && <Spinner data-icon="inline-start" />}
              Registrar aporte
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export { BudgetSection, ContributionDialog, GoalDialog, GoalsSection }
export type { Allocation }
