import { randomUUID } from 'node:crypto'
import { and, desc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm'

import { db, ensureDatabase } from '#/db/index.server'
import * as schema from '#/db/schema'
import type { OwnershipScopeType } from '#/domain/ledger'
import { normalizeDescription } from '#/domain/finance'
import { assertIsoDate } from '#/domain/period'
import {
  categorizeTransactionsWithAi,
  filterConfidentAiSuggestions,
} from './ai.server'
import {
  invalidateCheckpointChain,
  recordManualBalanceCheckpoint,
  refreshStatementAnchor,
} from './checkpoint-chain.server'
import { transactionFingerprint } from './canonicalization.server'
import { learnCategory } from './knowledge-base.server'
import { refreshReconciliationAfterCommit } from './reconciliation-refresh.server'
import {
  noteTransactionCategoryChanged,
  refreshRecurrences,
} from './recurrence.server'

export async function createOwnershipScope(input: {
  name: string
  type: Exclude<OwnershipScopeType, 'company_us'>
}) {
  await ensureDatabase()
  const row = { id: randomUUID(), ...input }
  await db.insert(schema.ownershipScopes).values(row)
  return row
}

async function findOrCreateInstitution(name: string) {
  const normalized = name.trim()
  const existing = await db
    .select()
    .from(schema.institutions)
    .where(sql`lower(${schema.institutions.name}) = lower(${normalized})`)
    .limit(1)
  if (existing[0]) return existing[0].id
  const id = randomUUID()
  await db.insert(schema.institutions).values({ id, name: normalized })
  return id
}

export async function createAccount(input: {
  name: string
  institutionName: string
  ownershipScopeId: string
  kind: 'checking' | 'savings' | 'cash' | 'investment'
  purpose: 'operating' | 'reserve' | 'investment'
  currency: string
  initialBalanceCents: number
}) {
  await ensureDatabase()
  const institutionId = await findOrCreateInstitution(input.institutionName)
  const row = {
    id: randomUUID(),
    name: input.name,
    institutionId,
    ownershipScopeId: input.ownershipScopeId,
    kind: input.kind,
    purpose: input.purpose,
    currency: input.currency,
    initialBalanceCents: input.initialBalanceCents,
  }
  await db.insert(schema.accounts).values(row)
  return row
}

export async function createManualBalanceCheckpoint(
  input: Parameters<typeof recordManualBalanceCheckpoint>[0],
) {
  const result = await recordManualBalanceCheckpoint(input)
  const reconciliationRefresh = await refreshReconciliationAfterCommit()
  return { ...result, reconciliationRefresh }
}

export async function createManualTransaction(input: {
  targetType: 'account' | 'card'
  targetId: string
  postedAt: string
  description: string
  direction: 'inflow' | 'outflow'
  amountCents: number
  categoryId?: string
  counterpartyAccountId?: string
  notes?: string
}) {
  assertIsoDate(input.postedAt)
  await ensureDatabase()
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
    throw new Error('Informe um valor maior que zero.')
  }

  const description = input.description.trim()
  if (description.length < 2 || description.length > 200) {
    throw new Error('Informe uma descrição entre 2 e 200 caracteres.')
  }

  const targetRows =
    input.targetType === 'account'
      ? await db
          .select({
            currency: schema.accounts.currency,
            active: schema.accounts.active,
          })
          .from(schema.accounts)
          .where(eq(schema.accounts.id, input.targetId))
          .limit(1)
      : await db
          .select({
            currency: schema.creditCards.currency,
            active: schema.creditCards.active,
          })
          .from(schema.creditCards)
          .where(eq(schema.creditCards.id, input.targetId))
          .limit(1)
  const target = targetRows.at(0)
  if (!target?.active) throw new Error('Conta ou cartão não encontrado.')

  const categoryId = input.categoryId ?? 'uncategorized'
  const category = (
    await db
      .select({ active: schema.categories.active })
      .from(schema.categories)
      .where(eq(schema.categories.id, categoryId))
      .limit(1)
  ).at(0)
  if (!category?.active) throw new Error('Categoria não encontrada.')

  let counterpartyAccountId: string | null = null
  if (categoryId === 'transfer') {
    if (input.targetType !== 'account') {
      throw new Error('Transferências manuais precisam partir de uma conta.')
    }
    if (!input.counterpartyAccountId) {
      throw new Error('Selecione a outra conta da transferência.')
    }
    if (input.counterpartyAccountId === input.targetId) {
      throw new Error('A outra ponta deve usar uma conta diferente.')
    }
    const counterparty = (
      await db
        .select({ active: schema.accounts.active })
        .from(schema.accounts)
        .where(eq(schema.accounts.id, input.counterpartyAccountId))
        .limit(1)
    ).at(0)
    if (!counterparty?.active) {
      throw new Error('A outra conta da transferência não foi encontrada.')
    }
    counterpartyAccountId = input.counterpartyAccountId
  } else if (input.counterpartyAccountId) {
    throw new Error(
      'A outra conta só pode ser informada em uma transferência interna.',
    )
  }

  const amountCents =
    input.direction === 'inflow' ? input.amountCents : -input.amountCents
  const id = randomUUID()
  const normalizedDescription = normalizeDescription(description)
  const notes = input.notes?.trim() || null
  const inBaseCurrency = target.currency === 'BRL'
  const transactionResult = db.transaction((transaction) => {
    transaction
      .insert(schema.transactions)
      .values({
        id,
        importId: null,
        accountId: input.targetType === 'account' ? input.targetId : null,
        creditCardId: input.targetType === 'card' ? input.targetId : null,
        categoryId,
        counterpartyAccountId,
        externalId: null,
        sourceKey: `manual:${id}`,
        fingerprint: transactionFingerprint({
          postedAt: input.postedAt,
          amountCents,
          description,
          currency: target.currency,
        }),
        postedAt: input.postedAt,
        description,
        normalizedDescription,
        amountCents,
        currency: target.currency,
        baseAmountCents: inBaseCurrency ? amountCents : null,
        baseCurrency: 'BRL',
        exchangeRateMicros: inBaseCurrency ? 1_000_000 : null,
        status: 'confirmed',
        notes,
      })
      .run()

    const checkpointUpdate = invalidateCheckpointChain(transaction, {
      targetType: input.targetType,
      targetId: input.targetId,
      from: input.postedAt,
      reason: `Reaberto pelo lançamento manual ${id}.`,
    })
    refreshStatementAnchor(transaction, {
      targetType: input.targetType,
      targetId: input.targetId,
      balanceType: input.targetType === 'account' ? 'posted' : 'card_statement',
    })
    if (input.targetType === 'card') {
      transaction
        .update(schema.cardStatementCycles)
        .set({ status: 'closed' })
        .where(
          and(
            eq(schema.cardStatementCycles.creditCardId, input.targetId),
            gte(schema.cardStatementCycles.periodEnd, input.postedAt),
          ),
        )
        .run()
    }
    return { reopenedCheckpoints: checkpointUpdate.changes }
  })

  const reconciliationRefresh = await refreshReconciliationAfterCommit()
  return {
    id,
    amountCents,
    currency: target.currency,
    ...transactionResult,
    reconciliationRefresh,
  }
}

