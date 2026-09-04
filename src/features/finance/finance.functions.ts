import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { currencySchema } from '#/domain/currency'

import {
  activateStrategy,
  addGoalContribution,
  categorizeUncategorizedTransactionsWithAi,
  closeCurrentBudget,
  createAccount,
  updateAccount,
  createManualBalanceCheckpoint,
  createManualTransaction,
  createCreditCard,
  createInstallment,
  linkStatementObservation,
  createOwnershipScope,
  getFinanceSnapshot,
  getStrategyHistory,
  saveGoal,
  resolveTransactionCorrection,
  resolveStatementExclusion,
  setReconciliationStatus,
  updateCreditCard,
  updateSettings,
  updateStagedTransactionCategory,
  updateTransactionCategory,
} from './finance.server'
import {
  clearTransactionData,
  commitImport,
  confirmImportCoverage,
  rejectImport,
  replaceConflictingCheckpoint,
  retryImportFinalization,
  stageImportBatch,
} from './import.server'
import { getImportReviewSnapshot } from './import-review-read.server'
import {
  approveDetectedRecurrence,
  completeOccurrence as completeRecurrenceOccurrence,
  confirmMatch as confirmRecurrenceMatch,
  createRecurrence,
  deleteRecurrence,
  detectRecurrenceCandidates,
  ignoreDetectedRecurrence,
  linkTransactions as linkRecurrenceOccurrence,
  listLinkCandidates,
  refreshRecurrences,
  rejectMatch as rejectRecurrenceMatch,
  setRecurrenceActive,
  skipOccurrence as skipRecurrenceOccurrence,
  unlinkMatch as unlinkRecurrenceMatch,
  updateRecurrence,
} from './recurrence.server'

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Informe uma data válida.')
  .refine((value) => {
    const parsed = new Date(`${value}T12:00:00Z`)
    return (
      !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    )
  }, 'Informe uma data válida.')

export const getFinanceSnapshotFn = createServerFn({ method: 'GET' })
  .validator(
    z.object({
      month: z
        .string()
        .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
        .optional(),
    }),
  )
  .handler(({ data }) => getFinanceSnapshot(data.month))

export const getImportReviewSnapshotFn = createServerFn({
  method: 'GET',
}).handler(() => getImportReviewSnapshot())

export const retryImportFinalizationFn = createServerFn({ method: 'POST' })
  .validator(z.object({ importId: z.string().min(1) }))
  .handler(({ data }) => retryImportFinalization(data.importId))

export const createOwnershipScopeFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      name: z.string().trim().min(2).max(80),
      type: z.enum(['household', 'person', 'company_br']),
    }),
  )
  .handler(({ data }) => createOwnershipScope(data))

const accountInputSchema = z.object({
  name: z.string().trim().min(2).max(80),
  institutionName: z.string().trim().min(2).max(80),
  ownershipScopeId: z.string().min(1),
  kind: z.enum(['checking', 'savings', 'cash', 'investment']),
  purpose: z.enum(['operating', 'reserve', 'investment']),
  currency: currencySchema,
})

export const createAccountFn = createServerFn({ method: 'POST' })
  .validator(
    accountInputSchema.extend({ initialBalanceCents: z.number().int() }),
  )
  .handler(({ data }) => createAccount(data))

export const updateAccountFn = createServerFn({ method: 'POST' })
  .validator(accountInputSchema.extend({ id: z.string().min(1) }))
  .handler(({ data }) => updateAccount(data))

export const createManualBalanceCheckpointFn = createServerFn({
  method: 'POST',
})
  .validator(
    z
      .object({
        targetType: z.enum(['account', 'card']),
        targetId: z.string().min(1),
        balanceCents: z.number().int(),
        asOf: isoDateSchema,
        periodStart: isoDateSchema.optional(),
        balanceType: z.enum(['posted', 'available', 'card_statement']),
        note: z.string().trim().max(200).optional(),
        replaceExisting: z.boolean().default(false),
      })
      .superRefine((value, context) => {
        if (value.targetType === 'card' && !value.periodStart) {
          context.addIssue({
            code: 'custom',
            path: ['periodStart'],
            message: 'Informe o início do ciclo da fatura.',
          })
        }
        if (value.periodStart && value.periodStart > value.asOf) {
          context.addIssue({
            code: 'custom',
            path: ['periodStart'],
            message: 'O início do ciclo deve ser anterior ao fechamento.',
          })
        }
      }),
  )
  .handler(({ data }) => createManualBalanceCheckpoint(data))

