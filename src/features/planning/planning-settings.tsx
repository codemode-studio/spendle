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
import {
  BudgetSection,
  ClosingSection,
  GoalDialog,
  GoalsSection,
} from '#/features/planning/budget-section'
import { CapsSection } from '#/features/planning/caps-section'
import { usePlanningController } from '#/features/planning/planning-controller'
import { RecurrenceDialog } from '#/features/planning/recurrence-dialogs'
import { RecurrencesSection } from '#/features/planning/recurrences-section'
import type { PlanningData } from '#/features/planning/types'
import {
  accountsOptions,
  categoriesOptions,
  monthOptions,
  planningStateOptions,
  recurrenceBookOptions,
} from '#/features/data/queries'

function usePlanningData(): PlanningData {
  const { data: state } = useSuspenseQuery(planningStateOptions())
  const { data: month } = useSuspenseQuery(monthOptions())
  const { data: book } = useSuspenseQuery(recurrenceBookOptions())
  const { data: accounts } = useSuspenseQuery(accountsOptions())
  const { data: categories } = useSuspenseQuery(categoriesOptions())
  return { state, month, book, accounts, categories }
}

export function PlanningSettings({
  activeSection,
}: {
  activeSection: 'planning' | 'recurrences'
}) {
  const data = usePlanningData()
  const controller = usePlanningController(data)

  return (
    <>
      {activeSection === 'planning' && (
        <div className="grid gap-4">
          <BudgetSection
            data={data}
            selectedId={controller.selectedId}
            allocation={controller.allocation}
            totalBps={controller.totalBps}
            selectStrategy={controller.selectStrategy}
            setAllocation={controller.setAllocation}
            savePlan={controller.savePlan}
            planPending={controller.planMutation.isPending}
          />
          <CapsSection data={data} />
          <GoalsSection
            data={data}
            openGoal={() => controller.setGoalOpen(true)}
          />
          <ClosingSection
            data={data}
            closeMonth={() => controller.closeMutation.mutate({})}
            closePending={controller.closeMutation.isPending}
          />
        </div>
      )}
      {activeSection === 'recurrences' && (
        <RecurrencesSection
          data={data}
          pending={controller.recurrencePending}
          openNew={() => {
            controller.setEditingRecurrenceId(null)
            controller.setRecurrenceOpen(true)
          }}
          openEdit={(id) => {
            controller.setEditingRecurrenceId(id)
            controller.setRecurrenceOpen(true)
          }}
          toggleActive={(id, active) =>
            controller.recurrenceStatusMutation.mutate({ data: { id, active } })
          }
          requestDelete={controller.setDeletingRecurrenceId}
          confirmMatch={(match) =>
            controller.confirmMatchMutation.mutate(match)
          }
          rejectMatch={(match) => controller.rejectMatchMutation.mutate(match)}
          unlinkMatch={(match) => controller.unlinkMatchMutation.mutate(match)}
          skipOccurrence={(occurrenceId) =>
            controller.skipOccurrenceMutation.mutate(occurrenceId)
          }
          linkOccurrence={(occurrenceId, entryIds) =>
            controller.linkOccurrenceMutation.mutate({ occurrenceId, entryIds })
          }
          completeOccurrence={(occurrenceId) =>
            controller.completeOccurrenceMutation.mutate(occurrenceId)
          }
        />
      )}

      <GoalDialog
        open={controller.goalOpen}
        onOpenChange={controller.setGoalOpen}
        onSubmit={controller.submitGoal}
        pending={controller.goalMutation.isPending}
      />
      <RecurrenceDialog
        key={controller.editingRecurrenceId ?? 'new'}
        open={controller.recurrenceOpen}
        onOpenChange={(open) =>
          open
            ? controller.setRecurrenceOpen(true)
            : controller.closeRecurrenceDialog()
        }
        data={data}
        recurrence={controller.editingRecurrence}
        onSubmit={controller.submitRecurrence}
        pending={controller.saveRecurrenceMutation.isPending}
      />
      <AlertDialog
        open={Boolean(controller.deletingRecurrenceId)}
        onOpenChange={(open) =>
          !open && controller.setDeletingRecurrenceId(null)
        }
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
              disabled={controller.deleteRecurrenceMutation.isPending}
              onClick={() =>
                controller.deletingRecurrenceId &&
                controller.deleteRecurrenceMutation.mutate({
                  data: { id: controller.deletingRecurrenceId },
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