export async function updateAccount(input: {
  id: string
  name: string
  institutionName: string
  ownershipScopeId: string
  kind: 'checking' | 'savings' | 'cash' | 'investment'
  purpose: 'operating' | 'reserve' | 'investment'
  currency: string
}) {
  await ensureDatabase()
  const institutionId = await findOrCreateInstitution(input.institutionName)
  const { id, institutionName: _institutionName, ...values } = input
  const updated = await db
    .update(schema.accounts)
    .set({ ...values, institutionId })
    .where(eq(schema.accounts.id, id))
    .returning({ id: schema.accounts.id })

  if (!updated[0]) throw new Error('Conta não encontrada.')
  return { id }
}

export async function createCreditCard(input: {
  name: string
  institutionName: string
  ownershipScopeId: string
  currency: string
  lastFour?: string
  limitCents: number
  closingDay: number
  dueDay?: number
}) {
  await ensureDatabase()
  const institutionId = await findOrCreateInstitution(input.institutionName)
  const row = {
    id: randomUUID(),
    ...input,
    lastFour: input.lastFour || null,
    dueDay: input.dueDay ?? null,
    institutionId,
  }
  await db.insert(schema.creditCards).values(row)
  return row
}

export async function updateCreditCard(input: {
  id: string
  name: string
  institutionName: string
  ownershipScopeId: string
  currency: string
  lastFour?: string
  limitCents: number
  closingDay: number
  dueDay?: number
}) {
  await ensureDatabase()
  const institutionId = await findOrCreateInstitution(input.institutionName)
  const { id, institutionName: _institutionName, ...values } = input
  const updated = await db
    .update(schema.creditCards)
    .set({
      ...values,
      lastFour: values.lastFour || null,
      dueDay: values.dueDay ?? null,
      institutionId,
    })
    .where(eq(schema.creditCards.id, id))
    .returning({ id: schema.creditCards.id })

  if (!updated[0]) throw new Error('Cartão não encontrado.')
  return { id }
}

