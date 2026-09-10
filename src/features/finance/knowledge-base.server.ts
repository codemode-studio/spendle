/**
 * Base de conhecimento das importações.
 *
 * Guarda somente decisões humanas: categoria escolhida na revisão de um lote ou
 * na lista de transações, e vínculos confirmados entre estabelecimento e
 * recorrência. Heurística, histórico implícito e IA nunca escrevem aqui.
 *
 * Entradas de categoria casam pelo padrão (`knowledgePattern`), exato ou por
 * prefixo; recorrências casam pela assinatura completa. As entradas não
 * dependem do ledger, por isso sobrevivem a limpezas e reimportações.
 */
import { randomUUID } from 'node:crypto'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'

import type { AppDatabase } from '#/db/connection.server'
import { db, ensureDatabase } from '#/db/index.server'
import * as schema from '#/db/schema'
import {
  isValidKnowledgePattern,
  knowledgePattern,
  knowledgeExactPatterns,
  knowledgePrefixCandidate,
  matchesKnowledgePrefix,
  normalizeKnowledgePattern,
} from '#/domain/knowledge-pattern'
import type { KnowledgeMatchMode } from '#/domain/knowledge-pattern'
import { merchantSignature } from '#/domain/recurrence-book'
import type { CategorySuggestion } from './categories.server'

export type KnowledgeWriter = Pick<
  AppDatabase,
  'insert' | 'delete' | 'select' | 'update'
>
export type KnowledgeSource =
  (typeof schema.knowledgeBase.$inferInsert)['source']
type KnowledgeDirection = 'income' | 'expense'

export interface KnowledgeKey {
  signature: string
  pattern: string
  direction: KnowledgeDirection
}

/** Categorias de sistema com regra própria; não viram aprendizado por estabelecimento. */
const UNLEARNABLE_CATEGORIES = new Set([
  'uncategorized',
  'transfer',
  'card_payment',
])

/** Confiança de uma sugestão vinda de um padrão exato. */
export const KNOWLEDGE_SUGGESTION_CONFIDENCE = 98
/** Confiança de uma sugestão vinda de um prefixo aprovado. */
export const KNOWLEDGE_PREFIX_CONFIDENCE = 92

const table = schema.knowledgeBase
const conflictKey = [
  table.kind,
  table.pattern,
  table.matchMode,
  table.direction,
]

export function knowledgeKey(input: {
  description: string
  amountCents: number
}): KnowledgeKey | null {
  if (input.amountCents === 0) return null
  const signature = merchantSignature(input.description)
  const pattern = knowledgePattern(input.description)
  if (
    !isValidKnowledgePattern(signature) ||
    !isValidKnowledgePattern(pattern)
  ) {
    return null
  }
  return {
    signature,
    pattern,
    direction: input.amountCents < 0 ? 'expense' : 'income',
  }
}

function lookupKey(key: { pattern: string; direction: KnowledgeDirection }) {
  return `${key.pattern}|${key.direction}`
}

/** Prefixo mais longo que cobre o padrão, na mesma direção. */
function coveringPrefix(
  writer: KnowledgeWriter,
  key: { pattern: string; direction: KnowledgeDirection },
) {
  const prefixes = writer
    .select({
      id: table.id,
      pattern: table.pattern,
      categoryId: table.categoryId,
    })
    .from(table)
    .where(
      and(
        eq(table.kind, 'category'),
        eq(table.matchMode, 'prefix'),
        eq(table.direction, key.direction),
      ),
    )
    .all()
  return prefixes
    .filter((prefix) => matchesKnowledgePrefix(key.pattern, prefix.pattern))
    .sort((left, right) => right.pattern.length - left.pattern.length)
    .at(0)
}

/**
 * Entradas exatas da mesma categoria cobertas por um prefixo são redundantes:
 * somam suas confirmações ao prefixo e deixam de existir.
 */
function absorbCoveredEntries(
  writer: KnowledgeWriter,
  prefix: {
    id: string
    pattern: string
    direction: KnowledgeDirection
    categoryId: string | null
  },
) {
  if (!prefix.categoryId) return
  const covered = writer
    .select({
      id: table.id,
      pattern: table.pattern,
      confirmations: table.confirmations,
    })
    .from(table)
    .where(
      and(
        eq(table.kind, 'category'),
        eq(table.matchMode, 'exact'),
        eq(table.direction, prefix.direction),
        eq(table.categoryId, prefix.categoryId),
      ),
    )
    .all()
    .filter((entry) => matchesKnowledgePrefix(entry.pattern, prefix.pattern))
  if (!covered.length) return
  writer
    .delete(table)
    .where(
      inArray(
        table.id,
        covered.map((entry) => entry.id),
      ),
    )
    .run()
  writer
    .update(table)
    .set({
      confirmations: sql`${table.confirmations} + ${covered.reduce(
        (total, entry) => total + entry.confirmations,
        0,
      )}`,
    })
    .where(eq(table.id, prefix.id))
    .run()
}

