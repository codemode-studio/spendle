import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { useState } from 'react'
import type * as React from 'react'
import { toast } from 'sonner'

import { parseCurrency, toMinorUnits as toCents } from '#/lib/currency'
import { formatMonthLong as formatMonth } from '#/lib/period'
import { invalidateFinance } from '#/features/finance/queries'
import {
  closeMonthFn,
  completeOccurrenceFn,
  confirmMatchFn,
  deleteRecurrenceFn,
  linkPaymentsFn,
  rejectMatchFn,
  savePlanFn,
  saveGoalFn,
  saveRecurrenceFn,
  setRecurrenceActiveFn,
  skipOccurrenceFn,
  unlinkMatchFn,
} from '#/features/data/planning.functions'
import { invalidateAfterReactors } from '#/features/data/queries'
import { errorMessage } from '#/lib/api/errors'

import type { Allocation, PlanInput } from './budget-section'
import { matchRef, occurrenceRef } from './types'
import type { MatchView, PlanningData } from './types'

export function usePlanningController(data: PlanningData) {
  const queryClient = useQueryClient()
  const savePlan = useServerFn(savePlanFn)
  const saveGoal = useServerFn(saveGoalFn)
  const closeMonth = useServerFn(closeMonthFn)
  const saveRecurrence = useServerFn(saveRecurrenceFn)
  const setRecurrenceActive = useServerFn(setRecurrenceActiveFn)
  const deleteRecurrence = useServerFn(deleteRecurrenceFn)
  const confirmMatch = useServerFn(confirmMatchFn)
  const rejectMatch = useServerFn(rejectMatchFn)
  const unlinkMatch = useServerFn(unlinkMatchFn)
  const skipOccurrence = useServerFn(skipOccurrenceFn)
  const linkPayments = useServerFn(linkPaymentsFn)
  const completeOccurrence = useServerFn(completeOccurrenceFn)

  const defaultStrategy =
    data.state.strategies.find((strategy) => strategy.isDefault) ??
    data.state.strategies[0]
  const [selectedId, setSelectedId] = useState(defaultStrategy.id)
  const [allocation, setAllocation] = useState<Allocation>({
    ...defaultStrategy.allocation,
  })
  const [goalOpen, setGoalOpen] = useState(false)
  const [recurrenceOpen, setRecurrenceOpen] = useState(false)
  const [editingRecurrenceId, setEditingRecurrenceId] = useState<string | null>(
    null,
  )
  const [deletingRecurrenceId, setDeletingRecurrenceId] = useState<
    string | null
  >(null)
  const invalidateStrategy = () => invalidateFinance(queryClient, 'strategy')
  // Linking a payment may categorise it, which the categorizer settles in the background.
  const invalidateLedger = () => invalidateAfterReactors(queryClient)

  const showError = (error: unknown) =>
    toast.error(errorMessage(error, 'Não foi possível salvar.'))

  // Renda, estratégia e reserva são salvas juntas: um clique, um aviso.
  const planMutation = useMutation({
    mutationFn: (input: PlanInput) =>
      savePlan({
        data: { ...input, strategyId: selectedId, allocation },
      }),
    onSuccess: () => {
      toast.success('Plano salvo.')
      void invalidateStrategy()
    },
    onError: showError,
  })
  const goalMutation = useMutation({
    mutationFn: saveGoal,
    onSuccess: () => {
      toast.success('Meta salva.')
      setGoalOpen(false)
      void invalidateStrategy()
    },
    onError: showError,
  })
  const closeMutation = useMutation({
    mutationFn: closeMonth,
    onSuccess: (result) => {
      toast.success(
        result.alreadyClosed
          ? `${formatMonth(result.month, { capitalize: true })} já estava fechado.`
          : `${formatMonth(result.month, { capitalize: true })} foi fechado.`,
      )
      if (result.analysisError)
        toast.error(
          'Mês fechado. A análise falhou; tente novamente no Assistente.',
        )
      void invalidateFinance(queryClient, 'budgetClose')
    },
    onError: showError,
  })
  const saveRecurrenceMutation = useMutation({
    mutationFn: saveRecurrence,
    onSuccess: (_, variables) => {
      toast.success(
        variables.data.id ? 'Recorrência atualizada.' : 'Recorrência criada.',
      )
      closeRecurrenceDialog()
      void invalidateLedger()
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
      void invalidateLedger()
    },
    onError: showError,
  })
  const deleteRecurrenceMutation = useMutation({
    mutationFn: deleteRecurrence,
    onSuccess: () => {
      toast.success('Recorrência excluída.')
      setDeletingRecurrenceId(null)
      void invalidateLedger()
    },
    onError: showError,
  })
  const confirmMatchMutation = useMutation({
    mutationFn: (match: MatchView) => confirmMatch({ data: matchRef(match) }),
    onSuccess: () => {
      toast.success('Pagamento conciliado com a recorrência.')
      void invalidateLedger()
    },
    onError: showError,
  })
  const rejectMatchMutation = useMutation({
    mutationFn: (match: MatchView) => rejectMatch({ data: matchRef(match) }),
    onSuccess: () => {
      toast.success('Correspondência rejeitada. Ela não será sugerida de novo.')
      void invalidateLedger()
    },
    onError: showError,
  })
  const unlinkMatchMutation = useMutation({
    mutationFn: (match: MatchView) => unlinkMatch({ data: matchRef(match) }),
    onSuccess: () => {
      toast.success('Pagamento desvinculado.')
      void invalidateLedger()
    },
    onError: showError,
  })
  const skipOccurrenceMutation = useMutation({
    mutationFn: (occurrenceId: string) =>
      skipOccurrence({ data: occurrenceRef(occurrenceId) }),
    onSuccess: () => {
      toast.success('Ocorrência ignorada.')
      void invalidateLedger()
    },
    onError: showError,
  })
  const linkOccurrenceMutation = useMutation({
    mutationFn: (input: { occurrenceId: string; entryIds: string[] }) =>
      linkPayments({
        data: {
          ...occurrenceRef(input.occurrenceId),
          entryIds: input.entryIds,
        },
      }),
    onSuccess: (result) => {
      toast.success(
        result.linked === 1
          ? 'Pagamento vinculado e conciliado.'
          : `${result.linked} lançamentos vinculados ao período.`,
      )
      void invalidateLedger()
    },
    onError: showError,
  })
  const completeOccurrenceMutation = useMutation({
    mutationFn: (occurrenceId: string) =>
      completeOccurrence({ data: occurrenceRef(occurrenceId) }),
    onSuccess: () => {
      toast.success('Período concluído com o total real.')
      void invalidateLedger()
    },
    onError: showError,
  })

  function closeRecurrenceDialog() {
    setRecurrenceOpen(false)
    setEditingRecurrenceId(null)
  }

  function selectStrategy(id: string) {
    const strategy = data.state.strategies.find((item) => item.id === id)
    if (!strategy) return
    setSelectedId(id)
    setAllocation({ ...strategy.allocation })
  }

  function submitGoal(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    try {
      goalMutation.mutate({
        data: {
          name: String(form.get('name')),
          type: String(form.get('type')) as
            | 'emergency_reserve'
            | 'medium_term'
            | 'retirement'
            | 'other',
          targetCents: toCents(String(form.get('target'))),
          currentCents: toCents(String(form.get('current') || '0')),
          targetDate: String(form.get('targetDate') || '') || null,
        },
      })
    } catch {
      toast.error('Informe o valor-alvo em reais, como 100.000,00.')
    }
  }

  function submitRecurrence(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const destinationMode = String(form.get('destinationMode')) as
      | 'automatic'
      | 'fixed'
    const accountId =
      destinationMode === 'fixed'
        ? String(form.get('destination') || '') || null
        : null
    const account = data.accounts.find((item) => item.id === accountId)
    const currency = parseCurrency(
      account?.currency ?? String(form.get('currency') || 'BRL'),
    )
    let amountCents: number
    try {
      amountCents = Math.abs(toCents(String(form.get('amount')), currency))
    } catch {
      toast.error('Informe o valor em reais, como 150,00.')
      return
    }
    saveRecurrenceMutation.mutate({
      data: {
        id: editingRecurrenceId ?? undefined,
        recurrence: {
          name: String(form.get('name')),
          groupName: String(form.get('groupName') || '') || null,
          participantLabel: String(form.get('participantLabel') || '') || null,
          accountId,
          categoryId: String(form.get('categoryId')),
          amountCents,
          currency,
          direction: String(form.get('direction')) as 'income' | 'expense',
          amountMode: String(form.get('amountMode')) as 'fixed' | 'variable',
          matchMode: String(form.get('matchMode') || 'single') as
            | 'single'
            | 'aggregate',
          destinationMode,
          frequency: String(form.get('frequency')) as 'monthly' | 'yearly',
          nextDate: String(form.get('nextDate')),
        },
      },
    })
  }

  const totalBps = Object.values(allocation).reduce(
    (sum, value) => sum + value,
    0,
  )
  return {
    allocation,
    closeMutation,
    closeRecurrenceDialog,
    completeOccurrenceMutation,
    confirmMatchMutation,
    deleteRecurrenceMutation,
    deletingRecurrenceId,
    editingRecurrence: data.book.recurrences.find(
      (item) => item.id === editingRecurrenceId,
    ),
    editingRecurrenceId,
    goalMutation,
    goalOpen,
    linkOccurrenceMutation,
    planMutation,
    recurrenceOpen,
    recurrencePending:
      recurrenceStatusMutation.isPending ||
      confirmMatchMutation.isPending ||
      rejectMatchMutation.isPending ||
      unlinkMatchMutation.isPending ||
      skipOccurrenceMutation.isPending ||
      linkOccurrenceMutation.isPending ||
      completeOccurrenceMutation.isPending,
    recurrenceStatusMutation,
    rejectMatchMutation,
    saveRecurrenceMutation,
    savePlan: (input: PlanInput) => planMutation.mutate(input),
    selectStrategy,
    selectedId,
    setAllocation,
    setDeletingRecurrenceId,
    setEditingRecurrenceId,
    setGoalOpen,
    setRecurrenceOpen,
    skipOccurrenceMutation,
    submitGoal,
    submitRecurrence,
    totalBps,
    unlinkMatchMutation,
  }
}