export async function updateTransactionCategory(input: {
  transactionId: string
  categoryId: string
  saveRule: boolean
  counterpartyAccountId?: string | null
}) {
  await ensureDatabase()
  const transaction = await db
    .select()
    .from(schema.transactions)
    .where(eq(schema.transactions.id, input.transactionId))
    .limit(1)
  if (!transaction[0]) throw new Error('Transação não encontrada.')
  const source = transaction[0]
  const counterpartyAccountId =
    input.categoryId === 'transfer'
      ? (input.counterpartyAccountId ?? null)
      : null
  if (counterpartyAccountId) {
    if (!source.accountId) {
      throw new Error('Somente lançamentos de conta podem ser transferências.')
    }
    if (counterpartyAccountId === source.accountId) {
      throw new Error('Escolha uma conta diferente da conta de origem.')
    }
    const counterparty = await db
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, counterpartyAccountId))
      .limit(1)
    if (!counterparty[0]) throw new Error('Conta relacionada inválida.')
  }

  db.transaction((tx) => {
    tx.update(schema.transactions)
      .set({ categoryId: input.categoryId, counterpartyAccountId })
      .where(eq(schema.transactions.id, input.transactionId))
      .run()
    noteTransactionCategoryChanged(tx, {
      transactionId: input.transactionId,
      categoryId: input.categoryId,
    })
    learnCategory(tx, {
      description: source.description,
      amountCents: source.amountCents,
      categoryId: input.categoryId,
      source: 'transaction_review',
    })
    if (counterpartyAccountId && source.accountId) {
      const direction = source.amountCents < 0 ? 'outgoing' : 'incoming'
      tx.insert(schema.categorizationRules)
        .values({
          id: randomUUID(),
          pattern: source.normalizedDescription,
          accountId: source.accountId,
          counterpartyAccountId,
          direction,
          categoryId: 'transfer',
          priority: 5,
        })
        .onConflictDoUpdate({
          target: [
            schema.categorizationRules.pattern,
            schema.categorizationRules.accountId,
            schema.categorizationRules.direction,
          ],
          set: {
            counterpartyAccountId,
            categoryId: 'transfer',
            priority: 5,
            active: true,
          },
        })
        .run()
    }
    if (input.saveRule) {
      tx.insert(schema.categorizationRules)
        .values({
          id: randomUUID(),
          pattern: transaction[0].normalizedDescription,
          accountId: transaction[0].accountId,
          categoryId: input.categoryId,
          priority: 10,
        })
        .run()
    }
  })
  if (counterpartyAccountId) await refreshReconciliationAfterCommit()
  return { success: true }
}

export async function updateTransactionNote(input: {
  transactionId: string
  note: string | null
}) {
  await ensureDatabase()
  const updated = await db
    .update(schema.transactions)
    .set({ notes: input.note })
    .where(eq(schema.transactions.id, input.transactionId))
    .returning({ id: schema.transactions.id })

  if (!updated[0]) throw new Error('Transação não encontrada.')
  return { id: input.transactionId, note: input.note }
}

