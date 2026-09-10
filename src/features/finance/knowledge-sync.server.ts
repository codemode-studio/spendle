/**
 * Sincronização das categorias dos lançamentos com a base de conhecimento.
 *
 * A base é a fonte da verdade depois de editada; este módulo reaplica suas
 * decisões aos lançamentos existentes. Duas portas de entrada:
 * - escopo de uma entrada, chamado automaticamente após editar a base;
 * - sincronização completa, disparada pelo botão em Transações com prévia.
 *
 * Transferências e pagamentos de fatura nunca são tocados; a base não aprende
 * essas categorias e a reconciliação é dona delas.
 */
import { and, eq, isNull, ne } from 'drizzle-orm'

import { db, ensureDatabase } from '#/db/index.server'
import * as schema from '#/db/schema'
import type { KnowledgeMatchMode } from '#/domain/knowledge-pattern'
import {
  loadCategoryKnowledge,
  reviewKnowledgeCategory,
  updateKnowledgePattern,
} from './knowledge-base.server'
import { noteTransactionCategoryChanged } from './recurrence.server'

const PROTECTED_CATEGORIES = new Set(['transfer', 'card_payment'])

export interface KnowledgeSyncChange {
  transactionId: string
  entryId: string
  postedAt: string
  description: string
  amountCents: number
  fromCategoryId: string | null
  fromCategoryName: string
  toCategoryId: string
  toCategoryName: string
}

export interface KnowledgeSyncPlan {
  /** Lançamentos considerados (confirmados ou pendentes, sem contraparte). */
  scanned: number
  changes: KnowledgeSyncChange[]
}

/** Calcula o que a sincronização mudaria, sem escrever nada. */
export async function planKnowledgeSync(
  options: { entryId?: string } = {},
): Promise<KnowledgeSyncPlan> {
  await ensureDatabase()
  const [resolve, transactions, categories] = await Promise.all([
    loadCategoryKnowledge(),
    db
      .select({
        id: schema.transactions.id,
        postedAt: schema.transactions.postedAt,
        description: schema.transactions.description,
        amountCents: schema.transactions.amountCents,
        categoryId: schema.transactions.categoryId,
      })
      .from(schema.transactions)
      .where(
        and(
          ne(schema.transactions.status, 'excluded'),
          isNull(schema.transactions.counterpartyAccountId),
        ),
      ),
    db
      .select({ id: schema.categories.id, name: schema.categories.name })
      .from(schema.categories),
  ])
  const categoryName = new Map(categories.map((row) => [row.id, row.name]))
  const changes: KnowledgeSyncChange[] = []
  for (const transaction of transactions) {
    const current = transaction.categoryId
    if (current && PROTECTED_CATEGORIES.has(current)) continue
    const resolved = resolve(transaction)
    if (!resolved) continue
    if (options.entryId && resolved.id !== options.entryId) continue
    if (resolved.categoryId === current) continue
    changes.push({
      transactionId: transaction.id,
      entryId: resolved.id,
      postedAt: transaction.postedAt,
      description: transaction.description,
      amountCents: transaction.amountCents,
      fromCategoryId: current,
      fromCategoryName: current
        ? (categoryName.get(current) ?? current)
        : 'Sem categoria',
      toCategoryId: resolved.categoryId,
      toCategoryName:
        categoryName.get(resolved.categoryId) ?? resolved.categoryId,
    })
  }
  changes.sort(
    (left, right) =>
      right.postedAt.localeCompare(left.postedAt) ||
      left.description.localeCompare(right.description),
  )
  return { scanned: transactions.length, changes }
}

/** Aplica o plano; devolve quantos lançamentos mudaram. */
export async function applyKnowledgeSync(options: { entryId?: string } = {}) {
  const plan = await planKnowledgeSync(options)
  if (!plan.changes.length) return { changed: 0 }
  db.transaction((tx) => {
    for (const change of plan.changes) {
      tx.update(schema.transactions)
        .set({ categoryId: change.toCategoryId })
        .where(eq(schema.transactions.id, change.transactionId))
        .run()
      noteTransactionCategoryChanged(tx, {
        transactionId: change.transactionId,
        categoryId: change.toCategoryId,
      })
    }
  })
  return { changed: plan.changes.length }
}

/** Corrige a categoria de uma entrada e reaplica aos lançamentos dela. */
export async function reviewKnowledgeCategoryAndSync(input: {
  id: string
  categoryId: string
}) {
  await reviewKnowledgeCategory(input)
  const { changed } = await applyKnowledgeSync({ entryId: input.id })
  return { id: input.id, synced: changed }
}

/** Edita o padrão de uma entrada e reaplica aos lançamentos que ela passa a cobrir. */
export async function updateKnowledgePatternAndSync(input: {
  id: string
  pattern: string
  matchMode: KnowledgeMatchMode
}) {
  const result = await updateKnowledgePattern(input)
  const { changed } = await applyKnowledgeSync({ entryId: input.id })
  return { ...result, synced: changed }
}
