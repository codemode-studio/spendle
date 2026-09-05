import { identifyImportFiles } from './import-identification.server'
import { getTransactionsPage } from './transactions.server'
import { transactionFiltersSchema } from './transactions.filters'
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { currencySchema } from '#/domain/currency'

import {
  categorizeUncategorizedTransactionsWithAi,
  createAccount,
  updateAccount,
  createManualBalanceCheckpoint,
  createManualTransaction,
  createCreditCard,
  createInstallment,
  createOwnershipScope,
  setReconciliationStatus,
  updateCreditCard,
  updateStagedTransactionCategory,
  updateTransactionCategory,
} from './finance.server'
import {
  getFinanceSnapshot,
  getCategoryTransactions,
  getConfigurationSnapshot,
  getPlanningSnapshot,
  getStrategyHistory,
} from './finance-snapshot.server'
import {
  linkStatementObservation,
  resolveStatementExclusion,
  resolveTransactionCorrection,
} from './import-resolution.server'
import {
  activateStrategy,
  addGoalContribution,
  closeCurrentBudget,
  saveGoal,
  updateSettings,
} from './planning.server'
import {
  clearTransactionData,
  commitImport,
  confirmImportCoverage,
  rejectImport,
  replaceConflictingCheckpoint,
  retryImportFinalization,
  stageImportFormData,
} from './import.server'
import { getImportReviewSnapshot } from './import-review-read.server'
import {
  forgetKnowledgeEntry,
  getKnowledgeBaseSnapshot,
} from './knowledge-base.server'
import {
  applyKnowledgeSync,
  planKnowledgeSync,
  reviewKnowledgeCategoryAndSync,
  updateKnowledgePatternAndSync,
} from './knowledge-sync.server'
import { serverInput } from './input-errors.server'
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
    z.object({
      targetType: z.enum(['account', 'card']),
      targetId: z.string().min(1),
      balanceCents: z.number().int(),
      asOf: isoDateSchema,
      periodStart: isoDateSchema.optional(),
      balanceType: z.enum(['posted', 'available', 'card_statement']),
      note: z.string().trim().max(200).optional(),
      replaceExisting: z.boolean().default(false),
    }),
  )
  .handler(({ data }) => serverInput(() => createManualBalanceCheckpoint(data)))

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
  .handler(({ data }) => serverInput(() => createManualTransaction(data)))

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

const recurrenceInputSchema = z.object({
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

export const createRecurrenceFn = createServerFn({ method: 'POST' })
  .validator(recurrenceInputSchema)
  .handler(({ data }) => serverInput(() => createRecurrence(data)))

export const updateRecurrenceFn = createServerFn({ method: 'POST' })
  .validator(recurrenceInputSchema.extend({ id: z.string().min(1) }))
  .handler(({ data }) => {
    const { id, ...input } = data
    return serverInput(() => updateRecurrence(id, input))
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
  .handler(({ data }) => serverInput(() => listLinkCandidates(data)))

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

export const identifyImportFilesFn = createServerFn({ method: 'POST' })
  .validator((data: FormData) => data)
  .handler(({ data }) => identifyImportFiles(data))

export const stageImportFn = createServerFn({ method: 'POST' })
  .validator((data: FormData) => data)
  .handler(({ data }) => serverInput(() => stageImportFormData(data)))

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
  .handler(({ data }) => serverInput(() => confirmImportCoverage(data)))

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
  .handler(({ data }) => serverInput(() => approveDetectedRecurrence(data)))

export const ignoreDetectedRecurrenceFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      signature: z.string().min(1),
      direction: z.enum(['income', 'expense']),
    }),
  )
  .handler(({ data }) => ignoreDetectedRecurrence(data))

export const getKnowledgeBaseFn = createServerFn({ method: 'GET' }).handler(
  () => getKnowledgeBaseSnapshot(),
)

export const reviewKnowledgeCategoryFn = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string().min(1), categoryId: z.string().min(1) }))
  .handler(({ data }) => reviewKnowledgeCategoryAndSync(data))

export const updateKnowledgePatternFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      id: z.string().min(1),
      pattern: z.string().min(1),
      matchMode: z.enum(['exact', 'prefix']),
    }),
  )
  .handler(({ data }) => updateKnowledgePatternAndSync(data))

export const previewKnowledgeSyncFn = createServerFn({ method: 'GET' }).handler(
  () => planKnowledgeSync(),
)

export const applyKnowledgeSyncFn = createServerFn({ method: 'POST' }).handler(
  () => applyKnowledgeSync(),
)

export const forgetKnowledgeEntryFn = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string().min(1) }))
  .handler(({ data }) => forgetKnowledgeEntry(data))

export const getStrategyHistoryFn = createServerFn({ method: 'GET' })
  .validator(z.object({ months: z.number().int().min(1).max(12).default(3) }))
  .handler(({ data }) => getStrategyHistory(data))

export const getConfigurationSnapshotFn = createServerFn({
  method: 'GET',
}).handler(() => getConfigurationSnapshot())
export const getPlanningSnapshotFn = createServerFn({ method: 'GET' }).handler(
  () => getPlanningSnapshot(),
)

export const getTransactionsPageFn = createServerFn({ method: 'GET' })
  .validator(transactionFiltersSchema)
  .handler(({ data }) => getTransactionsPage(data))

export const getCategoryTransactionsFn = createServerFn({
  method: 'GET',
}).handler(() => getCategoryTransactions())