export const createManualTransactionFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      targetType: z.enum(['account', 'card']),
      targetId: z.string().min(1),
      postedAt: isoDateSchema,
      description: z.string().trim().min(2).max(200),
      direction: z.enum(['inflow', 'outflow']),
      amountCents: z.number().int().positive(),
      categoryId: z.string().min(1).optional(),
      counterpartyAccountId: z.string().min(1).optional(),
      notes: z.string().trim().max(200).optional(),
    }),
  )
  .handler(({ data }) => createManualTransaction(data))

export const resolveTransactionCorrectionFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      correctionId: z.string().min(1),
      action: z.enum(['accept', 'reject']),
    }),
  )
  .handler(({ data }) => resolveTransactionCorrection(data))

export const linkStatementObservationFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      stagedTransactionId: z.string().min(1),
      transactionId: z.string().min(1),
    }),
  )
  .handler(({ data }) => linkStatementObservation(data))

export const resolveStatementExclusionFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      importId: z.string().min(1),
      transactionId: z.string().min(1),
      action: z.enum(['exclude', 'restore']),
    }),
  )
  .handler(({ data }) => resolveStatementExclusion(data))

const creditCardInputSchema = z.object({
  name: z.string().trim().min(2).max(80),
  institutionName: z.string().trim().min(2).max(80),
  ownershipScopeId: z.string().min(1),
  currency: currencySchema,
  lastFour: z
    .string()
    .regex(/^\d{4}$/)
    .optional(),
  limitCents: z.number().int().min(0),
  closingDay: z.number().int().min(1).max(31),
  dueDay: z.number().int().min(1).max(31).optional(),
})

export const createCreditCardFn = createServerFn({ method: 'POST' })
  .validator(creditCardInputSchema)
  .handler(({ data }) => createCreditCard(data))

export const updateCreditCardFn = createServerFn({ method: 'POST' })
  .validator(creditCardInputSchema.extend({ id: z.string().min(1) }))
  .handler(({ data }) => updateCreditCard(data))

export const updateSettingsFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      monthlyIncomeTargetCents: z.number().int().min(0),
      reserveMonths: z.number().int().min(1).max(36),
      keepReserveContributions: z.boolean(),
      aiClassificationConsent: z.boolean(),
    }),
  )
  .handler(({ data }) => updateSettings(data))

export const activateStrategyFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      strategyId: z.string().min(1),
      essentialBps: z.number().int().min(0).max(10_000),
      lifestyleBps: z.number().int().min(0).max(10_000),
      investmentBps: z.number().int().min(0).max(10_000),
      reserveBps: z.number().int().min(0).max(10_000),
    }),
  )
  .handler(({ data }) => activateStrategy(data))

export const saveGoalFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      id: z.string().optional(),
      name: z.string().trim().min(2).max(100),
      type: z.enum(['emergency_reserve', 'medium_term', 'retirement', 'other']),
      targetCents: z.number().int().min(0),
      currentCents: z.number().int().min(0),
      targetDate: z.string().optional(),
    }),
  )
  .handler(({ data }) => saveGoal(data))

export const addGoalContributionFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      goalId: z.string().min(1),
      amountCents: z.number().int().positive(),
      contributedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      notes: z.string().max(200).optional(),
    }),
  )
  .handler(({ data }) => addGoalContribution(data))

export const updateTransactionCategoryFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      transactionId: z.string().min(1),
      categoryId: z.string().min(1),
      saveRule: z.boolean(),
      counterpartyAccountId: z.string().min(1).nullable().optional(),
    }),
  )
  .handler(({ data }) => updateTransactionCategory(data))

