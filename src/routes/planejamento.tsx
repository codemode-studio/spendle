import {
  CalendarClock,
  Check,
  Pause,
  Pencil,
  PiggyBank,
  Play,
  Plus,
  Target,
  Trash2,
} from 'lucide-react'
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'

import {
  EmptyState,
  PageHeader,
  Panel,
  ProgressBar,
  StatusBadge,
} from '#/components/ui'
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '#/components/ui/tabs'
import { ToggleGroup, ToggleGroupItem } from '#/components/ui/toggle-group'
import {
  formatCurrency,
  formatInstrumentName,
  formatMinorUnitsForInput,
  parseCurrency,
  percentFromBps,
  strategyPresets,
  toCents,
} from '#/domain/finance'
import {
  activateStrategyFn,
  addGoalContributionFn,
  closeCurrentBudgetFn,
  createRecurrenceFn,
  deleteRecurrenceFn,
  saveGoalFn,
  setRecurrenceActiveFn,
  updateRecurrenceFn,
  updateSettingsFn,
} from '#/features/finance/finance.functions'
import type { getFinanceSnapshot } from '#/features/finance/finance.server'
import {
  financeQueryKeys,
  financeSnapshotOptions,
} from '#/features/finance/queries'

type Snapshot = Awaited<ReturnType<typeof getFinanceSnapshot>>
type Allocation = Record<
  'essential' | 'lifestyle' | 'investment' | 'reserve',
  number
>

const planningSearchSchema = z.object({
  section: z
    .enum(['budget', 'goals', 'recurrences'])
    .optional()
    .catch(undefined),
})

export const Route = createFileRoute('/planejamento')({
  validateSearch: planningSearchSchema,
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(financeSnapshotOptions()),
  component: PlanningPage,
})

