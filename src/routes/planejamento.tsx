import {
  ArrowDownLeft,
  ArrowUpRight,
  CalendarClock,
  Check,
  CircleOff,
  Link2,
  Pause,
  Pencil,
  PiggyBank,
  Play,
  Plus,
  Search,
  Sparkles,
  Target,
  Trash2,
  X,
} from 'lucide-react'
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'

import {
  EmptyState,
  PageHeader,
  Panel,
  ProgressBar,
  StatusBadge,
  Page,
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
import { CategorySelect } from '#/components/category-select'
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
import { Skeleton } from '#/components/ui/skeleton'
import { NativeSelect, NativeSelectOption } from '#/components/ui/native-select'
import { Spinner } from '#/components/ui/spinner'
import { Switch } from '#/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '#/components/ui/tabs'
import { ToggleGroup, ToggleGroupItem } from '#/components/ui/toggle-group'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '#/components/ui/tooltip'
import {
  formatCurrency,
  formatMinorUnitsForInput,
  parseCurrency,
  toMinorUnits as toCents,
} from '#/domain/currency'
import {
  formatInstrumentName,
  normalizeDescription,
  percentFromBps,
  strategyPresets,
} from '#/domain/finance'
import {
  formatMonthLong as formatMonth,
  formatShortDate as formatDate,
} from '#/domain/period'
import {
  describeRecurrence,
  isAcceptedRecurrenceMatchStatus,
  recurrenceLinkCandidateLimits,
} from '#/domain/recurrence-book'
import type { RecurrencePresentationStatus } from '#/domain/recurrence-book'
import {
  activateStrategyFn,
  addGoalContributionFn,
  approveDetectedRecurrenceFn,
  ignoreDetectedRecurrenceFn,
  closeCurrentBudgetFn,
  completeRecurrenceOccurrenceFn,
  confirmRecurrenceMatchFn,
  linkRecurrenceOccurrenceFn,
  createRecurrenceFn,
  deleteRecurrenceFn,
  refreshRecurrencesFn,
  rejectRecurrenceMatchFn,
  saveGoalFn,
  setRecurrenceActiveFn,
  skipRecurrenceOccurrenceFn,
  unlinkRecurrenceMatchFn,
  updateRecurrenceFn,
  updateSettingsFn,
} from '#/features/finance/finance.functions'
import type {
  detectRecurrencesFn,
  getFinanceSnapshotFn,
} from '#/features/finance/finance.functions'
import {
  StrategyHistory,
  StrategyProgressView,
} from '#/features/finance/strategy-progress'
import { cn } from '#/lib/utils'
import {
  financeQueryKeys,
  financeSnapshotOptions,
  recurrenceDetectionOptions,
  recurrenceLinkCandidatesOptions,
} from '#/features/finance/queries'

type Snapshot = Awaited<ReturnType<typeof getFinanceSnapshotFn>>
type DetectedRecurrence = Awaited<
  ReturnType<typeof detectRecurrencesFn>
>[number]
type DisplayRow =
  | {
      type: 'group'
      group: Snapshot['recurrenceGroups'][number]
      items: Snapshot['recurrences']
    }
  | { type: 'recurrence'; item: Snapshot['recurrences'][number] }
type Allocation = Record<
  'essential' | 'lifestyle' | 'investment' | 'reserve',
  number
>

function recurrenceStatusBadge(
  status: RecurrencePresentationStatus,
): { label: string; tone: 'info' | 'warning' | 'success' } | null {
  switch (status) {
    case 'in_progress':
      return { label: 'Em andamento', tone: 'info' }
    case 'suggested':
      return { label: 'Candidato encontrado', tone: 'warning' }
    case 'overdue':
      return { label: 'Atrasada', tone: 'warning' }
    case 'done':
      return { label: 'Realizada', tone: 'success' }
    case 'pending':
      return { label: 'Pendente', tone: 'info' }
    case 'paused':
      return null
  }
}

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
  const refreshRecurrences = useServerFn(refreshRecurrencesFn)
  const confirmRecurrenceMatch = useServerFn(confirmRecurrenceMatchFn)
  const rejectRecurrenceMatch = useServerFn(rejectRecurrenceMatchFn)
  const unlinkRecurrenceMatch = useServerFn(unlinkRecurrenceMatchFn)
  const skipRecurrenceOccurrence = useServerFn(skipRecurrenceOccurrenceFn)
  const linkRecurrenceOccurrence = useServerFn(linkRecurrenceOccurrenceFn)
  const completeRecurrenceOccurrence = useServerFn(
    completeRecurrenceOccurrenceFn,
  )
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
          ? `${formatMonth(result.month, { capitalize: true })} já estava fechado.`
          : `${formatMonth(result.month, { capitalize: true })} foi fechado.`,
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
  const refreshRecurrencesMutation = useMutation({
    mutationFn: refreshRecurrences,
    onSuccess: (result) => {
      const parts = [
        `${result.suggestionCount} nova(s) correspondência(s) para revisão`,
        result.autoConfirmCount
          ? `${result.autoConfirmCount} conciliada(s) automaticamente`
          : null,
      ].filter(Boolean)
      toast.success(`${parts.join(' · ')}.`)
      void invalidate()
    },
    onError: showError,
  })
  const confirmMatchMutation = useMutation({
    mutationFn: confirmRecurrenceMatch,
    onSuccess: () => {
      toast.success('Pagamento conciliado com a recorrência.')
      void invalidate()
    },
    onError: showError,
  })
  const rejectMatchMutation = useMutation({
    mutationFn: rejectRecurrenceMatch,
    onSuccess: () => {
      toast.success(
        'Correspondência rejeitada. O sistema vai considerar isso no histórico.',
      )
      void invalidate()
    },
    onError: showError,
  })
  const unlinkMatchMutation = useMutation({
    mutationFn: unlinkRecurrenceMatch,
    onSuccess: () => {
      toast.success('Pagamento desvinculado.')
      void invalidate()
    },
    onError: showError,
  })
  const skipOccurrenceMutation = useMutation({
    mutationFn: skipRecurrenceOccurrence,
    onSuccess: () => {
      toast.success('Ocorrência ignorada.')
      void invalidate()
    },
    onError: showError,
  })
  const linkOccurrenceMutation = useMutation({
    mutationFn: linkRecurrenceOccurrence,
    onSuccess: (result) => {
      toast.success(
        result.linked === 1
          ? 'Pagamento vinculado e conciliado.'
          : `${result.linked} lançamentos vinculados ao período.`,
      )
      void invalidate()
    },
    onError: showError,
  })
  const completeOccurrenceMutation = useMutation({
    mutationFn: completeRecurrenceOccurrence,
    onSuccess: () => {
      toast.success('Período concluído com o total real.')
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
    const destinationMode = String(form.get('destinationMode')) as
      'automatic' | 'fixed'
    const [kind, id] = String(form.get('destination') || '').split(':')
    const destination =
      kind === 'account'
        ? data.accounts.find((account) => account.id === id)
        : data.cards.find((card) => card.id === id)
    const currency = parseCurrency(
      destination?.currency ?? String(form.get('currency') || 'BRL'),
    )
    const values = {
      name: String(form.get('name')),
      groupName: String(form.get('groupName') || '') || undefined,
      participantLabel: String(form.get('participantLabel') || '') || undefined,
      accountId: kind === 'account' ? id : undefined,
      creditCardId: kind === 'card' ? id : undefined,
      categoryId: String(form.get('categoryId')),
      amountCents: Math.abs(toCents(String(form.get('amount')), currency)),
      currency,
      direction: String(form.get('direction')) as 'income' | 'expense',
      amountMode: String(form.get('amountMode')) as 'fixed' | 'variable',
      matchMode: String(form.get('matchMode') || 'single') as
        'single' | 'aggregate',
      destinationMode,
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
  const pendingCount = data.dashboard.integrity.closingBlockerCount
  const editingRecurrence = data.recurrences.find(
    (item) => item.id === editingRecurrenceId,
  )

  return (
    <Page>
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
          className="h-9 w-full justify-start overflow-x-auto overflow-y-hidden border-b px-0 pb-1"
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
            pending={
              recurrenceStatusMutation.isPending ||
              confirmMatchMutation.isPending ||
              rejectMatchMutation.isPending ||
              unlinkMatchMutation.isPending ||
              skipOccurrenceMutation.isPending ||
              linkOccurrenceMutation.isPending ||
              completeOccurrenceMutation.isPending
            }
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
            refresh={() => refreshRecurrencesMutation.mutate({})}
            confirmMatch={(matchId) =>
              confirmMatchMutation.mutate({ data: { matchId } })
            }
            rejectMatch={(matchId) =>
              rejectMatchMutation.mutate({ data: { matchId } })
            }
            unlinkMatch={(matchId) =>
              unlinkMatchMutation.mutate({ data: { matchId } })
            }
            skipOccurrence={(occurrenceId) =>
              skipOccurrenceMutation.mutate({ data: { occurrenceId } })
            }
            linkOccurrence={(occurrenceId, transactionIds) =>
              linkOccurrenceMutation.mutate({
                data: { occurrenceId, transactionIds },
              })
            }
            completeOccurrence={(occurrenceId) =>
              completeOccurrenceMutation.mutate({ data: { occurrenceId } })
            }
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
    </Page>
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
        title="Acompanhamento da estratégia"
        description="Metas de cada envelope contra o que já foi gasto ou aportado."
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
  refresh,
  confirmMatch,
  rejectMatch,
  unlinkMatch,
  skipOccurrence,
  linkOccurrence,
  completeOccurrence,
}: {
  data: Snapshot
  pending: boolean
  openNew: () => void
  openEdit: (id: string) => void
  toggleActive: (id: string, active: boolean) => void
  requestDelete: (id: string) => void
  refresh: () => void
  confirmMatch: (matchId: string) => void
  rejectMatch: (matchId: string) => void
  unlinkMatch: (matchId: string) => void
  skipOccurrence: (occurrenceId: string) => void
  linkOccurrence: (occurrenceId: string, transactionIds: string[]) => void
  completeOccurrence: (occurrenceId: string) => void
}) {
  const [linkRecurrenceId, setLinkRecurrenceId] = useState<string | null>(null)
  const active = data.recurrences.filter((item) => item.active)
  const missingConversionCount = active.filter(
    (item) => item.amountCents !== 0 && item.baseAmountCents === null,
  ).length
  const monthlyIncome = active.reduce(
    (sum, item) =>
      sum +
      (item.direction === 'income' && item.baseAmountCents !== null
        ? item.baseAmountCents / (item.frequency === 'yearly' ? 12 : 1)
        : 0),
    0,
  )
  const monthlyExpense = active.reduce(
    (sum, item) =>
      sum +
      (item.direction === 'expense' && item.baseAmountCents !== null
        ? item.baseAmountCents / (item.frequency === 'yearly' ? 12 : 1)
        : 0),
    0,
  )
  // Receitas e despesas ficam em listas separadas; um grupo aparece na lista
  // de cada direção em que tiver recorrências.
  const rowsFor = (direction: 'income' | 'expense'): DisplayRow[] => {
    const recurrences = data.recurrences.filter(
      (item) => item.direction === direction,
    )
    const groupedRecurrences = data.recurrenceGroups
      .map((group) => ({
        group,
        items: recurrences.filter((item) => item.groupId === group.id),
      }))
      .filter(({ items }) => items.length > 0)
    const groupedIds = new Set(
      groupedRecurrences.flatMap(({ items }) => items.map((item) => item.id)),
    )
    return [
      ...groupedRecurrences.flatMap(({ group, items }) => [
        { type: 'group' as const, group, items },
        ...items.map((item) => ({ type: 'recurrence' as const, item })),
      ]),
      ...recurrences
        .filter((item) => !groupedIds.has(item.id))
        .map((item) => ({ type: 'recurrence' as const, item })),
    ]
  }
  const sections = [
    {
      direction: 'income' as const,
      label: 'Receitas',
      empty: 'Nenhuma receita recorrente cadastrada.',
      monthlyTotal: monthlyIncome,
      rows: rowsFor('income'),
    },
    {
      direction: 'expense' as const,
      label: 'Despesas',
      empty: 'Nenhuma despesa recorrente cadastrada.',
      monthlyTotal: monthlyExpense,
      rows: rowsFor('expense'),
    },
  ]

  const renderRow = (entry: DisplayRow) => {
    if (entry.type === 'group') {
      const activeItems = entry.items.filter((item) => item.active)
      const monthlyTotal = activeItems.reduce(
        (sum, item) =>
          sum +
          (item.baseAmountCents === null
            ? 0
            : item.baseAmountCents / (item.frequency === 'yearly' ? 12 : 1)),
        0,
      )
      const missingConversions = activeItems.filter(
        (item) => item.amountCents !== 0 && item.baseAmountCents === null,
      ).length
      return (
        <div
          key={`group:${entry.group.id}`}
          className="flex flex-wrap items-center justify-between gap-2 bg-muted/40 px-4 py-3"
        >
          <div>
            <strong className="text-sm">{entry.group.name}</strong>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {entry.items.length}{' '}
              {entry.items.length === 1 ? 'recorrência' : 'recorrências'}
            </p>
          </div>
          <span className="text-sm font-medium tabular-nums">
            {formatCurrency(monthlyTotal)}/mês
            {missingConversions > 0 && ' + valor sem cotação'}
          </span>
        </div>
      )
    }
    const item = entry.item
    const account = data.accounts.find(
      (candidate) => candidate.id === item.accountId,
    )
    const card = data.cards.find(
      (candidate) => candidate.id === item.creditCardId,
    )
    const category = data.categories.find(
      (candidate) => candidate.id === item.categoryId,
    )
    const sortedOccurrences = [...item.occurrences].sort((left, right) =>
      right.expectedDate.localeCompare(left.expectedDate),
    )
    const today = new Date().toISOString().slice(0, 10)
    const recurrenceBook = describeRecurrence(
      {
        active: item.active,
        matchMode: item.matchMode,
        frequency: item.frequency,
        scheduleAnchor: item.scheduleAnchor,
        occurrences: item.occurrences,
      },
      { today },
    )
    const openOccurrences = sortedOccurrences.filter(
      (candidate) => candidate.status === 'expected',
    )
    const occurrence = recurrenceBook.currentOccurrence
    const acceptedMatch = recurrenceBook.acceptedMatches.at(0)
    const latestAcceptedOccurrence = sortedOccurrences.find(
      (candidate) => candidate.id === acceptedMatch?.occurrenceId,
    )
    const suggestedMatch = recurrenceBook.bestSuggestion
    const statusBadge = recurrenceStatusBadge(recurrenceBook.status)
    const displayName = item.groupId
      ? item.participantLabel || item.name
      : item.name
    return (
      <div key={item.id} className="grid gap-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <strong className="truncate text-sm">{displayName}</strong>
              <StatusBadge tone={item.active ? 'success' : 'neutral'}>
                {item.active ? 'Ativa' : 'Pausada'}
              </StatusBadge>
              {statusBadge && (
                <StatusBadge tone={statusBadge.tone}>
                  {statusBadge.label}
                </StatusBadge>
              )}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {item.groupId && item.name !== displayName
                ? `${item.name} · `
                : ''}
              {formatInstrumentName(
                account?.name ?? card?.name ?? 'Sem destino',
              )}{' '}
              · {category?.name ?? 'Sem categoria'} ·{' '}
              {item.frequency === 'monthly' ? 'Mensal' : 'Anual'} · Próxima{' '}
              {new Date(`${item.nextDate}T12:00:00`).toLocaleDateString(
                'pt-BR',
              )}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <strong
              className={
                item.direction === 'income'
                  ? 'mr-1 tabular-nums text-success'
                  : 'mr-1 tabular-nums text-destructive'
              }
            >
              {item.direction === 'expense' ? '−' : '+'}
              {formatCurrency(item.amountCents, item.currency)}
            </strong>
            {item.active && openOccurrences.length > 0 && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="outline"
                      size="icon-sm"
                      aria-label={
                        item.matchMode === 'aggregate'
                          ? 'Vincular lançamentos'
                          : 'Vincular pagamento'
                      }
                      disabled={pending}
                      onClick={() => setLinkRecurrenceId(item.id)}
                    />
                  }
                >
                  <Link2 aria-hidden="true" />
                </TooltipTrigger>
                <TooltipContent>
                  {item.matchMode === 'aggregate'
                    ? 'Vincular lançamentos'
                    : 'Vincular pagamento'}
                </TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Editar ${item.name}`}
                    onClick={() => openEdit(item.id)}
                  />
                }
              >
                <Pencil aria-hidden="true" />
              </TooltipTrigger>
              <TooltipContent>Editar</TooltipContent>
            </Tooltip>
            {item.active &&
              occurrence?.status === 'expected' &&
              !suggestedMatch &&
              !(
                item.matchMode === 'aggregate' &&
                occurrence.matches.some((match) =>
                  isAcceptedRecurrenceMatchStatus(match.status),
                )
              ) && (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Ignorar ocorrência"
                        disabled={pending}
                        onClick={() => skipOccurrence(occurrence.id)}
                      />
                    }
                  >
                    <CircleOff aria-hidden="true" />
                  </TooltipTrigger>
                  <TooltipContent>Ignorar ocorrência</TooltipContent>
                </Tooltip>
              )}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={
                      item.active
                        ? `Pausar ${item.name}`
                        : `Retomar ${item.name}`
                    }
                    disabled={pending}
                    onClick={() => toggleActive(item.id, !item.active)}
                  />
                }
              >
                {item.active ? (
                  <Pause aria-hidden="true" />
                ) : (
                  <Play aria-hidden="true" />
                )}
              </TooltipTrigger>
              <TooltipContent>
                {item.active ? 'Pausar' : 'Retomar'}
              </TooltipContent>
            </Tooltip>
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
        {item.matchMode === 'aggregate' && occurrence ? (
          <AggregateOccurrenceBlock
            occurrence={occurrence}
            currency={item.currency}
            pending={pending}
            confirmMatch={confirmMatch}
            rejectMatch={rejectMatch}
            unlinkMatch={unlinkMatch}
            completeOccurrence={completeOccurrence}
            openLink={() => setLinkRecurrenceId(item.id)}
          />
        ) : (
          <>
            {suggestedMatch?.transaction && (
              <div className="rounded-md border bg-muted/30 p-3">
                <p className="text-sm">
                  <strong>{suggestedMatch.transaction.description}</strong> ·{' '}
                  {formatCurrency(
                    Math.abs(suggestedMatch.transaction.amountCents),
                    suggestedMatch.transaction.currency,
                  )}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Confiança {suggestedMatch.score}% · {suggestedMatch.reason}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={pending}
                    onClick={() => confirmMatch(suggestedMatch.id)}
                  >
                    Confirmar
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() => rejectMatch(suggestedMatch.id)}
                  >
                    Não corresponde
                  </Button>
                </div>
              </div>
            )}
            {acceptedMatch?.transaction && (
              <div className="rounded-md border bg-muted/30 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">
                    Último pagamento: {acceptedMatch.transaction.description} ·{' '}
                    {formatCurrency(
                      Math.abs(acceptedMatch.transaction.amountCents),
                      acceptedMatch.transaction.currency,
                    )}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() => unlinkMatch(acceptedMatch.id)}
                  >
                    Desvincular
                  </Button>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {recurrenceBook.acceptedMatches.length} pagamento(s)
                  confirmado(s) ·{' '}
                  {latestAcceptedOccurrence
                    ? new Date(
                        `${latestAcceptedOccurrence.expectedDate}T12:00:00`,
                      ).toLocaleDateString('pt-BR')
                    : 'data não identificada'}
                  {' · '}
                  Pago por{' '}
                  {formatInstrumentName(
                    acceptedMatch.transaction.account?.name ??
                      acceptedMatch.transaction.creditCard?.name ??
                      'destino não identificado',
                  )}
                </p>
                {acceptedMatch.categoryConflict && (
                  <p className="mt-2 text-xs text-warning-foreground">
                    A categoria diverge da recorrência.{' '}
                    <Link
                      to="/transacoes"
                      className="font-medium underline underline-offset-2"
                    >
                      Revisar transação
                    </Link>
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </div>
    )
  }

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
      {missingConversionCount > 0 && (
        <p className="text-xs text-warning-foreground">
          {missingConversionCount} recorrência(s) sem cotação para BRL não
          entram nos totais mensais.
        </p>
      )}
      <DetectedRecurrencesPanel data={data} />
      <section className="grid gap-4" aria-labelledby="recurrences-heading">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="grid gap-1">
            <h2
              id="recurrences-heading"
              className="font-heading text-base leading-snug font-medium"
            >
              Receitas e despesas recorrentes
            </h2>
            <p className="text-sm text-muted-foreground">
              Compromissos previstos para os próximos meses.
            </p>
          </div>
          {data.recurrences.length ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={refresh} disabled={pending}>
                Buscar pagamentos
              </Button>
              <Button onClick={openNew}>
                <Plus data-icon="inline-start" />
                Nova recorrência
              </Button>
            </div>
          ) : null}
        </header>
        {data.recurrences.length ? (
          <div className="grid gap-5">
            {sections.map((section) => {
              const income = section.direction === 'income'
              const Icon = income ? ArrowDownLeft : ArrowUpRight
              return (
                <section
                  key={section.direction}
                  aria-labelledby={`recurrences-${section.direction}`}
                >
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <h3
                      id={`recurrences-${section.direction}`}
                      className={cn(
                        'flex items-center gap-1.5 text-sm font-semibold',
                        income ? 'text-success' : 'text-destructive',
                      )}
                    >
                      <Icon className="size-4" aria-hidden="true" />
                      {section.label}
                      <span className="font-normal text-muted-foreground">
                        ·{' '}
                        {
                          section.rows.filter(
                            (row) => row.type === 'recurrence',
                          ).length
                        }
                      </span>
                    </h3>
                    <span
                      className={cn(
                        'text-sm font-medium tabular-nums',
                        income ? 'text-success' : 'text-destructive',
                      )}
                    >
                      {income ? '+' : '−'}
                      {formatCurrency(section.monthlyTotal)}/mês
                    </span>
                  </div>
                  {section.rows.length ? (
                    <div className="divide-y rounded-lg border">
                      {section.rows.map(renderRow)}
                    </div>
                  ) : (
                    <p className="rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground">
                      {section.empty}
                    </p>
                  )}
                </section>
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
      </section>
      <LinkPaymentDialog
        key={linkRecurrenceId ?? 'none'}
        recurrence={
          data.recurrences.find((item) => item.id === linkRecurrenceId) ?? null
        }
        pending={pending}
        open={linkRecurrenceId !== null}
        onOpenChange={(open) => {
          if (!open) setLinkRecurrenceId(null)
        }}
        onLink={(occurrenceId, transactionIds) => {
          linkOccurrence(occurrenceId, transactionIds)
          setLinkRecurrenceId(null)
        }}
      />
    </div>
  )
}

function LinkPaymentDialog({
  recurrence,
  pending,
  open,
  onOpenChange,
  onLink,
}: {
  recurrence: Snapshot['recurrences'][number] | null
  pending: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  onLink: (occurrenceId: string, transactionIds: string[]) => void
}) {
  const multiple = recurrence?.matchMode === 'aggregate'
  const [search, setSearch] = useState('')
  const [occurrenceId, setOccurrenceId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const toggleTransaction = (id: string) =>
    setSelectedIds((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : multiple
          ? [...current, id]
          : [id],
    )
  const openOccurrences = useMemo(
    () =>
      recurrence
        ? recurrence.occurrences
            .filter((item) => item.status === 'expected')
            .sort((left, right) =>
              left.expectedDate.localeCompare(right.expectedDate),
            )
        : [],
    [recurrence],
  )
  const selectedOccurrence =
    openOccurrences.find((item) => item.id === occurrenceId) ??
    openOccurrences.at(0)
  const candidatesQuery = useQuery(
    recurrenceLinkCandidatesOptions(selectedOccurrence?.id),
  )
  const candidates = useMemo(() => {
    const query = normalizeDescription(search)
    return (candidatesQuery.data ?? [])
      .filter(
        (candidate) =>
          !query || normalizeDescription(candidate.description).includes(query),
      )
      .slice(
        0,
        recurrenceLinkCandidateLimits[multiple ? 'aggregate' : 'single'],
      )
  }, [candidatesQuery.data, multiple, search])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {multiple
              ? 'Vincular lançamentos ao período'
              : 'Vincular pagamento'}
          </DialogTitle>
          <DialogDescription>
            {recurrence?.name}
            {selectedOccurrence &&
              ` · ${formatCurrency(
                selectedOccurrence.expectedAmountCents,
                selectedOccurrence.currency,
              )} previsto para ${formatDate(selectedOccurrence.expectedDate)}`}
          </DialogDescription>
        </DialogHeader>
        {openOccurrences.length > 1 && (
          <NativeSelect
            value={selectedOccurrence?.id ?? ''}
            onChange={(event) => {
              setOccurrenceId(event.target.value)
              setSelectedIds([])
            }}
            aria-label="Ocorrência a vincular"
          >
            {openOccurrences.map((item) => (
              <NativeSelectOption key={item.id} value={item.id}>
                {formatDate(item.expectedDate)} ·{' '}
                {formatCurrency(item.expectedAmountCents, item.currency)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Buscar por descrição…"
            aria-label="Buscar transação"
            className="pl-8 md:pl-8"
          />
        </div>
        <div className="max-h-80 overflow-y-auto rounded-lg border">
          {candidatesQuery.isPending ? (
            <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Spinner /> Buscando transações…
            </div>
          ) : candidatesQuery.isError ? (
            <p className="p-4 text-sm text-destructive">
              Não foi possível buscar as transações compatíveis.
            </p>
          ) : candidates.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              Nenhuma transação compatível. Confira a busca ou importe o extrato
              do período.
            </p>
          ) : (
            <ul className="divide-y">
              {candidates.map((candidate) => {
                const selected = selectedIds.includes(candidate.id)
                const hints = multiple
                  ? [candidate.inWindow ? 'no período' : 'fora do período']
                  : [
                      candidate.amountDifferenceCents === 0
                        ? 'valor exato'
                        : null,
                      candidate.daysApart <= 3 ? 'data próxima' : null,
                    ].filter(Boolean)
                return (
                  <li key={candidate.id}>
                    <button
                      type="button"
                      aria-pressed={selected}
                      onClick={() => toggleTransaction(candidate.id)}
                      className={cn(
                        'flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors pointer-fine:hover:bg-muted/50',
                        selected &&
                          'bg-primary/5 ring-1 ring-primary/40 ring-inset',
                      )}
                    >
                      <span className="w-20 shrink-0 text-xs text-muted-foreground tabular-nums">
                        {formatDate(candidate.postedAt)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">
                          {candidate.description}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {formatInstrumentName(
                            candidate.accountLabel ??
                              candidate.cardLabel ??
                              '—',
                          )}
                          {hints.length > 0 && ` · ${hints.join(' · ')}`}
                        </span>
                      </span>
                      <span className="shrink-0 font-medium tabular-nums">
                        {formatCurrency(
                          Math.abs(candidate.amountCents),
                          candidate.currency,
                        )}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            disabled={
              selectedIds.length === 0 ||
              !selectedOccurrence ||
              pending ||
              candidatesQuery.isPending
            }
            onClick={() => {
              if (selectedOccurrence && selectedIds.length > 0) {
                onLink(selectedOccurrence.id, selectedIds)
              }
            }}
          >
            <Check data-icon="inline-start" />
            {multiple && selectedIds.length > 1
              ? `Vincular ${selectedIds.length} lançamentos`
              : 'Vincular e conciliar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  const recurrenceGroup = data.recurrenceGroups.find(
    (group) => group.id === recurrence?.groupId,
  )
  const [direction, setDirection] = useState<'income' | 'expense'>(
    recurrence?.direction ?? 'expense',
  )
  const [destinationMode, setDestinationMode] = useState<'automatic' | 'fixed'>(
    recurrence?.destinationMode ?? 'automatic',
  )
  const categories = data.categories.filter((category) =>
    direction === 'income'
      ? category.bucket === 'income'
      : category.bucket === 'essential' || category.bucket === 'lifestyle',
  )
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
                <FieldLabel>Grupo</FieldLabel>
                <Input
                  name="groupName"
                  list="recurrence-group-options"
                  defaultValue={recurrenceGroup?.name}
                  placeholder="Ex.: Academia"
                />
                <datalist id="recurrence-group-options">
                  {data.recurrenceGroups.map((group) => (
                    <option key={group.id} value={group.name} />
                  ))}
                </datalist>
              </Field>
              <Field>
                <FieldLabel>Pessoa ou identificação</FieldLabel>
                <Input
                  name="participantLabel"
                  defaultValue={recurrence?.participantLabel ?? ''}
                  placeholder="Ex.: Donald, esposa ou família"
                />
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel>Tipo</FieldLabel>
                <NativeSelect
                  name="direction"
                  className="w-full"
                  value={direction}
                  onChange={(event) =>
                    setDirection(event.target.value as 'income' | 'expense')
                  }
                >
                  <NativeSelectOption value="expense">
                    Despesa
                  </NativeSelectOption>
                  <NativeSelectOption value="income">
                    Receita
                  </NativeSelectOption>
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel>Comportamento do valor</FieldLabel>
                <NativeSelect
                  name="amountMode"
                  className="w-full"
                  defaultValue={recurrence?.amountMode ?? 'fixed'}
                >
                  <NativeSelectOption value="fixed">
                    Valor fixo
                  </NativeSelectOption>
                  <NativeSelectOption value="variable">
                    Valor variável
                  </NativeSelectOption>
                </NativeSelect>
              </Field>
            </div>
            <Field>
              <FieldLabel>Conciliação</FieldLabel>
              <NativeSelect
                name="matchMode"
                className="w-full"
                defaultValue={recurrence?.matchMode ?? 'single'}
              >
                <NativeSelectOption value="single">
                  Um pagamento por período (aluguel, escola, assinatura)
                </NativeSelectOption>
                <NativeSelectOption value="aggregate">
                  Envelope: soma de vários lançamentos (mercado, farmácia)
                </NativeSelectOption>
              </NativeSelect>
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
                  placeholder="0,00"
                  min="0"
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
            <div className="grid gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel>Identificação do destino</FieldLabel>
                <NativeSelect
                  name="destinationMode"
                  className="w-full"
                  value={destinationMode}
                  onChange={(event) =>
                    setDestinationMode(
                      event.target.value as 'automatic' | 'fixed',
                    )
                  }
                >
                  <NativeSelectOption value="automatic">
                    Automática pelo histórico
                  </NativeSelectOption>
                  <NativeSelectOption value="fixed">
                    Conta fixa
                  </NativeSelectOption>
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel>Moeda</FieldLabel>
                <NativeSelect
                  name="currency"
                  className="w-full"
                  defaultValue={recurrence?.currency ?? 'BRL'}
                  disabled={destinationMode === 'fixed'}
                >
                  <NativeSelectOption value="BRL">BRL</NativeSelectOption>
                  <NativeSelectOption value="USD">USD</NativeSelectOption>
                  <NativeSelectOption value="BTC">BTC</NativeSelectOption>
                </NativeSelect>
              </Field>
            </div>
            {destinationMode === 'fixed' && (
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
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel>Categoria</FieldLabel>
                <NativeSelect
                  name="categoryId"
                  className="w-full"
                  defaultValue={recurrence?.categoryId ?? categories[0]?.id}
                  required
                >
                  {categories.map((category) => (
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

// ─── Detecção de recorrências ────────────────────────────────────────────────

function DetectedRecurrencesPanel({ data }: { data: Snapshot }) {
  const queryClient = useQueryClient()
  const detection = useQuery(recurrenceDetectionOptions())
  const approve = useServerFn(approveDetectedRecurrenceFn)
  const ignore = useServerFn(ignoreDetectedRecurrenceFn)
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: financeQueryKeys.all })
  const approveMutation = useMutation({
    mutationFn: approve,
    onSuccess: (result) => {
      toast.success(
        `Recorrência criada com ${result.linked} pagamento(s) já conciliado(s).`,
      )
      void invalidate()
    },
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : 'Não foi possível aprovar.',
      ),
  })
  const ignoreMutation = useMutation({
    mutationFn: ignore,
    onSuccess: () => {
      toast.success('Candidato ignorado. Não vai aparecer de novo.')
      void invalidate()
    },
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : 'Não foi possível ignorar.',
      ),
  })

  const candidates = detection.data ?? []
  if (!detection.isPending && candidates.length === 0) return null

  return (
    <Panel
      title="Recorrências detectadas"
      description="Pagamentos que se repetem nos seus extratos. Ajuste o que precisar e aprove para virarem recorrências com os pagamentos passados já conciliados."
    >
      {detection.isPending ? (
        <div className="grid gap-3 lg:grid-cols-2">
          <Skeleton className="h-40 rounded-lg" />
          <Skeleton className="h-40 rounded-lg" />
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {candidates.map((candidate) => (
            <DetectedRecurrenceCard
              key={candidate.key}
              candidate={candidate}
              data={data}
              pending={approveMutation.isPending || ignoreMutation.isPending}
              onApprove={(input) => approveMutation.mutate({ data: input })}
              onIgnore={() =>
                ignoreMutation.mutate({
                  data: {
                    signature: candidate.signature,
                    direction: candidate.direction,
                  },
                })
              }
            />
          ))}
        </div>
      )}
    </Panel>
  )
}

function DetectedRecurrenceCard({
  candidate,
  data,
  pending,
  onApprove,
  onIgnore,
}: {
  candidate: DetectedRecurrence
  data: Snapshot
  pending: boolean
  onApprove: (input: {
    name: string
    categoryId: string
    amountCents: number
    currency: string
    direction: 'income' | 'expense'
    amountMode: 'fixed' | 'variable'
    frequency: 'monthly' | 'yearly'
    nextDate: string
    accountId?: string
    creditCardId?: string
    transactionIds: string[]
  }) => void
  onIgnore: () => void
}) {
  const allowedCategories = data.categories.filter((category) =>
    candidate.direction === 'income'
      ? category.bucket === 'income'
      : category.bucket === 'essential' || category.bucket === 'lifestyle',
  )
  const [name, setName] = useState(candidate.name)
  const [categoryId, setCategoryId] = useState(
    allowedCategories.some((category) => category.id === candidate.categoryId)
      ? (candidate.categoryId ?? '')
      : '',
  )
  const [amountInput, setAmountInput] = useState(
    formatMinorUnitsForInput(candidate.typicalAmountCents, candidate.currency),
  )
  const amountCents = (() => {
    try {
      return Math.abs(toCents(amountInput, candidate.currency))
    } catch {
      return null
    }
  })()
  const source =
    data.accounts.find((item) => item.id === candidate.accountId)?.name ??
    data.cards.find((item) => item.id === candidate.creditCardId)?.name ??
    null
  const recent = [...candidate.transactions].reverse().slice(0, 3)
  const canApprove =
    name.trim().length >= 2 &&
    categoryId !== '' &&
    amountCents !== null &&
    amountCents > 0

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-panel">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-label="Nome da recorrência"
            className="font-medium"
          />
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 font-medium text-emerald-800">
              <Sparkles className="size-3" />
              {candidate.confidence}% de confiança
            </span>
            <span>
              {candidate.frequency === 'monthly' ? 'Mensal' : 'Anual'}
            </span>
            <span>·</span>
            <span>
              {candidate.amountMode === 'fixed'
                ? 'valor fixo'
                : `varia de ${formatCurrency(candidate.minAmountCents, candidate.currency)} a ${formatCurrency(candidate.maxAmountCents, candidate.currency)}`}
            </span>
            {source && (
              <>
                <span>·</span>
                <span>{formatInstrumentName(source)}</span>
              </>
            )}
          </p>
        </div>
        <strong
          className={
            candidate.direction === 'income'
              ? 'shrink-0 tabular-nums text-success'
              : 'shrink-0 tabular-nums text-destructive'
          }
        >
          {candidate.direction === 'expense' ? '−' : '+'}
          {formatCurrency(candidate.typicalAmountCents, candidate.currency)}
        </strong>
      </div>

      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_9rem]">
        <CategorySelect
          categories={allowedCategories}
          value={categoryId || null}
          onValueChange={setCategoryId}
          allowTransfer={false}
          aria-label={`Categoria de ${name || candidate.name}`}
        />
        <Input
          inputMode="decimal"
          value={amountInput}
          onChange={(event) => setAmountInput(event.target.value)}
          aria-label="Valor da recorrência"
          aria-invalid={amountCents === null}
          className="tabular-nums"
        />
      </div>

      <ul className="divide-y rounded-md border bg-muted/30 text-xs">
        {recent.map((item) => (
          <li
            key={item.id}
            className="flex items-center justify-between gap-3 px-3 py-1.5"
          >
            <span className="text-muted-foreground">
              {formatDate(item.postedAt)}
            </span>
            <span className="font-medium tabular-nums">
              {formatCurrency(Math.abs(item.amountCents), candidate.currency)}
            </span>
          </li>
        ))}
        {candidate.transactions.length > recent.length && (
          <li className="px-3 py-1.5 text-muted-foreground">
            + {candidate.transactions.length - recent.length} pagamento(s)
            anteriores
          </li>
        )}
      </ul>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          Próximo previsto: {formatDate(candidate.nextExpectedDate)}
        </span>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={onIgnore}
          >
            Ignorar
          </Button>
          <Button
            size="sm"
            disabled={pending || !canApprove}
            onClick={() =>
              amountCents !== null &&
              onApprove({
                name: name.trim(),
                categoryId,
                amountCents,
                currency: candidate.currency,
                direction: candidate.direction,
                amountMode: candidate.amountMode,
                frequency: candidate.frequency,
                nextDate: candidate.nextExpectedDate,
                accountId: candidate.accountId ?? undefined,
                creditCardId: candidate.creditCardId ?? undefined,
                transactionIds: candidate.transactions.map((item) => item.id),
              })
            }
          >
            <Check data-icon="inline-start" /> Aprovar
          </Button>
        </div>
      </div>
    </div>
  )
}

// ─── Envelope (recorrência agregada) ─────────────────────────────────────────

function AggregateOccurrenceBlock({
  occurrence,
  currency,
  pending,
  confirmMatch,
  rejectMatch,
  unlinkMatch,
  completeOccurrence,
  openLink,
}: {
  occurrence: Snapshot['recurrences'][number]['occurrences'][number]
  currency: string
  pending: boolean
  confirmMatch: (matchId: string) => void
  rejectMatch: (matchId: string) => void
  unlinkMatch: (matchId: string) => void
  completeOccurrence: (occurrenceId: string) => void
  openLink: () => void
}) {
  const linked = occurrence.matches.filter((match) =>
    isAcceptedRecurrenceMatchStatus(match.status),
  )
  const suggested = occurrence.matches.filter(
    (match) => match.status === 'suggested',
  )
  const linkedCents = linked.reduce(
    (sum, match) => sum + Math.abs(match.transaction?.amountCents ?? 0),
    0,
  )
  const open = occurrence.status === 'expected'
  return (
    <div className="rounded-md border bg-muted/30 p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          <strong className="tabular-nums">
            {formatCurrency(linkedCents, currency)}
          </strong>{' '}
          <span className="text-muted-foreground">
            de {formatCurrency(occurrence.expectedAmountCents, currency)} ·{' '}
            {linked.length} {linked.length === 1 ? 'lançamento' : 'lançamentos'}
            {' · '}período de {formatDate(occurrence.expectedDate)}
          </span>
        </span>
        {open && (
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={openLink}
            >
              <Link2 data-icon="inline-start" /> Vincular
            </Button>
            {linked.length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => completeOccurrence(occurrence.id)}
              >
                Concluir período
              </Button>
            )}
          </div>
        )}
      </div>
      <ProgressBar
        value={linkedCents}
        max={Math.max(occurrence.expectedAmountCents, 1)}
        className="mt-2"
      />
      {open && suggested.length > 0 && (
        <div className="mt-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-muted-foreground">
              Sugeridos neste período ({suggested.length})
            </p>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() =>
                suggested.forEach((match) => confirmMatch(match.id))
              }
            >
              <Check data-icon="inline-start" /> Confirmar todos
            </Button>
          </div>
          <ul className="mt-1 divide-y rounded-md border bg-background">
            {suggested.map((match) => (
              <li
                key={match.id}
                className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs"
              >
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-muted-foreground">
                    {match.transaction
                      ? formatDate(match.transaction.postedAt)
                      : ''}
                  </span>{' '}
                  {match.transaction?.description}
                </span>
                <span className="shrink-0 font-medium tabular-nums">
                  {formatCurrency(
                    Math.abs(match.transaction?.amountCents ?? 0),
                    match.transaction?.currency ?? currency,
                  )}
                </span>
                <span className="flex shrink-0 gap-1">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Confirmar"
                    disabled={pending}
                    onClick={() => confirmMatch(match.id)}
                  >
                    <Check />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Não corresponde"
                    disabled={pending}
                    onClick={() => rejectMatch(match.id)}
                  >
                    <X />
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {linked.length > 0 && (
        <ul className="mt-3 divide-y rounded-md border bg-background">
          {linked.slice(0, 8).map((match) => (
            <li
              key={match.id}
              className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs"
            >
              <span className="min-w-0 flex-1 truncate">
                <span className="text-muted-foreground">
                  {match.transaction
                    ? formatDate(match.transaction.postedAt)
                    : ''}
                </span>{' '}
                {match.transaction?.description}
              </span>
              <span className="shrink-0 font-medium tabular-nums">
                {formatCurrency(
                  Math.abs(match.transaction?.amountCents ?? 0),
                  match.transaction?.currency ?? currency,
                )}
              </span>
              {open && (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Desvincular"
                  disabled={pending}
                  onClick={() => unlinkMatch(match.id)}
                >
                  <X />
                </Button>
              )}
            </li>
          ))}
          {linked.length > 8 && (
            <li className="px-3 py-1.5 text-xs text-muted-foreground">
              + {linked.length - 8} lançamentos
            </li>
          )}
        </ul>
      )}
    </div>
  )
}
