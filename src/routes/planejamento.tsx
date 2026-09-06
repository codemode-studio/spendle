import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'

import { Page, PageHeader } from '#/components/ui'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '#/components/ui/alert-dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '#/components/ui/tabs'
import { planningOptions } from '#/features/finance/queries'
import {
  BudgetSection,
  ContributionDialog,
  GoalDialog,
  GoalsSection,
} from '#/features/planning/budget-section'
import { usePlanningController } from '#/features/planning/planning-controller'
import { RecurrenceDialog } from '#/features/planning/recurrence-dialogs'
import { RecurrencesSection } from '#/features/planning/recurrences-section'

const planningSearchSchema = z.object({
  section: z
    .enum(['budget', 'goals', 'recurrences'])
    .optional()
    .catch(undefined),
})

export const Route = createFileRoute('/planejamento')({
  validateSearch: planningSearchSchema,
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(planningOptions()),
  component: PlanningPage,
})

function PlanningPage() {
  const { section } = Route.useSearch()
  const navigate = Route.useNavigate()
  const activeSection = section ?? 'budget'
  const { data } = useSuspenseQuery(planningOptions())
  const {
    allocation,
    closeMutation,
    closeRecurrenceDialog,
    completeOccurrenceMutation,
    confirmMatchMutation,
    contributionMutation,
    contributionOpen,
    createRecurrenceMutation,
    currentBudget,
    deleteRecurrenceMutation,
    deletingRecurrenceId,
    editingRecurrence,
    editingRecurrenceId,
    goalMutation,
    goalOpen,
    linkOccurrenceMutation,
    pendingCount,
    recurrenceOpen,
    recurrenceStatusMutation,
    refreshRecurrencesMutation,
    rejectMatchMutation,
    selectStrategy,
    selectedId,
    setAllocation,
    setContributionOpen,
    setDeletingRecurrenceId,
    setEditingRecurrenceId,
    setGoalOpen,
    setRecurrenceOpen,
    settingsMutation,
    skipOccurrenceMutation,
    strategyMutation,
    submitContribution,
    submitGoal,
    submitIncome,
    submitRecurrence,
    submitReserve,
    totalBps,
    unlinkMatchMutation,
    updateRecurrenceMutation,
  } = usePlanningController(data)

  return (
    <Page>
      <PageHeader
        title={
          activeSection === 'recurrences' ? 'Recorrências' : 'Orçamento e metas'
        }
        description={
          activeSection === 'recurrences'
            ? 'Acompanhe receitas, contas recorrentes e próximos vencimentos.'
            : 'Defina como dividir a renda e acompanhe seus objetivos.'
        }
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