function formatMonth(month: string) {
  const label = new Intl.DateTimeFormat('pt-BR', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${month}-01T12:00:00Z`))
  return label.charAt(0).toUpperCase() + label.slice(1)
}

function PlanningPage() {
  const { section } = Route.useSearch()
  const navigate = Route.useNavigate()
  const activeSection = section ?? 'budget'
  const { data } = useSuspenseQuery(financeSnapshotOptions())
  const queryClient = useQueryClient()
  const activateStrategy = useServerFn(activateStrategyFn)
  const updateSettings = useServerFn(updateSettingsFn)
  const saveGoal = useServerFn(saveGoalFn)
  const addContribution = useServerFn(addGoalContributionFn)
  const closeBudget = useServerFn(closeCurrentBudgetFn)
  const createRecurrence = useServerFn(createRecurrenceFn)
  const updateRecurrence = useServerFn(updateRecurrenceFn)
  const setRecurrenceActive = useServerFn(setRecurrenceActiveFn)
  const deleteRecurrence = useServerFn(deleteRecurrenceFn)
  const [selectedId, setSelectedId] = useState(data.dashboard.activeStrategy.id)
  const selected =
    data.strategies.find((strategy) => strategy.id === selectedId) ??
    data.dashboard.activeStrategy
  const [allocation, setAllocation] = useState<Allocation>({
    essential: selected.essentialBps,
    lifestyle: selected.lifestyleBps,
    investment: selected.investmentBps,
    reserve: selected.reserveBps,
  })
  const [goalOpen, setGoalOpen] = useState(false)
  const [contributionOpen, setContributionOpen] = useState(false)
  const [recurrenceOpen, setRecurrenceOpen] = useState(false)
  const [editingRecurrenceId, setEditingRecurrenceId] = useState<string | null>(
    null,
  )
  const [deletingRecurrenceId, setDeletingRecurrenceId] = useState<
    string | null
  >(null)
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: financeQueryKeys.all })

  const strategyMutation = useMutation({
    mutationFn: activateStrategy,
    onSuccess: () => {
      toast.success('Estratégia atualizada.')
      void invalidate()
    },
    onError: showError,
  })
  const settingsMutation = useMutation({
    mutationFn: updateSettings,
    onSuccess: () => {
      toast.success('Planejamento atualizado.')
      void invalidate()
    },
    onError: showError,
  })
  const goalMutation = useMutation({
    mutationFn: saveGoal,
    onSuccess: () => {
      toast.success('Meta salva.')
      setGoalOpen(false)
      void invalidate()
    },
    onError: showError,
  })
  const contributionMutation = useMutation({
    mutationFn: addContribution,
    onSuccess: () => {
      toast.success('Aporte registrado.')
      setContributionOpen(false)
      void invalidate()
    },
    onError: showError,
  })
  const closeMutation = useMutation({
    mutationFn: closeBudget,
    onSuccess: (result) => {
      toast.success(
        result.alreadyClosed
          ? `${formatMonth(result.month)} já estava fechado.`
          : `${formatMonth(result.month)} foi fechado.`,
      )
      void invalidate()
    },
    onError: showError,
  })
  const createRecurrenceMutation = useMutation({
    mutationFn: createRecurrence,
    onSuccess: () => {
      toast.success('Recorrência criada.')
      closeRecurrenceDialog()
      void invalidate()
    },
    onError: showError,
  })
  const updateRecurrenceMutation = useMutation({
    mutationFn: updateRecurrence,
    onSuccess: () => {
      toast.success('Recorrência atualizada.')
      closeRecurrenceDialog()
      void invalidate()
    },
    onError: showError,
  })
  const recurrenceStatusMutation = useMutation({
    mutationFn: setRecurrenceActive,
    onSuccess: (_, variables) => {
      toast.success(
        variables.data.active
          ? 'Recorrência retomada.'
          : 'Recorrência pausada.',
      )
      void invalidate()
    },
    onError: showError,
  })
  const deleteRecurrenceMutation = useMutation({
    mutationFn: deleteRecurrence,
    onSuccess: () => {
      toast.success('Recorrência excluída.')
      setDeletingRecurrenceId(null)
      void invalidate()
    },
    onError: showError,
  })

  function showError(error: unknown) {
    toast.error(
      error instanceof Error ? error.message : 'Não foi possível salvar.',
    )
  }

  function closeRecurrenceDialog() {
    setRecurrenceOpen(false)
    setEditingRecurrenceId(null)
  }

  function selectStrategy(id: string) {
    const strategy = data.strategies.find((item) => item.id === id)
    if (!strategy) return
    setSelectedId(id)
    setAllocation({
      essential: strategy.essentialBps,
      lifestyle: strategy.lifestyleBps,
      investment: strategy.investmentBps,
      reserve: strategy.reserveBps,
    })
  }

  function submitIncome(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    settingsMutation.mutate({
      data: {
        monthlyIncomeTargetCents: toCents(String(form.get('income'))),
        reserveMonths: data.settings.reserveMonths,
        keepReserveContributions: data.settings.keepReserveContributions,
        aiClassificationConsent: data.settings.aiClassificationConsent,
      },
    })
  }

  function submitReserve(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    settingsMutation.mutate({
      data: {
        monthlyIncomeTargetCents: data.settings.monthlyIncomeTargetCents,
        reserveMonths: Number(form.get('reserveMonths')),
        keepReserveContributions: form.get('keepReserveContributions') === 'on',
        aiClassificationConsent: data.settings.aiClassificationConsent,
      },
    })
  }

  function submitGoal(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    goalMutation.mutate({
      data: {
        name: String(form.get('name')),
        type: String(form.get('type')) as
          'emergency_reserve' | 'medium_term' | 'retirement' | 'other',
        targetCents: toCents(String(form.get('target'))),
        currentCents: toCents(String(form.get('current') || '0')),
        targetDate: String(form.get('targetDate') || '') || undefined,
      },
    })
  }

  function submitContribution(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    contributionMutation.mutate({
      data: {
        goalId: String(form.get('goalId')),
        amountCents: toCents(String(form.get('amount'))),
        contributedAt: String(form.get('date')),
        notes: String(form.get('notes') || '') || undefined,
      },
    })
  }

  function submitRecurrence(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const [kind, id] = String(form.get('destination')).split(':')
    const destination =
      kind === 'account'
        ? data.accounts.find((account) => account.id === id)
        : data.cards.find((card) => card.id === id)
    const currency = parseCurrency(destination?.currency ?? 'BRL')
    const values = {
      name: String(form.get('name')),
      accountId: kind === 'account' ? id : undefined,
      creditCardId: kind === 'card' ? id : undefined,
      categoryId: String(form.get('categoryId') || '') || undefined,
      amountCents: toCents(String(form.get('amount')), currency),
      currency,
      frequency: String(form.get('frequency')) as 'monthly' | 'yearly',
      nextDate: String(form.get('nextDate')),
    }
    if (editingRecurrenceId) {
      updateRecurrenceMutation.mutate({
        data: { ...values, id: editingRecurrenceId },
      })
    } else {
      createRecurrenceMutation.mutate({ data: values })
    }
  }

  const totalBps = Object.values(allocation).reduce(
    (sum, value) => sum + value,
    0,
  )
  const currentBudget = data.monthlyBudgets.find(
    (budget) => budget.month === data.dashboard.currentMonth,
  )
  const pendingCount =
    data.dashboard.reviewTransactionCount + data.dashboard.reconciliationCount
  const editingRecurrence = data.recurrences.find(
    (item) => item.id === editingRecurrenceId,
  )

  return (
    <div className="page">
      <PageHeader
        eyebrow="Estratégia familiar"
        title="Planejamento"
        description="Defina o orçamento, acompanhe metas e organize recorrências."
      />
      <Tabs
        value={activeSection}
        onValueChange={(value) =>
          void navigate({
            search: {
              section: value as 'budget' | 'goals' | 'recurrences',
            },
          })
        }
        className="gap-6"
      >
        <TabsList
          variant="line"
          aria-label="Áreas do planejamento"
          className="h-9 w-full justify-start overflow-x-auto border-b px-0 pb-1"
        >
          <TabsTrigger value="budget" className="min-w-28 flex-none px-4">
            Orçamento
          </TabsTrigger>
          <TabsTrigger value="goals" className="min-w-28 flex-none px-4">
            Metas
          </TabsTrigger>
          <TabsTrigger value="recurrences" className="min-w-28 flex-none px-4">
            Recorrências
          </TabsTrigger>
        </TabsList>

        <TabsContent value="budget">
          <BudgetSection
            data={data}
            selectedId={selectedId}
            allocation={allocation}
            totalBps={totalBps}
            closed={Boolean(currentBudget?.closed)}
            pendingCount={pendingCount}
            selectStrategy={selectStrategy}
            setAllocation={setAllocation}
            submitIncome={submitIncome}
            saveStrategy={() =>
              strategyMutation.mutate({
                data: {
                  strategyId: selectedId,
                  essentialBps: allocation.essential,
                  lifestyleBps: allocation.lifestyle,
                  investmentBps: allocation.investment,
                  reserveBps: allocation.reserve,
                },
              })
            }
            closeMonth={() => closeMutation.mutate({})}
            strategyPending={strategyMutation.isPending}
            settingsPending={settingsMutation.isPending}
            closePending={closeMutation.isPending}
          />
        </TabsContent>
        <TabsContent value="goals">
          <GoalsSection
            data={data}
            submitReserve={submitReserve}
            settingsPending={settingsMutation.isPending}
            openGoal={() => setGoalOpen(true)}
            openContribution={() => setContributionOpen(true)}
          />
        </TabsContent>
        <TabsContent value="recurrences">
          <RecurrencesSection
            data={data}
            pending={recurrenceStatusMutation.isPending}
            openNew={() => {
              setEditingRecurrenceId(null)
              setRecurrenceOpen(true)
            }}
            openEdit={(id) => {
              setEditingRecurrenceId(id)
              setRecurrenceOpen(true)
            }}
            toggleActive={(id, active) =>
              recurrenceStatusMutation.mutate({ data: { id, active } })
            }
            requestDelete={setDeletingRecurrenceId}
          />
        </TabsContent>
      </Tabs>

      <GoalDialog
        open={goalOpen}
        onOpenChange={setGoalOpen}
        onSubmit={submitGoal}
        pending={goalMutation.isPending}
      />
      <ContributionDialog
        open={contributionOpen}
        onOpenChange={setContributionOpen}
        data={data}
        onSubmit={submitContribution}
        pending={contributionMutation.isPending}
      />
      <RecurrenceDialog
        key={editingRecurrenceId ?? 'new'}
        open={recurrenceOpen}
        onOpenChange={(open) =>
          open ? setRecurrenceOpen(true) : closeRecurrenceDialog()
        }
        data={data}
        recurrence={editingRecurrence}
        onSubmit={submitRecurrence}
        pending={
          createRecurrenceMutation.isPending ||
          updateRecurrenceMutation.isPending
        }
      />
      <AlertDialog
        open={Boolean(deletingRecurrenceId)}
        onOpenChange={(open) => !open && setDeletingRecurrenceId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir recorrência?</AlertDialogTitle>
            <AlertDialogDescription>
              A previsão será removida. Transações registradas não serão
              alteradas.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleteRecurrenceMutation.isPending}
              onClick={() =>
                deletingRecurrenceId &&
                deleteRecurrenceMutation.mutate({
                  data: { id: deletingRecurrenceId },
                })
              }
            >
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

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
  data: Snapshot
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
  data: Snapshot
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

function RecurrencesSection({
  data,
  pending,
  openNew,
  openEdit,
  toggleActive,
  requestDelete,
}: {
  data: Snapshot
  pending: boolean
  openNew: () => void
  openEdit: (id: string) => void
  toggleActive: (id: string, active: boolean) => void
  requestDelete: (id: string) => void
}) {
  const active = data.recurrences.filter((item) => item.active)
  const monthlyIncome = active.reduce(
    (sum, item) =>
      sum +
      (item.amountCents > 0
        ? item.amountCents / (item.frequency === 'yearly' ? 12 : 1)
        : 0),
    0,
  )
  const monthlyExpense = active.reduce(
    (sum, item) =>
      sum +
      (item.amountCents < 0
        ? Math.abs(item.amountCents) / (item.frequency === 'yearly' ? 12 : 1)
        : 0),
    0,
  )

  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Panel>
          <p className="text-xs text-muted-foreground">Receitas mensais</p>
          <strong className="mt-1 block text-lg tabular-nums text-success">
            {formatCurrency(monthlyIncome)}
          </strong>
        </Panel>
        <Panel>
          <p className="text-xs text-muted-foreground">Despesas mensais</p>
          <strong className="mt-1 block text-lg tabular-nums text-destructive">
            {formatCurrency(monthlyExpense)}
          </strong>
        </Panel>
        <Panel className="col-span-2 sm:col-span-1">
          <p className="text-xs text-muted-foreground">Recorrências ativas</p>
          <strong className="mt-1 block text-lg tabular-nums">
            {active.length}
          </strong>
        </Panel>
      </div>
      <Panel
        title="Receitas e despesas recorrentes"
        description="Compromissos previstos para os próximos meses."
        action={
          data.recurrences.length ? (
            <Button onClick={openNew}>
              <Plus data-icon="inline-start" />
              Nova recorrência
            </Button>
          ) : undefined
        }
      >
        {data.recurrences.length ? (
          <div className="divide-y rounded-lg border">
            {data.recurrences.map((item) => {
              const account = data.accounts.find(
                (candidate) => candidate.id === item.accountId,
              )
              const card = data.cards.find(
                (candidate) => candidate.id === item.creditCardId,
              )
              const category = data.categories.find(
                (candidate) => candidate.id === item.categoryId,
              )
              return (
                <div
                  key={item.id}
                  className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center lg:justify-between"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <strong className="truncate text-sm">{item.name}</strong>
                      <StatusBadge tone={item.active ? 'success' : 'neutral'}>
                        {item.active ? 'Ativa' : 'Pausada'}
                      </StatusBadge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formatInstrumentName(
                        account?.name ?? card?.name ?? 'Sem destino',
                      )}{' '}
                      · {category?.name ?? 'Sem categoria'} ·{' '}
                      {item.frequency === 'monthly' ? 'Mensal' : 'Anual'}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Próxima:{' '}
                      {new Date(`${item.nextDate}T12:00:00`).toLocaleDateString(
                        'pt-BR',
                      )}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <strong
                      className={
                        item.amountCents >= 0
                          ? 'mr-2 tabular-nums text-success'
                          : 'mr-2 tabular-nums text-destructive'
                      }
                    >
                      {formatCurrency(item.amountCents, item.currency)}
                    </strong>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => openEdit(item.id)}
                    >
                      <Pencil data-icon="inline-start" /> Editar
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={pending}
                      onClick={() => toggleActive(item.id, !item.active)}
                    >
                      {item.active ? (
                        <Pause data-icon="inline-start" />
                      ) : (
                        <Play data-icon="inline-start" />
                      )}
                      {item.active ? 'Pausar' : 'Retomar'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Excluir ${item.name}`}
                      onClick={() => requestDelete(item.id)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <EmptyState
            icon={CalendarClock}
            title="Nenhuma recorrência"
            description="Cadastre salários, assinaturas e outros compromissos previstos."
            action={<Button onClick={openNew}>Criar recorrência</Button>}
          />
        )}
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
  data: Snapshot
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