export async function categorizeUncategorizedTransactionsWithAi() {
  await ensureDatabase()
  const settings = await db.select().from(schema.appSettings).limit(1)
  if (!settings[0]?.aiClassificationConsent) {
    throw new Error(
      'Ative “Permitir sugestões de categoria por IA” em Configurações.',
    )
  }
  if (!process.env.OPENROUTER_API_KEY || !process.env.OPENROUTER_MODEL) {
    throw new Error('O OpenRouter não está configurado no servidor.')
  }

  const uncategorizedFilter = and(
    eq(schema.transactions.status, 'confirmed'),
    or(
      isNull(schema.transactions.categoryId),
      eq(schema.transactions.categoryId, 'uncategorized'),
    ),
  )
  const [candidates, categories, totalRows] = await Promise.all([
    db
      .select({
        id: schema.transactions.id,
        accountId: schema.transactions.accountId,
        creditCardId: schema.transactions.creditCardId,
        description: schema.transactions.description,
        amountCents: schema.transactions.amountCents,
        currency: schema.transactions.currency,
      })
      .from(schema.transactions)
      .where(uncategorizedFilter)
      .orderBy(desc(schema.transactions.postedAt))
      .limit(500),
    db
      .select({
        id: schema.categories.id,
        name: schema.categories.name,
        bucket: schema.categories.bucket,
      })
      .from(schema.categories)
      .where(eq(schema.categories.active, true)),
    db
      .select({ count: sql<number>`count(*)` })
      .from(schema.transactions)
      .where(uncategorizedFilter),
  ])
  const total = Number(totalRows[0]?.count ?? 0)
  if (!candidates.length) {
    return { processed: 0, categorized: 0, remaining: 0 }
  }

  const allowedCategories = categories.filter(
    (category) => category.bucket !== 'excluded',
  )
  let suggestions
  try {
    suggestions = await categorizeTransactionsWithAi(
      candidates.map((transaction) => ({
        id: transaction.id,
        description: transaction.description,
        amountCents: transaction.amountCents,
        currency: transaction.currency,
        targetType: transaction.creditCardId
          ? ('card' as const)
          : ('account' as const),
      })),
      allowedCategories,
    )
  } catch (error) {
    const providerError = error as {
      message?: string
      statusCode?: number
      cause?: { message?: string; statusCode?: number }
    }
    if (
      error instanceof Error &&
      (/unauthorized|api key|authentication|401/i.test(
        `${providerError.message ?? ''} ${providerError.cause?.message ?? ''}`,
      ) ||
        providerError.statusCode === 401 ||
        providerError.cause?.statusCode === 401)
    ) {
      throw new Error(
        'O OpenRouter recusou a credencial. Verifique OPENROUTER_API_KEY.',
      )
    }
    throw new Error('Não foi possível categorizar as transações com IA.')
  }

  const confidentSuggestions = filterConfidentAiSuggestions(suggestions)
  let categorized = 0
  db.transaction((transaction) => {
    for (const suggestion of confidentSuggestions) {
      const result = transaction
        .update(schema.transactions)
        .set({ categoryId: suggestion.categoryId })
        .where(
          and(
            eq(schema.transactions.id, suggestion.transactionId),
            or(
              isNull(schema.transactions.categoryId),
              eq(schema.transactions.categoryId, 'uncategorized'),
            ),
          ),
        )
        .run()
      categorized += result.changes
    }
  })

  return {
    processed: candidates.length,
    categorized,
    remaining: Math.max(0, total - categorized),
  }
}