export const categorizeUncategorizedTransactionsWithAiFn = createServerFn({
  method: 'POST',
}).handler(() => categorizeUncategorizedTransactionsWithAi())

export const updateStagedTransactionCategoryFn = createServerFn({
  method: 'POST',
})
  .validator(
    z.object({
      stagedTransactionId: z.string().min(1),
      categoryId: z.string().min(1),
      counterpartyAccountId: z.string().min(1).nullable().optional(),
    }),
  )
  .handler(({ data }) => updateStagedTransactionCategory(data))

export const setReconciliationStatusFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      groupId: z.string().min(1),
      status: z.enum(['suggested', 'confirmed', 'rejected']),
    }),
  )
  .handler(({ data }) => setReconciliationStatus(data))

const recurrenceInputSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    groupName: z.string().trim().max(80).optional(),
    participantLabel: z.string().trim().max(80).optional(),
    accountId: z.string().optional(),
    creditCardId: z.string().optional(),
    categoryId: z.string().min(1),
    amountCents: z.number().int().positive(),
    currency: currencySchema,
    direction: z.enum(['income', 'expense']),
    amountMode: z.enum(['fixed', 'variable']),
    matchMode: z.enum(['single', 'aggregate']).default('single'),
    destinationMode: z.enum(['automatic', 'fixed']),
    frequency: z.enum(['monthly', 'yearly']),
    nextDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .superRefine((value, context) => {
    if (value.accountId && value.creditCardId) {
      context.addIssue({
        code: 'custom',
        path: ['accountId'],
        message: 'Informe somente uma conta ou um cartão.',
      })
    }
    if (
      value.destinationMode === 'fixed' &&
      Number(Boolean(value.accountId)) + Number(Boolean(value.creditCardId)) !==
        1
    ) {
      context.addIssue({
        code: 'custom',
        path: ['accountId'],
        message: 'Escolha uma conta ou cartão para o destino fixo.',
      })
    }
  })

export const createRecurrenceFn = createServerFn({ method: 'POST' })
  .validator(recurrenceInputSchema)
  .handler(({ data }) => createRecurrence(data))

export const updateRecurrenceFn = createServerFn({ method: 'POST' })
  .validator(recurrenceInputSchema.extend({ id: z.string().min(1) }))
  .handler(({ data }) => {
    const { id, ...input } = data
    return updateRecurrence(id, input)
  })

export const setRecurrenceActiveFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      id: z.string().min(1),
      active: z.boolean(),
    }),
  )
  .handler(({ data }) => setRecurrenceActive(data))

export const deleteRecurrenceFn = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string().min(1) }))
  .handler(({ data }) => deleteRecurrence(data.id))

export const refreshRecurrencesFn = createServerFn({ method: 'POST' }).handler(
  () => refreshRecurrences(),
)

export const confirmRecurrenceMatchFn = createServerFn({ method: 'POST' })
  .validator(z.object({ matchId: z.string().min(1) }))
  .handler(({ data }) => confirmRecurrenceMatch(data.matchId))

export const rejectRecurrenceMatchFn = createServerFn({ method: 'POST' })
  .validator(z.object({ matchId: z.string().min(1) }))
  .handler(({ data }) => rejectRecurrenceMatch(data.matchId))

export const unlinkRecurrenceMatchFn = createServerFn({ method: 'POST' })
  .validator(z.object({ matchId: z.string().min(1) }))
  .handler(({ data }) => unlinkRecurrenceMatch(data.matchId))

export const skipRecurrenceOccurrenceFn = createServerFn({ method: 'POST' })
  .validator(z.object({ occurrenceId: z.string().min(1) }))
  .handler(({ data }) => skipRecurrenceOccurrence(data.occurrenceId))

export const linkRecurrenceOccurrenceFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      occurrenceId: z.string().min(1),
      transactionIds: z.array(z.string().min(1)).min(1).max(100),
    }),
  )
  .handler(({ data }) => linkRecurrenceOccurrence(data))

