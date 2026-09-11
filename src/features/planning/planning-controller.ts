import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { useState } from 'react'
import type * as React from 'react'
import { toast } from 'sonner'

import { parseCurrency, toMinorUnits as toCents } from '#/domain/currency'
import { formatMonthLong as formatMonth } from '#/domain/period'
import {
  activateStrategyFn,
  addGoalContributionFn,
  closeCurrentBudgetFn,
  completeRecurrenceOccurrenceFn,
  confirmRecurrenceMatchFn,
  createRecurrenceFn,
  deleteRecurrenceFn,
  linkRecurrenceOccurrenceFn,
  refreshRecurrencesFn,
  rejectRecurrenceMatchFn,
  saveGoalFn,
  setRecurrenceActiveFn,
  skipRecurrenceOccurrenceFn,
  unlinkRecurrenceMatchFn,
  updateRecurrenceFn,
  updateSettingsFn,
} from '#/features/finance/finance.functions'
import { invalidateFinance } from '#/features/finance/queries'
import type { PlanningSnapshot } from '#/features/finance/snapshot.types'
import type { Allocation } from './budget-section'

export function usePlanningController(data: PlanningSnapshot) {
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
  const invalidateStrategy = () => invalidateFinance(queryClient, 'strategy')
  const invalidateBudgetClose = () =>
    invalidateFinance(queryClient, 'budgetClose')
  const invalidateLedger = () => invalidateFinance(queryClient, 'ledger')

  const strategyMutation = useMutation({
    mutationFn: activateStrategy,
    onSuccess: () => {
      toast.success('Estratégia atualizada.')
      void invalidateStrategy()
    },
    onError: showError,
  })
  const settingsMutation = useMutation({
    mutationFn: updateSettings,
    onSuccess: () => {
      toast.success('Planejamento atualizado.')
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
  const contributionMutation = useMutation({
    mutationFn: addContribution,
    onSuccess: () => {
      toast.success('Aporte registrado.')
      setContributionOpen(false)
      void invalidateStrategy()
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
      if ('analysisError' in result && result.analysisError)
        toast.error(
          'Mês fechado. A análise falhou; tente novamente no Assistente.',
        )
      void invalidateBudgetClose()
    },
    onError: showError,
  })
  const createRecurrenceMutation = useMutation({
    mutationFn: createRecurrence,
    onSuccess: () => {
      toast.success('Recorrência criada.')
      closeRecurrenceDialog()
      void invalidateLedger()
    },
    onError: showError,
  })
  const updateRecurrenceMutation = useMutation({
    mutationFn: updateRecurrence,
    onSuccess: () => {
      toast.success('Recorrência atualizada.')
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
      void invalidateLedger()
    },
    onError: showError,
  })
  const confirmMatchMutation = useMutation({
    mutationFn: confirmRecurrenceMatch,
    onSuccess: () => {
      toast.success('Pagamento conciliado com a recorrência.')
      void invalidateLedger()
    },
    onError: showError,
  })
  const rejectMatchMutation = useMutation({
    mutationFn: rejectRecurrenceMatch,
    onSuccess: () => {
      toast.success(
        'Correspondência rejeitada. O sistema vai considerar isso no histórico.',
      )
      void invalidateLedger()
    },
    onError: showError,
  })
  const unlinkMatchMutation = useMutation({
    mutationFn: unlinkRecurrenceMatch,
    onSuccess: () => {
      toast.success('Pagamento desvinculado.')
      void invalidateLedger()
    },
    onError: showError,
  })
  const skipOccurrenceMutation = useMutation({
    mutationFn: skipRecurrenceOccurrence,
    onSuccess: () => {
      toast.success('Ocorrência ignorada.')
      void invalidateLedger()
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
      void invalidateLedger()
    },
    onError: showError,
  })
  const completeOccurrenceMutation = useMutation({
    mutationFn: completeRecurrenceOccurrence,
    onSuccess: () => {
      toast.success('Período concluído com o total real.')
      void invalidateLedger()
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
  return {
    allocation,
    closeMutation,
    closeRecurrenceDialog,
    completeOccurrenceMutation,
    confirmMatchMutation,
    contributionMutation,
    contributionOpen,
    createRecurrenceMutation,
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
    currentBudget,
    unlinkMatchMutation,
    updateRecurrenceMutation,
  }
}