/**
 * Registra a categoria decidida para um estabelecimento. Reafirmar a mesma
 * categoria soma uma confirmação; trocar a categoria zera as confirmações e
 * conta uma correção. Devolve `false` quando não há o que aprender.
 */
export function learnCategory(
  writer: KnowledgeWriter,
  input: {
    description: string
    amountCents: number
    categoryId: string | null
    source: KnowledgeSource
  },
) {
  if (!input.categoryId || UNLEARNABLE_CATEGORIES.has(input.categoryId)) {
    return false
  }
  const key = knowledgeKey(input)
  if (!key) return false
  const prefix = coveringPrefix(writer, key)
  if (prefix && prefix.categoryId === input.categoryId) {
    // O prefixo já ensina isto; a decisão só o reafirma e derruba uma exceção
    // exata anterior deste estabelecimento, se havia.
    writer
      .update(table)
      .set({
        confirmations: sql`${table.confirmations} + 1`,
        lastLearnedAt: new Date(),
      })
      .where(eq(table.id, prefix.id))
      .run()
    writer
      .delete(table)
      .where(
        and(
          eq(table.kind, 'category'),
          eq(table.matchMode, 'exact'),
          eq(table.pattern, key.pattern),
          eq(table.direction, key.direction),
        ),
      )
      .run()
    return true
  }
  const sameDecision = sql`${table.categoryId} = excluded.category_id`
  writer
    .insert(table)
    .values({
      id: randomUUID(),
      kind: 'category',
      ...key,
      matchMode: 'exact',
      categoryId: input.categoryId,
      sampleDescription: input.description,
      source: input.source,
      lastLearnedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: conflictKey,
      set: {
        confirmations: sql`case when ${sameDecision} then ${table.confirmations} + 1 else 1 end`,
        corrections: sql`case when ${sameDecision} then ${table.corrections} else ${table.corrections} + 1 end`,
        categoryId: input.categoryId,
        signature: key.signature,
        sampleDescription: input.description,
        source: input.source,
        lastLearnedAt: new Date(),
      },
    })
    .run()
  return true
}

/** Registra que o estabelecimento pertence a uma recorrência. Casa pela assinatura completa. */
export function learnRecurrence(
  writer: KnowledgeWriter,
  input: {
    description: string
    amountCents: number
    recurrenceId: string
    source: KnowledgeSource
  },
) {
  const key = knowledgeKey(input)
  if (!key) return false
  const sameDecision = sql`${table.recurrenceId} = excluded.recurrence_id`
  writer
    .insert(table)
    .values({
      id: randomUUID(),
      kind: 'recurrence',
      signature: key.signature,
      pattern: key.signature,
      matchMode: 'exact',
      direction: key.direction,
      recurrenceId: input.recurrenceId,
      sampleDescription: input.description,
      source: input.source,
      lastLearnedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: conflictKey,
      set: {
        confirmations: sql`case when ${sameDecision} then ${table.confirmations} + 1 else 1 end`,
        corrections: sql`case when ${sameDecision} then ${table.corrections} else ${table.corrections} + 1 end`,
        recurrenceId: input.recurrenceId,
        sampleDescription: input.description,
        source: input.source,
        lastLearnedAt: new Date(),
      },
    })
    .run()
  return true
}

/** Desfaz o vínculo aprendido quando a pessoa desvincula o pagamento. */
export function forgetRecurrence(
  writer: KnowledgeWriter,
  input: { description: string; amountCents: number; recurrenceId: string },
) {
  const key = knowledgeKey(input)
  if (!key) return
  writer
    .delete(table)
    .where(
      and(
        eq(table.kind, 'recurrence'),
        eq(table.signature, key.signature),
        eq(table.direction, key.direction),
        eq(table.recurrenceId, input.recurrenceId),
      ),
    )
    .run()
}

type KnowledgeItem = { description: string; amountCents: number }

interface CategoryKnowledgeEntry {
  id: string
  categoryId: string
  confirmations: number
  matchMode: KnowledgeMatchMode
}

export type CategoryKnowledge = (
  item: KnowledgeItem,
) => CategoryKnowledgeEntry | null

/**
 * Carrega o matching das decisões humanas. Na preparação, limita os padrões
 * exatos aos itens do lote; a sincronização usa a base completa.
 * Índices e precedência ficam privados ao conhecimento.
 */