export const listLinkCandidatesFn = createServerFn({ method: 'GET' })
  .validator(
    z.object({
      occurrenceId: z.string().min(1),
      today: isoDateSchema.optional(),
    }),
  )
  .handler(({ data }) => listLinkCandidates(data))

export const completeRecurrenceOccurrenceFn = createServerFn({
  method: 'POST',
})
  .validator(z.object({ occurrenceId: z.string().min(1) }))
  .handler(({ data }) => completeRecurrenceOccurrence(data.occurrenceId))

export const createInstallmentFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      creditCardId: z.string().min(1),
      description: z.string().trim().min(2),
      categoryId: z.string().optional(),
      installmentAmountCents: z.number().int().positive(),
      totalInstallments: z.number().int().min(2).max(120),
      currentInstallment: z.number().int().min(1),
      firstChargeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }),
  )
  .handler(({ data }) => createInstallment(data))

export const stageImportFn = createServerFn({ method: 'POST' })
  .validator((data: FormData) => {
    const files = [...data.getAll('files'), ...data.getAll('file')].filter(
      (file): file is File => file instanceof File && file.size > 0,
    )
    const targetType = data.get('targetType')
    const targetId = data.get('targetId')
    if (!files.length) throw new Error('Selecione pelo menos um arquivo.')
    if (targetType !== 'account' && targetType !== 'card') {
      throw new Error('Destino inválido.')
    }
    if (typeof targetId !== 'string' || !targetId) {
      throw new Error('Selecione uma conta ou cartão.')
    }
    return {
      files,
      targetType: z.enum(['account', 'card']).parse(targetType),
      targetId,
      aiConsent: data.get('aiConsent') === 'true',
    }
  })
  .handler(({ data }) => stageImportBatch(data))

export const commitImportFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      importId: z.string().min(1),
      manualReviewConfirmed: z.boolean().default(false),
    }),
  )
  .handler(({ data }) =>
    commitImport(data.importId, data.manualReviewConfirmed),
  )

export const rejectImportFn = createServerFn({ method: 'POST' })
  .validator(z.object({ importId: z.string().min(1) }))
  .handler(({ data }) => rejectImport(data.importId))

export const replaceConflictingCheckpointFn = createServerFn({ method: 'POST' })
  .validator(z.object({ importId: z.string().min(1) }))
  .handler(({ data }) => replaceConflictingCheckpoint(data.importId))

export const confirmImportCoverageFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      importId: z.string().min(1),
      periodStart: isoDateSchema,
      periodEnd: isoDateSchema,
    }),
  )
  .handler(({ data }) => confirmImportCoverage(data))

export const closeCurrentBudgetFn = createServerFn({ method: 'POST' }).handler(
  () => closeCurrentBudget(),
)

export const clearTransactionDataFn = createServerFn({ method: 'POST' })
  .validator(z.object({ confirmation: z.literal('APAGAR') }))
  .handler(() => clearTransactionData())

export const detectRecurrencesFn = createServerFn({ method: 'GET' }).handler(
  () => detectRecurrenceCandidates(),
)

export const approveDetectedRecurrenceFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      name: z.string().trim().min(2).max(100),
      categoryId: z.string().min(1),
      amountCents: z.number().int().positive(),
      currency: currencySchema,
      direction: z.enum(['income', 'expense']),
      amountMode: z.enum(['fixed', 'variable']),
      frequency: z.enum(['monthly', 'yearly']),
      nextDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      accountId: z.string().optional(),
      creditCardId: z.string().optional(),
      transactionIds: z.array(z.string().min(1)).min(1),
    }),
  )
  .handler(({ data }) => approveDetectedRecurrence(data))

export const ignoreDetectedRecurrenceFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      signature: z.string().min(1),
      direction: z.enum(['income', 'expense']),
    }),
  )
  .handler(({ data }) => ignoreDetectedRecurrence(data))

export const getStrategyHistoryFn = createServerFn({ method: 'GET' })
  .validator(z.object({ months: z.number().int().min(1).max(12).default(3) }))
  .handler(({ data }) => getStrategyHistory(data))
