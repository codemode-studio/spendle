import { measureOperation } from './diagnostics.server'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'

import { db, ensureDatabase } from '#/db/index.server'
import * as schema from '#/db/schema'
import { isSettlementCategory } from '#/domain/card-payment'
import {
  buildReconciliationSuggestions,
  isAutomaticMatchStillValid,
  reconciliationCategory,
} from '#/domain/reconciliation'
import { validateReconciliationsWithAi } from './ai.server'
import { suggestCategory } from './categories.server'
import { readCurrentProviderCategories } from './provider-category.server'
import { refreshRecurrences } from './recurrence.server'

export async function refreshReconciliationSuggestions() {
  await ensureDatabase()
  const [
    transactionRows,
    accountRows,
    cardRows,
    scopeRows,
    existingLinks,
    groups,
    settingsRows,
    providerCategory,
    manualCardLinks,
  ] = await Promise.all([
    db.select().from(schema.transactions),
    db.select().from(schema.accounts),
    db.select().from(schema.creditCards),
    db.select().from(schema.ownershipScopes),
    db.select().from(schema.reconciliationLinks),
    db.select().from(schema.reconciliationGroups),
    db.select().from(schema.appSettings).limit(1),
    readCurrentProviderCategories(),
    db
      .select({
        transactionId: schema.cardStatementPayments.transactionId,
        creditCardId: schema.cardStatementPayments.creditCardId,
      })
      .from(schema.cardStatementPayments),
  ])
  // A bank debit a person linked to a card's bill pairs only with that card.
  const linkedCardById = new Map(
    manualCardLinks.map((link) => [link.transactionId, link.creditCardId]),
  )
  const transactionStatusById = new Map(
    transactionRows.map((transaction) => [transaction.id, transaction.status]),
  )
  const transactionCategoryById = new Map(
    transactionRows.map((transaction) => [
      transaction.id,
      transaction.categoryId,
    ]),
  )
  // Undoing a match only undoes its own classification: a row whose category
  // changed after the confirmation (a person's later choice) keeps it.
  const stillMatchCategory = (
    type: Parameters<typeof reconciliationCategory>[0],
    transactionId: string,
  ) => {
    const categoryId = reconciliationCategory(type)
    return (
      categoryId !== null &&
      transactionCategoryById.get(transactionId) === categoryId
    )
  }
  const invalidGroupIds = new Set(
    existingLinks
      .filter(
        (link) => transactionStatusById.get(link.transactionId) !== 'confirmed',
      )
      .map((link) => link.groupId),
  )
  if (invalidGroupIds.size) {
    db.transaction((transaction) => {
      for (const group of groups) {
        if (!invalidGroupIds.has(group.id)) continue
        if (group.status === 'confirmed') {
          for (const link of existingLinks.filter(
            (candidate) => candidate.groupId === group.id,
          )) {
            if (!stillMatchCategory(group.type, link.transactionId)) continue
            transaction
              .update(schema.transactions)
              .set({ categoryId: link.previousCategoryId })
              .where(eq(schema.transactions.id, link.transactionId))
              .run()
          }
        }
        transaction
          .update(schema.reconciliationGroups)
          .set({
            status: 'rejected',
            pairKey: null,
            confirmationSource: null,
            reason:
              'Invalidada porque uma movimentação vinculada ainda não está confirmada.',
          })
          .where(eq(schema.reconciliationGroups.id, group.id))
          .run()
        group.status = 'rejected'
        group.pairKey = null
      }
    })
  }

  const accountScope = new Map(
    accountRows.map((account) => [account.id, account.ownershipScopeId]),
  )
  const cardScope = new Map(
    cardRows.map((card) => [card.id, card.ownershipScopeId]),
  )
  const scopeType = new Map(scopeRows.map((scope) => [scope.id, scope.type]))
  const contextualTransactions = transactionRows.map((transaction) => {
    const ownershipScopeId = transaction.accountId
      ? accountScope.get(transaction.accountId)
      : transaction.creditCardId
        ? cardScope.get(transaction.creditCardId)
        : undefined
    return {
      ...transaction,
      providerCategory: providerCategory.get(transaction.id) ?? null,
      linkedCardId: linkedCardById.get(transaction.id) ?? null,
      scopeType: ownershipScopeId
        ? (scopeType.get(ownershipScopeId) ?? null)
        : null,
    }
  })

  // Automatic confirmations are a projection of the current facts: when a
  // correction, a later fact or a person's bill payment link means the pair
  // no longer passes the automatic rule, the match is dissolved and its rows
  // go back to the candidate pool. Confirmations made by a person are never
  // revisited here.
  const contextualById = new Map(
    contextualTransactions.map((transaction) => [transaction.id, transaction]),
  )
  const dissolved = groups.flatMap((group) => {
    if (group.status !== 'confirmed') return []
    if (group.confirmationSource !== 'automatic') return []
    const links = existingLinks.filter((link) => link.groupId === group.id)
    const [left, right] = links.map((link) =>
      contextualById.get(link.transactionId),
    )
    if (links.length !== 2 || !left || !right) return []
    if (isAutomaticMatchStillValid(group.type, left, right)) return []
    return [{ group, links }]
  })
  if (dissolved.length) {
    const restoredCategory = new Map<string, string | null>()
    for (const { group, links } of dissolved) {
      for (const link of links) {
        if (!stillMatchCategory(group.type, link.transactionId)) continue
        // A debit linked by hand keeps the category its link assigned.
        if (linkedCardById.has(link.transactionId)) continue
        const transaction = contextualById.get(link.transactionId)!
        // A settlement category was the rule's own classification of the old
        // facts; classify the current facts again instead of restoring it.
        restoredCategory.set(
          link.transactionId,
          isSettlementCategory(link.previousCategoryId)
            ? (
                await suggestCategory({
                  description: transaction.description,
                  amountCents: transaction.amountCents,
                  accountId: transaction.accountId,
                  creditCardId: transaction.creditCardId,
                })
              ).categoryId
            : link.previousCategoryId,
        )
      }
    }
    db.transaction((transaction) => {
      for (const [transactionId, categoryId] of restoredCategory) {
        transaction
          .update(schema.transactions)
          .set({ categoryId })
          .where(eq(schema.transactions.id, transactionId))
          .run()
      }
      for (const { group } of dissolved) {
        transaction
          .delete(schema.reconciliationLinks)
          .where(eq(schema.reconciliationLinks.groupId, group.id))
          .run()
        transaction
          .delete(schema.reconciliationGroups)
          .where(eq(schema.reconciliationGroups.id, group.id))
          .run()
      }
    })
    const dissolvedIds = new Set(dissolved.map(({ group }) => group.id))
    for (const [transactionId, categoryId] of restoredCategory) {
      for (const row of [
        transactionRows.find((item) => item.id === transactionId),
        contextualById.get(transactionId),
      ]) {
        if (row) row.categoryId = categoryId
      }
    }
    groups.splice(
      0,
      groups.length,
      ...groups.filter((group) => !dissolvedIds.has(group.id)),
    )
    existingLinks.splice(
      0,
      existingLinks.length,
      ...existingLinks.filter((link) => !dissolvedIds.has(link.groupId)),
    )
  }

  // Suggestions the refresh made are a projection too: they are rebuilt from
  // the current facts on every run, so a pair that passes the automatic rule
  // again is confirmed again and a pair that no longer matches goes away.
  // Groups a person confirmed, rejected or sent back to review are kept.
  const isProjectedSuggestion = (group: (typeof groups)[number]) =>
    group.status === 'suggested' && group.confirmationSource !== 'person'
  const groupsById = new Map(groups.map((group) => [group.id, group]))
  const linkedTransactionIds = new Set(
    existingLinks
      .filter((link) => {
        const group = groupsById.get(link.groupId)
        return (
          group &&
          (group.status === 'confirmed' ||
            (group.status === 'suggested' && !isProjectedSuggestion(group)))
        )
      })
      .map((link) => link.transactionId),
  )
  const candidates = contextualTransactions.filter(
    (transaction) =>
      transaction.status === 'confirmed' &&
      !linkedTransactionIds.has(transaction.id),
  )
  const suggestions = buildReconciliationSuggestions(candidates)
  const suggestionByPairKey = new Map(
    suggestions.map((suggestion) => [
      [...suggestion.transactionIds].sort().join(':'),
      suggestion,
    ]),
  )
  const stale: string[] = []
  const promoted: Array<{
    group: (typeof groups)[number]
    suggestion: (typeof suggestions)[number]
  }> = []
  for (const group of groups) {
    if (!isProjectedSuggestion(group)) continue
    const pairKey = existingLinks
      .filter((link) => link.groupId === group.id)
      .map((link) => link.transactionId)
      .sort()
      .join(':')
    const suggestion = suggestionByPairKey.get(pairKey)
    if (!suggestion || suggestion.type !== group.type) stale.push(group.id)
    else if (suggestion.autoConfirm) promoted.push({ group, suggestion })
  }
  if (stale.length || promoted.length) {
    db.transaction((transaction) => {
      for (const groupId of stale) {
        transaction
          .delete(schema.reconciliationLinks)
          .where(eq(schema.reconciliationLinks.groupId, groupId))
          .run()
        transaction
          .delete(schema.reconciliationGroups)
          .where(eq(schema.reconciliationGroups.id, groupId))
          .run()
      }
      for (const { group, suggestion } of promoted) {
        const categoryId = reconciliationCategory(group.type)
        for (const link of existingLinks) {
          if (link.groupId !== group.id) continue
          transaction
            .update(schema.reconciliationLinks)
            .set({
              previousCategoryId:
                transactionCategoryById.get(link.transactionId) ?? null,
            })
            .where(eq(schema.reconciliationLinks.id, link.id))
            .run()
          if (categoryId)
            transaction
              .update(schema.transactions)
              .set({ categoryId })
              .where(eq(schema.transactions.id, link.transactionId))
              .run()
        }
        transaction
          .update(schema.reconciliationGroups)
          .set({
            status: 'confirmed',
            confirmationSource: 'automatic',
            confidence: suggestion.confidence,
            reason: suggestion.reason,
          })
          .where(eq(schema.reconciliationGroups.id, group.id))
          .run()
        group.status = 'confirmed'
        group.confirmationSource = 'automatic'
      }
    })
    const staleIds = new Set(stale)
    groups.splice(
      0,
      groups.length,
      ...groups.filter((group) => !staleIds.has(group.id)),
    )
    existingLinks.splice(
      0,
      existingLinks.length,
      ...existingLinks.filter((link) => !staleIds.has(link.groupId)),
    )
  }
  const rejectedPairKeys = new Set(
    groups
      .filter((group) => group.status === 'rejected' && group.pairKey)
      .map((group) => group.pairKey),
  )
  const existingPairKeys = new Set(
    groups.map((group) => group.pairKey).filter(Boolean),
  )
  const transactionsById = new Map(
    transactionRows.map((transaction) => [transaction.id, transaction]),
  )
  const contextualTransactionsById = new Map(
    contextualTransactions.map((transaction) => [transaction.id, transaction]),
  )
  const accountNames = new Map(
    accountRows.map((account) => [account.id, account.name]),
  )
  const cardNames = new Map(cardRows.map((card) => [card.id, card.name]))
  const pendingSuggestions = suggestions
    .map((suggestion) => ({
      suggestion,
      pairKey: [...suggestion.transactionIds].sort().join(':'),
    }))
    .filter(
      ({ pairKey }) =>
        !rejectedPairKeys.has(pairKey) && !existingPairKeys.has(pairKey),
    )
  const validationTargets = [
    ...pendingSuggestions.map(({ suggestion, pairKey }) => ({
      candidateId: pairKey,
      type: suggestion.type,
      deterministicConfidence: suggestion.confidence,
      deterministicReason: suggestion.reason,
      transactionIds: suggestion.transactionIds,
      existingGroupId: null as string | null,
    })),
    ...groups
      .filter(
        (group) =>
          group.status === 'suggested' &&
          !group.aiValidation &&
          Boolean(group.pairKey),
      )
      .flatMap((group) => {
        const transactionIds = existingLinks
          .filter((link) => link.groupId === group.id)
          .map((link) => link.transactionId)
        if (!group.pairKey || transactionIds.length !== 2) return []
        return [
          {
            candidateId: group.pairKey,
            type: group.type,
            deterministicConfidence: group.confidence,
            deterministicReason:
              group.reason ?? 'Candidato encontrado pelas regras locais.',
            transactionIds: [transactionIds[0], transactionIds[1]] as [
              string,
              string,
            ],
            existingGroupId: group.id,
          },
        ]
      }),
  ]

  let aiValidations = new Map<
    string,
    Awaited<ReturnType<typeof validateReconciliationsWithAi>>[number]
  >()
  if (settingsRows[0]?.aiClassificationConsent) {
    try {
      const validationCandidates = validationTargets.flatMap(
        (validationTarget) => {
          const left = contextualTransactionsById.get(
            validationTarget.transactionIds[0],
          )
          const right = contextualTransactionsById.get(
            validationTarget.transactionIds[1],
          )
          if (!left || !right) return []
          const source = left.amountCents < 0 ? left : right
          const destination = left.amountCents < 0 ? right : left
          const context = (transaction: typeof source) => ({
            postedAt: transaction.postedAt,
            description: transaction.description,
            amountCents: transaction.amountCents,
            currency: transaction.currency,
            target: transaction.accountId
              ? (accountNames.get(transaction.accountId) ?? 'Conta removida')
              : transaction.creditCardId
                ? (cardNames.get(transaction.creditCardId) ?? 'Cartão removido')
                : 'Destino removido',
            scopeType: transaction.scopeType ?? null,
          })
          return [
            {
              candidateId: validationTarget.candidateId,
              type: validationTarget.type,
              deterministicConfidence: validationTarget.deterministicConfidence,
              deterministicReason: validationTarget.deterministicReason,
              source: context(source),
              destination: context(destination),
            },
          ]
        },
      )
      const validations =
        await validateReconciliationsWithAi(validationCandidates)
      aiValidations = new Map(
        validations.map((validation) => [validation.candidateId, validation]),
      )
    } catch {
      aiValidations = new Map()
    }
  }
  for (const validationTarget of validationTargets) {
    if (!validationTarget.existingGroupId) continue
    const aiValidation = aiValidations.get(validationTarget.candidateId)
    if (!aiValidation) continue
    await db
      .update(schema.reconciliationGroups)
      .set({
        aiValidation: aiValidation.verdict,
        aiConfidence: aiValidation.confidence,
        aiReason: aiValidation.reason,
        aiValidatedAt: new Date(),
      })
      .where(
        eq(schema.reconciliationGroups.id, validationTarget.existingGroupId),
      )
  }

  let inserted = 0
  for (const { suggestion, pairKey } of pendingSuggestions) {
    const aiValidation = aiValidations.get(pairKey)
    const groupId = randomUUID()
    db.transaction((transaction) => {
      transaction
        .insert(schema.reconciliationGroups)
        .values({
          id: groupId,
          type: suggestion.type,
          status: suggestion.autoConfirm ? 'confirmed' : 'suggested',
          confirmationSource: suggestion.autoConfirm ? 'automatic' : null,
          confidence: suggestion.confidence,
          reason: suggestion.reason,
          exchangeRateMicros: suggestion.exchangeRateMicros,
          pairKey,
          aiValidation: aiValidation?.verdict ?? null,
          aiConfidence: aiValidation?.confidence ?? null,
          aiReason: aiValidation?.reason ?? null,
          aiValidatedAt: aiValidation ? new Date() : null,
        })
        .run()
      transaction
        .insert(schema.reconciliationLinks)
        .values(
          suggestion.transactionIds.map((transactionId) => ({
            id: randomUUID(),
            groupId,
            transactionId,
            previousCategoryId:
              transactionsById.get(transactionId)?.categoryId ?? null,
            role:
              (transactionsById.get(transactionId)?.amountCents ?? 0) < 0
                ? 'source'
                : 'destination',
          })),
        )
        .run()
      if (suggestion.autoConfirm) {
        for (const transactionId of suggestion.transactionIds) {
          transaction
            .update(schema.transactions)
            .set({
              categoryId:
                suggestion.type === 'card_payment'
                  ? 'card_payment'
                  : 'transfer',
            })
            .where(eq(schema.transactions.id, transactionId))
            .run()
        }
      }
    })
    inserted += 1
  }
  return inserted
}

export type ReconciliationRefreshResult =
  | { status: 'refreshed'; inserted: number; recurrenceSuggestions: number }
  | { status: 'deferred'; inserted: 0; message: string }

export async function refreshReconciliationAfterCommit(): Promise<ReconciliationRefreshResult> {
  return measureOperation('reconciliation.refresh', {}, async () => {
    try {
      const inserted = await refreshReconciliationSuggestions()
      const recurrence = await refreshRecurrences()
      return {
        status: 'refreshed',
        inserted,
        recurrenceSuggestions: recurrence.suggestionCount,
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Falha desconhecida na reconciliação.'
      console.error(
        'Reconciliation refresh deferred after durable commit:',
        error,
      )
      return { status: 'deferred', inserted: 0, message }
    }
  })
}