export async function loadCategoryKnowledge(
  items?: Array<KnowledgeItem>,
): Promise<CategoryKnowledge> {
  const patterns = items
    ? [
        ...new Set(
          items.flatMap((item) =>
            knowledgeKey(item) ? knowledgeExactPatterns(item.description) : [],
          ),
        ),
      ]
    : undefined
  const selection = {
    id: table.id,
    pattern: table.pattern,
    direction: table.direction,
    categoryId: table.categoryId,
    confirmations: table.confirmations,
    matchMode: table.matchMode,
  }
  const [exactRows, prefixRows] = await Promise.all([
    patterns?.length === 0
      ? []
      : db
          .select(selection)
          .from(table)
          .where(
            and(
              eq(table.kind, 'category'),
              eq(table.matchMode, 'exact'),
              patterns ? inArray(table.pattern, patterns) : undefined,
            ),
          ),
    db
      .select(selection)
      .from(table)
      .where(and(eq(table.kind, 'category'), eq(table.matchMode, 'prefix'))),
  ])
  const exact = new Map<string, CategoryKnowledgeEntry>()
  for (const row of exactRows) {
    if (row.categoryId)
      exact.set(lookupKey(row), {
        id: row.id,
        categoryId: row.categoryId,
        confirmations: row.confirmations,
        matchMode: row.matchMode,
      })
  }
  const prefixes = prefixRows
    .flatMap((row) =>
      row.categoryId
        ? [
            {
              pattern: row.pattern,
              direction: row.direction,
              entry: {
                id: row.id,
                categoryId: row.categoryId,
                confirmations: row.confirmations,
                matchMode: row.matchMode,
              },
            },
          ]
        : [],
    )
    .sort((left, right) => right.pattern.length - left.pattern.length)

  return (item) => {
    const key = knowledgeKey(item)
    if (!key) return null
    const direct = knowledgeExactPatterns(item.description)
      .map((pattern) =>
        exact.get(lookupKey({ pattern, direction: key.direction })),
      )
      .find((entry) => entry !== undefined)
    return (
      direct ??
      prefixes.find(
        (candidate) =>
          candidate.direction === key.direction &&
          matchesKnowledgePrefix(key.pattern, candidate.pattern),
      )?.entry ??
      null
    )
  }
}

/** Só substitui sugestões fracas; regras explícitas e transferências prevalecem. */
export function applyCategoryKnowledge(
  knowledge: CategoryKnowledge,
  item: KnowledgeItem,
  suggestion: CategorySuggestion,
): CategorySuggestion {
  if (suggestion.source !== 'none' && suggestion.source !== 'heuristic') {
    return suggestion
  }
  const entry = knowledge(item)
  if (!entry) return suggestion
  return {
    categoryId: entry.categoryId,
    confidence:
      entry.matchMode === 'exact'
        ? KNOWLEDGE_SUGGESTION_CONFIDENCE
        : KNOWLEDGE_PREFIX_CONFIDENCE,
    source: 'knowledge',
  }
}

/** Assinaturas aprendidas por recorrência, usadas na detecção e no matching. */
export async function loadRecurrenceKnowledge() {
  const rows = await db
    .select({ recurrenceId: table.recurrenceId, signature: table.signature })
    .from(table)
    .where(eq(table.kind, 'recurrence'))
  const byRecurrence = new Map<string, Set<string>>()
  for (const row of rows) {
    if (!row.recurrenceId) continue
    const aliases = byRecurrence.get(row.recurrenceId) ?? new Set<string>()
    aliases.add(row.signature)
    byRecurrence.set(row.recurrenceId, aliases)
  }
  return byRecurrence
}

export interface KnowledgeEntrySnapshot {
  id: string
  kind: 'category' | 'recurrence'
  signature: string
  pattern: string
  matchMode: KnowledgeMatchMode
  /** Agregador que poderia virar prefixo, quando o padrão começa por um deles. */
  prefixCandidate: string | null
  direction: KnowledgeDirection
  sampleDescription: string
  source: KnowledgeSource
  confirmations: number
  corrections: number
  /** Data ISO (UTC) da última decisão. */
  lastLearnedAt: string
  category: { id: string; name: string; color: string } | null
  recurrence: { id: string; name: string } | null
}

export interface KnowledgeBaseSnapshot {
  entries: KnowledgeEntrySnapshot[]
  categories: Array<{
    id: string
    name: string
    bucket: string
    color: string
    active: boolean
  }>
}