export async function updateStagedTransactionCategory(input: {
  stagedTransactionId: string
  categoryId: string
  counterpartyAccountId?: string | null
}) {
  await ensureDatabase()
  const staged = await db
    .select({
      id: schema.stagedTransactions.id,
      description: schema.stagedTransactions.description,
      amountCents: schema.stagedTransactions.amountCents,
      importStatus: schema.imports.status,
      sourceAccountId: schema.imports.accountId,
    })
    .from(schema.stagedTransactions)
    .innerJoin(
      schema.imports,
      eq(schema.stagedTransactions.importId, schema.imports.id),
    )
    .where(eq(schema.stagedTransactions.id, input.stagedTransactionId))
    .limit(1)
  if (!staged[0]) throw new Error('Lançamento do lote não encontrado.')
  if (staged[0].importStatus !== 'review') {
    throw new Error('Este lote não está mais em revisão.')
  }
  const category = await db
    .select({ id: schema.categories.id })
    .from(schema.categories)
    .where(eq(schema.categories.id, input.categoryId))
    .limit(1)
  if (!category[0]) throw new Error('Categoria inválida.')
  const counterpartyAccountId =
    input.categoryId === 'transfer'
      ? (input.counterpartyAccountId ?? null)
      : null
  if (counterpartyAccountId) {
    if (!staged[0].sourceAccountId) {
      throw new Error('Somente lançamentos de conta podem ser transferências.')
    }
    if (counterpartyAccountId === staged[0].sourceAccountId) {
      throw new Error('Escolha uma conta diferente da conta de origem.')
    }
    const counterparty = await db
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, counterpartyAccountId))
      .limit(1)
    if (!counterparty[0]) throw new Error('Conta relacionada inválida.')
  }

  db.transaction((tx) => {
    tx.update(schema.stagedTransactions)
      .set({
        suggestedCategoryId: input.categoryId,
        counterpartyAccountId,
        suggestionConfidence: 100,
        suggestionSource: 'manual',
      })
      .where(eq(schema.stagedTransactions.id, input.stagedTransactionId))
      .run()
    learnCategory(tx, {
      description: staged[0].description,
      amountCents: staged[0].amountCents,
      categoryId: input.categoryId,
      source: 'import_review',
    })
  })
  return { success: true }
}

export async function setReconciliationStatus(input: {
  groupId: string
  status: 'suggested' | 'confirmed' | 'rejected'
}) {
  await ensureDatabase()
  const [groups, links] = await Promise.all([
    db
      .select()
      .from(schema.reconciliationGroups)
      .where(eq(schema.reconciliationGroups.id, input.groupId))
      .limit(1),
    db
      .select()
      .from(schema.reconciliationLinks)
      .where(eq(schema.reconciliationLinks.groupId, input.groupId)),
  ])
  const group = groups.at(0)
  if (!group) throw new Error('Reconciliação não encontrada.')
  const linkedTransactions = links.length
    ? await db
        .select()
        .from(schema.transactions)
        .where(
          inArray(
            schema.transactions.id,
            links.map((link) => link.transactionId),
          ),
        )
    : []

  db.transaction((transaction) => {
    if (input.status === 'confirmed' && group.status !== 'confirmed') {
      for (const link of links) {
        const linked = linkedTransactions.find(
          (candidate) => candidate.id === link.transactionId,
        )
        if (!linked) continue
        transaction
          .update(schema.reconciliationLinks)
          .set({ previousCategoryId: linked.categoryId })
          .where(eq(schema.reconciliationLinks.id, link.id))
          .run()
        const categoryId =
          group.type === 'card_payment'
            ? 'card_payment'
            : group.type === 'profit_distribution'
              ? 'profit_distribution_income'
              : group.type === 'refund'
                ? null
                : 'transfer'
        if (categoryId) {
          transaction
            .update(schema.transactions)
            .set({ categoryId })
            .where(eq(schema.transactions.id, link.transactionId))
            .run()
        }
      }
    }
    if (input.status !== 'confirmed' && group.status === 'confirmed') {
      for (const link of links) {
        transaction
          .update(schema.transactions)
          .set({ categoryId: link.previousCategoryId })
          .where(eq(schema.transactions.id, link.transactionId))
          .run()
      }
    }
    transaction
      .update(schema.reconciliationGroups)
      .set({ status: input.status })
      .where(eq(schema.reconciliationGroups.id, input.groupId))
      .run()
  })
  await refreshRecurrences()
  return { success: true }
}

export async function createInstallment(input: {
  creditCardId: string
  description: string
  categoryId?: string
  installmentAmountCents: number
  totalInstallments: number
  currentInstallment: number
  firstChargeDate: string
}) {
  await ensureDatabase()
  const row = {
    id: randomUUID(),
    ...input,
    categoryId: input.categoryId || null,
  }
  await db.insert(schema.installmentPlans).values(row)
  return row
}
