import { useSuspenseQuery } from '@tanstack/react-query'

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
import { planningOptions } from '#/features/finance/queries'
import {
  BudgetSection,
  ClosingSection,
  GoalDialog,
  GoalsSection,
} from '#/features/planning/budget-section'
import { usePlanningController } from '#/features/planning/planning-controller'
import { RecurrenceDialog } from '#/features/planning/recurrence-dialogs'
import { RecurrencesSection } from '#/features/planning/recurrences-section'

export function PlanningSettings({
  activeSection,
}: {
  activeSection: 'planning' | 'recurrences'
}) {
  const { data } = useSuspenseQuery(planningOptions())
  const {
    allocation,
    closeMutation,
    closeRecurrenceDialog,
    completeOccurrenceMutation,
    confirmMatchMutation,
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
    setDeletingRecurrenceId,
    setEditingRecurrenceId,
    setGoalOpen,
    setRecurrenceOpen,
    skipOccurrenceMutation,
    planMutation,
    savePlan,
    submitGoal,
    submitRecurrence,
    totalBps,
    unlinkMatchMutation,
    updateRecurrenceMutation,
  } = usePlanningController(data)

  return (
    <>
      {activeSection === 'planning' && (
        <div className="grid gap-4">
          <BudgetSection
            data={data}
            selectedId={selectedId}
            allocation={allocation}
            totalBps={totalBps}
            selectStrategy={selectStrategy}
            setAllocation={setAllocation}
            savePlan={savePlan}
            planPending={planMutation.isPending}
          />
          <GoalsSection data={data} openGoal={() => setGoalOpen(true)} />
          <ClosingSection
            data={data}
            closed={Boolean(currentBudget?.closed)}
            pendingCount={pendingCount}
            closeMonth={() => closeMutation.mutate({})}
            closePending={closeMutation.isPending}
          />
        </div>
      )}
      {activeSection === 'recurrences' && (
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
      )}

      <GoalDialog
        open={goalOpen}
        onOpenChange={setGoalOpen}
        onSubmit={submitGoal}
        pending={goalMutation.isPending}
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
    </>
  )
}