/** Read model da aba de configurações: entradas com nomes resolvidos e categorias para revisão. */
export async function getKnowledgeBaseSnapshot(): Promise<KnowledgeBaseSnapshot> {
  await ensureDatabase()
  const [rows, categories, recurrences] = await Promise.all([
    db.select().from(table).orderBy(desc(table.lastLearnedAt), table.pattern),
    db
      .select({
        id: schema.categories.id,
        name: schema.categories.name,
        bucket: schema.categories.bucket,
        color: schema.categories.color,
        active: schema.categories.active,
      })
      .from(schema.categories)
      .orderBy(schema.categories.name),
    db
      .select({ id: schema.recurrences.id, name: schema.recurrences.name })
      .from(schema.recurrences),
  ])
  const categoryById = new Map(categories.map((row) => [row.id, row]))
  const recurrenceById = new Map(recurrences.map((row) => [row.id, row]))
  return {
    entries: rows.map((row) => {
      const category = row.categoryId
        ? (categoryById.get(row.categoryId) ?? null)
        : null
      return {
        id: row.id,
        kind: row.kind,
        signature: row.signature,
        pattern: row.pattern,
        matchMode: row.matchMode,
        prefixCandidate:
          row.kind === 'category' && row.matchMode === 'exact'
            ? knowledgePrefixCandidate(row.pattern)
            : null,
        direction: row.direction,
        sampleDescription: row.sampleDescription,
        source: row.source,
        confirmations: row.confirmations,
        corrections: row.corrections,
        lastLearnedAt: row.lastLearnedAt.toISOString().slice(0, 10),
        category: category
          ? { id: category.id, name: category.name, color: category.color }
          : null,
        recurrence: row.recurrenceId
          ? (recurrenceById.get(row.recurrenceId) ?? null)
          : null,
      }
    }),
    categories,
  }
}

async function loadCategoryEntry(id: string) {
  const entry = (
    await db.select().from(table).where(eq(table.id, id)).limit(1)
  ).at(0)
  if (!entry) throw new Error('Aprendizado não encontrado.')
  if (entry.kind !== 'category') {
    throw new Error('Somente aprendizados de categoria podem ser editados.')
  }
  return entry
}

/** A pessoa corrige a categoria aprendida direto na base de conhecimento. */
export async function reviewKnowledgeCategory(input: {
  id: string
  categoryId: string
}) {
  await ensureDatabase()
  const entry = await loadCategoryEntry(input.id)
  if (UNLEARNABLE_CATEGORIES.has(input.categoryId)) {
    throw new Error('Escolha uma categoria de despesa ou de receita.')
  }
  const category = (
    await db
      .select({ id: schema.categories.id })
      .from(schema.categories)
      .where(eq(schema.categories.id, input.categoryId))
      .limit(1)
  ).at(0)
  if (!category) throw new Error('Categoria inválida.')
  const sameDecision = entry.categoryId === input.categoryId
  await db
    .update(table)
    .set({
      categoryId: input.categoryId,
      confirmations: sameDecision ? entry.confirmations + 1 : 1,
      corrections: sameDecision ? entry.corrections : entry.corrections + 1,
      source: 'knowledge_review',
      lastLearnedAt: new Date(),
    })
    .where(eq(table.id, input.id))
  return { id: input.id }
}

/**
 * A pessoa edita o padrão de casamento ou o transforma em prefixo. Um prefixo
 * casa qualquer estabelecimento cujo padrão comece por ele, no limite de token.
 */
export async function updateKnowledgePattern(input: {
  id: string
  pattern: string
  matchMode: KnowledgeMatchMode
}) {
  await ensureDatabase()
  const entry = await loadCategoryEntry(input.id)
  const pattern = normalizeKnowledgePattern(input.pattern)
  if (!isValidKnowledgePattern(pattern)) {
    throw new Error(
      'O padrão precisa de pelo menos três caracteres e uma letra.',
    )
  }
  const collision = (
    await db
      .select({ id: table.id })
      .from(table)
      .where(
        and(
          eq(table.kind, 'category'),
          eq(table.pattern, pattern),
          eq(table.matchMode, input.matchMode),
          eq(table.direction, entry.direction),
        ),
      )
      .limit(1)
  ).at(0)
  if (collision && collision.id !== entry.id) {
    throw new Error('Já existe um aprendizado com este padrão e modo.')
  }
  db.transaction((tx) => {
    tx.update(table)
      .set({
        pattern,
        matchMode: input.matchMode,
        source: 'knowledge_review',
        lastLearnedAt: new Date(),
      })
      .where(eq(table.id, input.id))
      .run()
    if (input.matchMode === 'prefix') {
      absorbCoveredEntries(tx, {
        id: entry.id,
        pattern,
        direction: entry.direction,
        categoryId: entry.categoryId,
      })
    }
  })
  return { id: input.id, pattern }
}

/** Remove um aprendizado; a próxima decisão humana recria a entrada. */
export async function forgetKnowledgeEntry(input: { id: string }) {
  await ensureDatabase()
  const deleted = await db
    .delete(table)
    .where(eq(table.id, input.id))
    .returning({ id: table.id })
  if (!deleted[0]) throw new Error('Aprendizado não encontrado.')
  return { id: input.id }
}