function RecurrenceDialog({
  open,
  onOpenChange,
  data,
  recurrence,
  onSubmit,
  pending,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  data: Snapshot
  recurrence: Snapshot['recurrences'][number] | undefined
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void
  pending: boolean
}) {
  const destination = recurrence?.accountId
    ? `account:${recurrence.accountId}`
    : recurrence?.creditCardId
      ? `card:${recurrence.creditCardId}`
      : ''
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {recurrence ? 'Editar recorrência' : 'Nova recorrência'}
          </DialogTitle>
          <DialogDescription>
            Registre uma receita ou despesa prevista.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit}>
          <FieldGroup>
            <Field>
              <FieldLabel>Nome</FieldLabel>
              <Input
                name="name"
                defaultValue={recurrence?.name}
                required
                autoFocus
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel>Valor</FieldLabel>
                <Input
                  name="amount"
                  defaultValue={
                    recurrence
                      ? formatMinorUnitsForInput(
                          recurrence.amountCents,
                          recurrence.currency,
                        )
                      : ''
                  }
                  placeholder="Use - para despesas"
                  required
                />
              </Field>
              <Field>
                <FieldLabel>Frequência</FieldLabel>
                <NativeSelect
                  name="frequency"
                  className="w-full"
                  defaultValue={recurrence?.frequency ?? 'monthly'}
                >
                  <NativeSelectOption value="monthly">
                    Mensal
                  </NativeSelectOption>
                  <NativeSelectOption value="yearly">Anual</NativeSelectOption>
                </NativeSelect>
              </Field>
            </div>
            <Field>
              <FieldLabel>Conta ou cartão</FieldLabel>
              <NativeSelect
                name="destination"
                className="w-full"
                defaultValue={destination}
                required
              >
                <NativeSelectOption value="">Selecione</NativeSelectOption>
                {data.accounts.map((account) => (
                  <NativeSelectOption
                    key={account.id}
                    value={`account:${account.id}`}
                  >
                    Conta · {formatInstrumentName(account.name)}
                  </NativeSelectOption>
                ))}
                {data.cards.map((card) => (
                  <NativeSelectOption key={card.id} value={`card:${card.id}`}>
                    Cartão · {formatInstrumentName(card.name)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel>Categoria</FieldLabel>
                <NativeSelect
                  name="categoryId"
                  className="w-full"
                  defaultValue={recurrence?.categoryId ?? ''}
                >
                  <NativeSelectOption value="">
                    Sem categoria
                  </NativeSelectOption>
                  {data.categories.map((category) => (
                    <NativeSelectOption key={category.id} value={category.id}>
                      {category.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel>Próxima data</FieldLabel>
                <Input
                  name="nextDate"
                  type="date"
                  defaultValue={
                    recurrence?.nextDate ??
                    new Date().toISOString().slice(0, 10)
                  }
                  required
                />
              </Field>
            </div>
          </FieldGroup>
          <DialogFooter className="mt-4">
            <Button type="submit" disabled={pending}>
              {pending && <Spinner data-icon="inline-start" />}
              Salvar recorrência
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
