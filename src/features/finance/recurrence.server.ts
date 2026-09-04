import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'

import { db, ensureDatabase } from '#/db/index.server'
import * as schema from '#/db/schema'
import {
  acceptedRecurrenceMatchStatuses,
  isAcceptedRecurrenceMatchStatus,
  merchantSignature,
  transactionEligibleForRecurrence,
} from '#/domain/recurrence-book'
import type { RecurrenceReconciliationType } from '#/domain/recurrence-book'
import { detectRecurrences, detectionKey } from '#/domain/recurrence-detection'
import type { DetectedRecurrence } from '#/domain/recurrence-detection'
import { buildRecurrenceCandidates } from '#/domain/recurrence-matching'
import type {
  RecurrenceLearning,
  RecurrenceTransactionInput,
} from '#/domain/recurrence-matching'
import { assertIsoDate, daysBetween, todayIso } from '#/domain/period'
import {
  addRecurrencePeriod,
  aggregateWindow,
  median,
  occurrenceDates,
  previousRecurrencePeriod,
} from '#/domain/recurrence-schedule'
import { normalizeDescription } from '#/domain/finance'

type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type RecurrenceRow = typeof schema.recurrences.$inferSelect
type OccurrenceRow = typeof schema.recurrenceOccurrences.$inferSelect
type MatchRow = typeof schema.recurrenceMatches.$inferSelect
type TransactionRow = typeof schema.transactions.$inferSelect

const NEVER_RECURRING_CATEGORIES = new Set(['transfer', 'card_payment'])
const DAY_MS = 86_400_000

export type RecurrenceInput = {
  name: string
  groupName?: string
  participantLabel?: string
  accountId?: string
  creditCardId?: string
  categoryId: string
  amountCents: number
  currency: string
  direction: 'income' | 'expense'
  amountMode: 'fixed' | 'variable'
  matchMode?: 'single' | 'aggregate'
  destinationMode: 'automatic' | 'fixed'
  frequency: 'monthly' | 'yearly'
  nextDate: string
}

export type InvalidRecurrenceDestinationCode =
  'multiple_destinations' | 'fixed_destination_required'

const recurrenceDestinationMessages: Record<
  InvalidRecurrenceDestinationCode,
  string
> = {
  multiple_destinations: 'Informe somente uma conta ou um cartão.',
  fixed_destination_required:
    'Escolha uma conta ou cartão para o destino fixo.',
}

export class InvalidRecurrenceDestinationError extends Error {
  readonly code: InvalidRecurrenceDestinationCode

  constructor(code: InvalidRecurrenceDestinationCode) {
    super(recurrenceDestinationMessages[code])
    this.name = 'InvalidRecurrenceDestinationError'
    this.code = code
  }
}

export function assertRecurrenceDestination(
  input: Pick<
    RecurrenceInput,
    'accountId' | 'creditCardId' | 'destinationMode'
  >,
) {
  const destinationCount =
    Number(Boolean(input.accountId)) + Number(Boolean(input.creditCardId))
  if (destinationCount > 1) {
    throw new InvalidRecurrenceDestinationError('multiple_destinations')
  }
  if (input.destinationMode === 'fixed' && destinationCount !== 1) {
    throw new InvalidRecurrenceDestinationError('fixed_destination_required')
  }
}

type CreateRecurrenceInput = RecurrenceInput & {
  startsOn?: string
  scheduleAnchor?: string
}

export type ApproveDetectedRecurrenceInput = {
  name: string
  categoryId: string
  amountCents: number
  currency: string
  direction: 'income' | 'expense'
  amountMode: 'fixed' | 'variable'
  frequency: 'monthly' | 'yearly'
  nextDate: string
  accountId?: string
  creditCardId?: string
  transactionIds: string[]
}

export type LinkCandidate = {
  id: string
  postedAt: string
  description: string
  amountCents: number
  currency: string
  baseAmountCents: number | null
  categoryId: string | null
  categoryName: string | null
  accountLabel: string | null
  cardLabel: string | null
  inWindow: boolean
  sameCategory: boolean
  amountDifferenceCents: number
  daysApart: number
  rank: number
}

type EngineState = {
  recurrences: RecurrenceRow[]
  transactions: TransactionRow[]
  occurrences: OccurrenceRow[]
  matches: MatchRow[]
  reconciliationByTransaction: Map<string, Set<RecurrenceReconciliationType>>
}

function pairKey(occurrenceId: string, transactionId: string) {
  return `${occurrenceId}:${transactionId}`
}

async function loadReconciliationTypes() {
  const [groups, links] = await Promise.all([
    db.select().from(schema.reconciliationGroups),
    db.select().from(schema.reconciliationLinks),
  ])
  const groupsById = new Map(groups.map((group) => [group.id, group]))
  const result = new Map<string, Set<RecurrenceReconciliationType>>()
  for (const link of links) {
    const group = groupsById.get(link.groupId)
    if (!group || group.status === 'rejected') continue
    const types = result.get(link.transactionId) ?? new Set()
    types.add(group.type)
    result.set(link.transactionId, types)
  }
  return result
}

async function loadEngineState(): Promise<EngineState> {
  const [recurrences, transactions, occurrences, matches, reconciliation] =
    await Promise.all([
      db.select().from(schema.recurrences),
      db.select().from(schema.transactions),
      db.select().from(schema.recurrenceOccurrences),
      db.select().from(schema.recurrenceMatches),
      loadReconciliationTypes(),
    ])
  return {
    recurrences,
    transactions,
    occurrences,
    matches,
    reconciliationByTransaction: reconciliation,
  }
}

async function resolveRecurrenceGroupId(groupName?: string) {
  const name = groupName?.trim()
  if (!name) return null

  const normalizedName = normalizeDescription(name)
  await db
    .insert(schema.recurrenceGroups)
    .values({ id: randomUUID(), name, normalizedName })
    .onConflictDoNothing({ target: schema.recurrenceGroups.normalizedName })

  const group = await db
    .select({ id: schema.recurrenceGroups.id })
    .from(schema.recurrenceGroups)
    .where(eq(schema.recurrenceGroups.normalizedName, normalizedName))
    .limit(1)
  if (!group[0]) throw new Error('Não foi possível criar o grupo.')
  return group[0].id
}

async function insertOccurrences(rows: OccurrenceRow[]) {
  for (let index = 0; index < rows.length; index += 50) {
    await db.insert(schema.recurrenceOccurrences).values(
      rows.slice(index, index + 50).map((row) => ({
        id: row.id,
        recurrenceId: row.recurrenceId,
        expectedDate: row.expectedDate,
        expectedAmountCents: row.expectedAmountCents,
        currency: row.currency,
        direction: row.direction,
        categoryId: row.categoryId,
        status: row.status,
      })),
    )
  }
}

async function insertMatch(
  values: Omit<
    typeof schema.recurrenceMatches.$inferInsert,
    'id' | 'status' | 'evidenceJson'
  > & { id?: string; evidenceJson: string },
): Promise<MatchRow> {
  const id = values.id ?? randomUUID()
  const insert = { ...values, id, status: 'suggested' as const }
  await db.insert(schema.recurrenceMatches).values(insert)
  return {
    ...insert,
    previousCategoryId: null,
    categoryAppliedByMatch: false,
    categoryConflict: false,
    confirmedAt: null,
    resolvedAt: null,
    createdAt: new Date(),
  } satisfies MatchRow
}

function advanceAfterClose(
  transaction: DatabaseTransaction,
  recurrence: RecurrenceRow,
  occurrence: OccurrenceRow,
) {
  if (occurrence.expectedDate < recurrence.nextDate) return
  const nextDate = addRecurrencePeriod(
    occurrence.expectedDate,
    recurrence.frequency,
    recurrence.scheduleAnchor,
  )
  transaction
    .update(schema.recurrences)
    .set({ nextDate })
    .where(eq(schema.recurrences.id, recurrence.id))
    .run()
  recurrence.nextDate = nextDate
}

function rewindAfterReopen(
  transaction: DatabaseTransaction,
  recurrence: RecurrenceRow,
  occurrence: OccurrenceRow,
) {
  if (occurrence.expectedDate >= recurrence.nextDate) return
  transaction
    .update(schema.recurrences)
    .set({ nextDate: occurrence.expectedDate })
    .where(eq(schema.recurrences.id, recurrence.id))
    .run()
  recurrence.nextDate = occurrence.expectedDate
}

function closeOccurrence(
  transaction: DatabaseTransaction,
  recurrence: RecurrenceRow,
  occurrence: OccurrenceRow,
  status: 'matched' | 'skipped',
  resolvedAt = new Date(),
) {
  transaction
    .update(schema.recurrenceOccurrences)
    .set({ status, resolvedAt })
    .where(eq(schema.recurrenceOccurrences.id, occurrence.id))
    .run()
  occurrence.status = status
  occurrence.resolvedAt = resolvedAt
  transaction
    .update(schema.recurrenceMatches)
    .set({ status: 'rejected', resolvedAt })
    .where(
      and(
        eq(schema.recurrenceMatches.occurrenceId, occurrence.id),
        eq(schema.recurrenceMatches.status, 'suggested'),
      ),
    )
    .run()
  advanceAfterClose(transaction, recurrence, occurrence)
}

function reopenOccurrence(
  transaction: DatabaseTransaction,
  recurrence: RecurrenceRow,
  occurrence: OccurrenceRow,
) {
  transaction
    .update(schema.recurrenceOccurrences)
    .set({ status: 'expected', resolvedAt: null })
    .where(eq(schema.recurrenceOccurrences.id, occurrence.id))
    .run()
  occurrence.status = 'expected'
  occurrence.resolvedAt = null
  rewindAfterReopen(transaction, recurrence, occurrence)
}

function settleMatch(
  transaction: DatabaseTransaction,
  input: {
    matchId: string
    existing: boolean
    occurrence: OccurrenceRow
    recurrence: RecurrenceRow
    row: TransactionRow
    automatic: boolean
    companyTransaction: boolean
    score: number
    reason: string
    evidenceJson: string
  },
) {
  const resolvedAt = new Date()
  const categoryCanBeApplied =
    !input.companyTransaction &&
    (!input.row.categoryId || input.row.categoryId === 'uncategorized')
  const categoryConflict =
    !input.companyTransaction &&
    Boolean(
      input.row.categoryId &&
      input.row.categoryId !== 'uncategorized' &&
      input.row.categoryId !== input.occurrence.categoryId,
    )
  if (categoryCanBeApplied) {
    transaction
      .update(schema.transactions)
      .set({ categoryId: input.occurrence.categoryId })
      .where(eq(schema.transactions.id, input.row.id))
      .run()
  }
  const settled = {
    status: input.automatic
      ? ('auto_confirmed' as const)
      : ('confirmed' as const),
    score: input.score,
    reason: input.reason,
    evidenceJson: input.evidenceJson,
    previousCategoryId: input.row.categoryId,
    categoryAppliedByMatch: categoryCanBeApplied,
    categoryConflict,
    confirmedAt: resolvedAt,
    resolvedAt,
  }
  if (input.existing) {
    transaction
      .update(schema.recurrenceMatches)
      .set(settled)
      .where(eq(schema.recurrenceMatches.id, input.matchId))
      .run()
  } else {
    transaction
      .insert(schema.recurrenceMatches)
      .values({
        id: input.matchId,
        occurrenceId: input.occurrence.id,
        transactionId: input.row.id,
        ...settled,
      })
      .run()
  }
  if (input.recurrence.matchMode === 'single') {
    closeOccurrence(
      transaction,
      input.recurrence,
      input.occurrence,
      'matched',
      resolvedAt,
    )
  }
}

async function transactionBelongsToCompany(transaction: TransactionRow) {
  const account = transaction.accountId
    ? await db
        .select({ scopeId: schema.accounts.ownershipScopeId })
        .from(schema.accounts)
        .where(eq(schema.accounts.id, transaction.accountId))
        .limit(1)
    : []
  const card = transaction.creditCardId
    ? await db
        .select({ scopeId: schema.creditCards.ownershipScopeId })
        .from(schema.creditCards)
        .where(eq(schema.creditCards.id, transaction.creditCardId))
        .limit(1)
    : []
  const scopeId = account[0]?.scopeId ?? card[0]?.scopeId
  if (!scopeId) return false
  const scope = await db
    .select({ type: schema.ownershipScopes.type })
    .from(schema.ownershipScopes)
    .where(eq(schema.ownershipScopes.id, scopeId))
    .limit(1)
  return scope[0]?.type === 'company_br' || scope[0]?.type === 'company_us'
}

function assertOccurrenceCanBeLinked(
  recurrence: RecurrenceRow | undefined,
  occurrence: OccurrenceRow | undefined,
) {
  if (!occurrence) throw new Error('Ocorrência não encontrada.')
  if (occurrence.status !== 'expected') {
    throw new Error('Esta ocorrência já foi resolvida.')
  }
  if (!recurrence?.active) {
    throw new Error('Reative a recorrência antes de confirmar um pagamento.')
  }
  return recurrence
}

type TransactionLinkIssue =
  | 'missing'
  | 'unconfirmed'
  | 'currency'
  | 'direction'
  | 'reconciliation'
  | 'accepted'

function transactionLinkIssue(input: {
  transaction: TransactionRow | undefined
  currency: string
  direction: OccurrenceRow['direction']
  reconciliationTypes: ReadonlySet<RecurrenceReconciliationType> | null
  accepted: boolean
}): TransactionLinkIssue | null {
  const transaction = input.transaction
  if (!transaction) return 'missing'
  if (transaction.status !== 'confirmed') return 'unconfirmed'
  if (transaction.currency !== input.currency) return 'currency'
  const expectedSign = input.direction === 'expense' ? -1 : 1
  if (Math.sign(transaction.amountCents) !== expectedSign) return 'direction'
  if (
    !transactionEligibleForRecurrence({
      counterpartyAccountId: transaction.counterpartyAccountId,
      reconciliationTypes: input.reconciliationTypes,
    })
  ) {
    return 'reconciliation'
  }
  return input.accepted ? 'accepted' : null
}

function assertTransactionCanBeLinked(input: {
  transaction: TransactionRow | undefined
  occurrence: OccurrenceRow
  reconciliationTypes: ReadonlySet<RecurrenceReconciliationType> | null
  accepted: boolean
}) {
  const transaction = input.transaction
  const issue = transactionLinkIssue({
    transaction,
    currency: input.occurrence.currency,
    direction: input.occurrence.direction,
    reconciliationTypes: input.reconciliationTypes,
    accepted: input.accepted,
  })
  if (issue === null) {
    if (!transaction) throw new Error('Transação não encontrada.')
    return transaction
  }
  switch (issue) {
    case 'missing':
      throw new Error('Transação não encontrada.')
    case 'unconfirmed':
      throw new Error('Confirme a transação antes de vinculá-la.')
    case 'currency':
      throw new Error(
        `Esta recorrência é em ${input.occurrence.currency}; escolha uma transação na mesma moeda.`,
      )
    case 'direction':
      throw new Error(
        input.occurrence.direction === 'expense'
          ? 'Esta recorrência é uma despesa; escolha uma saída.'
          : 'Esta recorrência é uma receita; escolha uma entrada.',
      )
    case 'reconciliation':
      throw new Error('Resolva primeiro a conciliação financeira da transação.')
    case 'accepted':
      throw new Error('Esta transação já está vinculada a outra recorrência.')
  }
}

async function compensateDetectedRecurrence(recurrenceId: string) {
  const matches = await db
    .select({
      transactionId: schema.recurrenceMatches.transactionId,
      previousCategoryId: schema.recurrenceMatches.previousCategoryId,
      categoryAppliedByMatch: schema.recurrenceMatches.categoryAppliedByMatch,
      appliedCategoryId: schema.recurrenceOccurrences.categoryId,
    })
    .from(schema.recurrenceMatches)
    .innerJoin(
      schema.recurrenceOccurrences,
      eq(
        schema.recurrenceOccurrences.id,
        schema.recurrenceMatches.occurrenceId,
      ),
    )
    .where(eq(schema.recurrenceOccurrences.recurrenceId, recurrenceId))

  db.transaction((transaction) => {
    for (const match of matches) {
      if (!match.categoryAppliedByMatch) continue
      transaction
        .update(schema.transactions)
        .set({ categoryId: match.previousCategoryId })
        .where(
          and(
            eq(schema.transactions.id, match.transactionId),
            eq(schema.transactions.categoryId, match.appliedCategoryId),
          ),
        )
        .run()
    }
    transaction
      .delete(schema.recurrences)
      .where(eq(schema.recurrences.id, recurrenceId))
      .run()
  })
}

async function settleSuggestedMatch(
  matchId: string,
  automatic: boolean,
  reconciliationByTransaction?: Map<string, Set<RecurrenceReconciliationType>>,
) {
  const match = await db
    .select()
    .from(schema.recurrenceMatches)
    .where(eq(schema.recurrenceMatches.id, matchId))
    .limit(1)
  if (!match[0]) throw new Error('Correspondência não encontrada.')
  const [occurrences, rows] = await Promise.all([
    db
      .select()
      .from(schema.recurrenceOccurrences)
      .where(eq(schema.recurrenceOccurrences.id, match[0].occurrenceId))
      .limit(1),
    db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, match[0].transactionId))
      .limit(1),
  ])
  const occurrence = occurrences.at(0)
  const row = rows.at(0)
  if (!occurrence || !row) {
    throw new Error('A ocorrência ou transação não existe mais.')
  }
  if (match[0].status !== 'suggested' || occurrence.status !== 'expected') {
    throw new Error('Esta correspondência não está mais disponível.')
  }
  const recurrences = await db
    .select()
    .from(schema.recurrences)
    .where(eq(schema.recurrences.id, occurrence.recurrenceId))
    .limit(1)
  const recurrence = assertOccurrenceCanBeLinked(recurrences[0], occurrence)
  const reconciliation =
    reconciliationByTransaction ?? (await loadReconciliationTypes())
  assertTransactionCanBeLinked({
    transaction: row,
    occurrence,
    reconciliationTypes: reconciliation.get(row.id) ?? null,
    accepted: false,
  })
  const companyTransaction = await transactionBelongsToCompany(row)
  db.transaction((transaction) => {
    settleMatch(transaction, {
      matchId,
      existing: true,
      occurrence,
      recurrence,
      row,
      automatic,
      companyTransaction,
      score: match[0].score,
      reason: match[0].reason,
      evidenceJson: match[0].evidenceJson,
    })
  })
  return { id: matchId, recurrence }
}

function learnedAliases(input: {
  recurrenceId: string
  acceptedMatches: MatchRow[]
  occurrenceById: Map<string, OccurrenceRow>
  transactionById: Map<string, TransactionRow>
}) {
  const aliases = new Set<string>()
  for (const match of input.acceptedMatches) {
    const occurrence = input.occurrenceById.get(match.occurrenceId)
    if (occurrence?.recurrenceId !== input.recurrenceId) continue
    const row = input.transactionById.get(match.transactionId)
    if (!row) continue
    const signature = merchantSignature(row.description)
    if (signature.length > 1) aliases.add(signature)
  }
  return aliases
}

function learnFromHistory(input: {
  recurrence: RecurrenceRow
  state: EngineState
  acceptedMatches: MatchRow[]
  occurrenceById: Map<string, OccurrenceRow>
  transactionById: Map<string, TransactionRow>
}) {
  const confirmedForRecurrence = input.acceptedMatches.filter(
    (match) =>
      input.occurrenceById.get(match.occurrenceId)?.recurrenceId ===
      input.recurrence.id,
  )
  const learnedTransactions = confirmedForRecurrence.flatMap((match) => {
    const row = input.transactionById.get(match.transactionId)
    return row ? [row] : []
  })
  const observations = confirmedForRecurrence.flatMap((match) => {
    const occurrence = input.occurrenceById.get(match.occurrenceId)
    const row = input.transactionById.get(match.transactionId)
    if (!occurrence || !row) return []
    return [
      {
        dateOffset:
          (Date.parse(`${row.postedAt.slice(0, 10)}T12:00:00Z`) -
            Date.parse(`${occurrence.expectedDate}T12:00:00Z`)) /
          DAY_MS,
        amountCents: Math.abs(row.amountCents),
      },
    ]
  })
  const medianDateOffsetDays = median(
    observations.map((observation) => observation.dateOffset),
  )
  const amounts = observations.map((observation) => observation.amountCents)
  const rejectionCount = input.state.matches.filter(
    (match) =>
      match.status === 'rejected' &&
      input.occurrenceById.get(match.occurrenceId)?.recurrenceId ===
        input.recurrence.id,
  ).length
  const learning: RecurrenceLearning = {
    confirmedCount: confirmedForRecurrence.length,
    aliases: [
      ...learnedAliases({
        recurrenceId: input.recurrence.id,
        acceptedMatches: input.acceptedMatches,
        occurrenceById: input.occurrenceById,
        transactionById: input.transactionById,
      }),
    ],
    accountIds: [
      ...(input.recurrence.accountId ? [input.recurrence.accountId] : []),
      ...learnedTransactions.flatMap((row) =>
        row.accountId ? [row.accountId] : [],
      ),
    ],
    creditCardIds: [
      ...(input.recurrence.creditCardId ? [input.recurrence.creditCardId] : []),
      ...learnedTransactions.flatMap((row) =>
        row.creditCardId ? [row.creditCardId] : [],
      ),
    ],
    medianDateOffsetDays,
    dateSpreadDays:
      medianDateOffsetDays === undefined
        ? undefined
        : Math.max(
            ...observations.map((observation) =>
              Math.abs(observation.dateOffset - medianDateOffsetDays),
            ),
          ),
    amountRangeCents: amounts.length
      ? { min: Math.min(...amounts), max: Math.max(...amounts) }
      : undefined,
    rejectionCount,
  }
  return { learning, learnedTransactions }
}

function transactionInputs(state: EngineState): RecurrenceTransactionInput[] {
  return state.transactions.map((transaction) => ({
    id: transaction.id,
    postedAt: transaction.postedAt,
    amountCents: transaction.amountCents,
    currency: transaction.currency,
    description: transaction.description,
    status: transaction.status,
    accountId: transaction.accountId,
    creditCardId: transaction.creditCardId,
    counterpartyAccountId: transaction.counterpartyAccountId,
    categoryId: transaction.categoryId,
    reconciliationTypes:
      state.reconciliationByTransaction.get(transaction.id) ?? null,
  }))
}

async function generateSchedule(state: EngineState, today: string) {
  const existing = new Set(
    state.occurrences.map((occurrence) =>
      pairKey(occurrence.recurrenceId, occurrence.expectedDate),
    ),
  )
  const rows: OccurrenceRow[] = []
  for (const recurrence of state.recurrences) {
    if (!recurrence.active || !recurrence.categoryId) continue
    for (const expectedDate of occurrenceDates(recurrence, { today })) {
      const key = pairKey(recurrence.id, expectedDate)
      if (existing.has(key)) continue
      existing.add(key)
      rows.push({
        id: randomUUID(),
        recurrenceId: recurrence.id,
        expectedDate,
        expectedAmountCents: Math.abs(recurrence.amountCents),
        currency: recurrence.currency,
        direction: recurrence.direction,
        categoryId: recurrence.categoryId,
        status: 'expected',
        resolvedAt: null,
        createdAt: new Date(),
      })
    }
  }
  await insertOccurrences(rows)
  state.occurrences.push(...rows)
  return rows.length
}

type RefreshBookkeeping = {
  matchByPair: Map<string, MatchRow>
  unavailableTransactionIds: Set<string>
  createdSuggestionIds: Set<string>
  autoConfirmCount: number
}

async function proposeSingleOccurrence(input: {
  recurrence: RecurrenceRow
  occurrence: OccurrenceRow
  state: EngineState
  learning: RecurrenceLearning
  transactions: RecurrenceTransactionInput[]
  bookkeeping: RefreshBookkeeping
}) {
  const candidates = buildRecurrenceCandidates({
    recurrenceName: input.recurrence.name,
    rule: {
      expectedDate: input.occurrence.expectedDate,
      expectedAmountCents: input.occurrence.expectedAmountCents,
      currency: input.occurrence.currency,
      direction: input.occurrence.direction,
      amountMode: input.recurrence.amountMode,
      destinationMode: input.recurrence.destinationMode,
      accountId: input.recurrence.accountId,
      creditCardId: input.recurrence.creditCardId,
      dateToleranceDays: input.recurrence.dateToleranceDays,
      amountToleranceBps: input.recurrence.amountToleranceBps,
      autoMatchEnabled: input.recurrence.autoMatchEnabled,
      minimumConfirmations: input.recurrence.minimumConfirmations,
    },
    transactions: input.transactions,
    learning: input.learning,
    unavailableTransactionIds: input.bookkeeping.unavailableTransactionIds,
  })
  for (const candidate of candidates.slice(0, 3)) {
    const key = pairKey(input.occurrence.id, candidate.transactionId)
    let match = input.bookkeeping.matchByPair.get(key)
    if (match && match.status !== 'suggested') continue
    if (!match) {
      match = await insertMatch({
        occurrenceId: input.occurrence.id,
        transactionId: candidate.transactionId,
        score: candidate.score,
        reason: candidate.reason,
        evidenceJson: JSON.stringify(candidate.evidence),
      })
      input.state.matches.push(match)
      input.bookkeeping.matchByPair.set(key, match)
      if (!candidate.autoConfirm) {
        input.bookkeeping.createdSuggestionIds.add(match.id)
      }
    }
    if (!candidate.autoConfirm) continue
    await settleSuggestedMatch(
      match.id,
      true,
      input.state.reconciliationByTransaction,
    )
    match.status = 'auto_confirmed'
    input.bookkeeping.unavailableTransactionIds.add(candidate.transactionId)
    input.bookkeeping.autoConfirmCount += 1
    break
  }
}

async function proposeAggregateOccurrence(input: {
  recurrence: RecurrenceRow
  occurrence: OccurrenceRow
  state: EngineState
  aliases: Set<string>
  today: string
  bookkeeping: RefreshBookkeeping
}) {
  const window = aggregateWindow(input.occurrence, input.recurrence)
  const expectedSign = input.occurrence.direction === 'expense' ? -1 : 1
  for (const transaction of input.state.transactions) {
    if (
      transaction.status !== 'confirmed' ||
      transaction.currency !== input.occurrence.currency ||
      Math.sign(transaction.amountCents) !== expectedSign ||
      input.bookkeeping.unavailableTransactionIds.has(transaction.id) ||
      transaction.postedAt < window.start ||
      transaction.postedAt >= window.end ||
      !transactionEligibleForRecurrence({
        counterpartyAccountId: transaction.counterpartyAccountId,
        reconciliationTypes:
          input.state.reconciliationByTransaction.get(transaction.id) ?? null,
      })
    ) {
      continue
    }
    const knownMerchant = input.aliases.has(
      merchantSignature(transaction.description),
    )
    const sameCategory = transaction.categoryId === input.recurrence.categoryId
    const trustedDistribution =
      input.occurrence.direction === 'income' &&
      sameCategory &&
      Boolean(
        input.state.reconciliationByTransaction
          .get(transaction.id)
          ?.has('profit_distribution'),
      )
    const autoConfirm = knownMerchant || trustedDistribution
    if (!knownMerchant && !sameCategory) continue

    const key = pairKey(input.occurrence.id, transaction.id)
    let match = input.bookkeeping.matchByPair.get(key)
    if (match && match.status !== 'suggested') continue
    if (!match) {
      match = await insertMatch({
        occurrenceId: input.occurrence.id,
        transactionId: transaction.id,
        score: autoConfirm ? 95 : 60,
        reason: knownMerchant
          ? 'estabelecimento já confirmado neste envelope'
          : trustedDistribution
            ? 'distribuição de lucro conciliada no período'
            : 'mesma categoria no período',
        evidenceJson: JSON.stringify({
          aggregate: true,
          knownMerchant,
          trustedDistribution,
        }),
      })
      input.state.matches.push(match)
      input.bookkeeping.matchByPair.set(key, match)
      if (!autoConfirm) input.bookkeeping.createdSuggestionIds.add(match.id)
    }
    if (!autoConfirm) continue
    await settleSuggestedMatch(
      match.id,
      true,
      input.state.reconciliationByTransaction,
    )
    match.status = 'auto_confirmed'
    input.bookkeeping.unavailableTransactionIds.add(transaction.id)
    input.bookkeeping.autoConfirmCount += 1
  }

  if (window.end > input.today) return
  const accepted = input.state.matches.some(
    (match) =>
      match.occurrenceId === input.occurrence.id &&
      isAcceptedRecurrenceMatchStatus(match.status),
  )
  if (!accepted) return
  db.transaction((transaction) => {
    closeOccurrence(transaction, input.recurrence, input.occurrence, 'matched')
  })
  for (const match of input.state.matches) {
    if (
      match.occurrenceId === input.occurrence.id &&
      match.status === 'suggested'
    ) {
      match.status = 'rejected'
      input.bookkeeping.createdSuggestionIds.delete(match.id)
    }
  }
}

export async function refreshRecurrences(options: { today?: string } = {}) {
  await ensureDatabase()
  const today = options.today ?? todayIso()
  const state = await loadEngineState()

  const occurrenceCount = await generateSchedule(state, today)

  const occurrenceById = new Map(
    state.occurrences.map((occurrence) => [occurrence.id, occurrence]),
  )
  const transactionById = new Map(
    state.transactions.map((transaction) => [transaction.id, transaction]),
  )
  const acceptedMatches = state.matches.filter((match) =>
    isAcceptedRecurrenceMatchStatus(match.status),
  )
  const bookkeeping: RefreshBookkeeping = {
    matchByPair: new Map(
      state.matches.map((match) => [
        pairKey(match.occurrenceId, match.transactionId),
        match,
      ]),
    ),
    unavailableTransactionIds: new Set(
      acceptedMatches.map((match) => match.transactionId),
    ),
    createdSuggestionIds: new Set(),
    autoConfirmCount: 0,
  }
  const transactions = transactionInputs(state)

  for (const occurrence of state.occurrences) {
    if (occurrence.status !== 'expected') continue
    const recurrence = state.recurrences.find(
      (candidate) => candidate.id === occurrence.recurrenceId,
    )
    if (!recurrence?.active) continue
    const history = learnFromHistory({
      recurrence,
      state,
      acceptedMatches,
      occurrenceById,
      transactionById,
    })
    if (recurrence.matchMode === 'aggregate') {
      await proposeAggregateOccurrence({
        recurrence,
        occurrence,
        state,
        aliases: new Set(history.learning.aliases),
        today,
        bookkeeping,
      })
    } else {
      await proposeSingleOccurrence({
        recurrence,
        occurrence,
        state,
        learning: history.learning,
        transactions,
        bookkeeping,
      })
    }
  }

  return {
    occurrenceCount,
    suggestionCount: bookkeeping.createdSuggestionIds.size,
    autoConfirmCount: bookkeeping.autoConfirmCount,
  }
}

export async function createRecurrence(input: CreateRecurrenceInput) {
  assertRecurrenceDestination(input)
  await ensureDatabase()
  const { groupName, participantLabel, startsOn, scheduleAnchor, ...values } =
    input
  const groupId = await resolveRecurrenceGroupId(groupName)
  const row = {
    id: randomUUID(),
    ...values,
    matchMode: values.matchMode ?? 'single',
    groupId,
    participantLabel: groupId ? participantLabel?.trim() || null : null,
    accountId: values.accountId || null,
    creditCardId: values.creditCardId || null,
    amountCents: Math.abs(values.amountCents),
    startsOn: startsOn ?? values.nextDate,
    scheduleAnchor: scheduleAnchor ?? values.nextDate,
  }
  await db.insert(schema.recurrences).values(row)
  await refreshRecurrences()
  return row
}

export async function updateRecurrence(id: string, input: RecurrenceInput) {
  assertRecurrenceDestination(input)
  await ensureDatabase()
  const current = await db
    .select()
    .from(schema.recurrences)
    .where(eq(schema.recurrences.id, id))
    .limit(1)
  if (!current[0]) throw new Error('Recorrência não encontrada.')
  const { groupName, participantLabel, ...values } = input
  const groupId = await resolveRecurrenceGroupId(groupName)
  const expectedOccurrences = await db
    .select()
    .from(schema.recurrenceOccurrences)
    .where(
      and(
        eq(schema.recurrenceOccurrences.recurrenceId, id),
        eq(schema.recurrenceOccurrences.status, 'expected'),
      ),
    )
  const matches = expectedOccurrences.length
    ? await db
        .select()
        .from(schema.recurrenceMatches)
        .where(
          inArray(
            schema.recurrenceMatches.occurrenceId,
            expectedOccurrences.map((occurrence) => occurrence.id),
          ),
        )
    : []
  const keepOccurrenceIds = new Set(
    matches
      .filter((match) => isAcceptedRecurrenceMatchStatus(match.status))
      .map((match) => match.occurrenceId),
  )
  const scheduleChanged =
    values.nextDate !== current[0].nextDate ||
    values.frequency !== current[0].frequency

  db.transaction((transaction) => {
    for (const occurrence of expectedOccurrences) {
      if (keepOccurrenceIds.has(occurrence.id)) continue
      transaction
        .delete(schema.recurrenceOccurrences)
        .where(eq(schema.recurrenceOccurrences.id, occurrence.id))
        .run()
    }
    transaction
      .update(schema.recurrences)
      .set({
        ...values,
        matchMode: values.matchMode ?? 'single',
        groupId,
        participantLabel: groupId ? participantLabel?.trim() || null : null,
        accountId: values.accountId || null,
        creditCardId: values.creditCardId || null,
        amountCents: Math.abs(values.amountCents),
        ...(scheduleChanged
          ? { startsOn: values.nextDate, scheduleAnchor: values.nextDate }
          : {}),
      })
      .where(eq(schema.recurrences.id, id))
      .run()
  })
  await refreshRecurrences()
  return { id }
}

export async function setRecurrenceActive(input: {
  id: string
  active: boolean
}) {
  await ensureDatabase()
  await db
    .update(schema.recurrences)
    .set({ active: input.active })
    .where(eq(schema.recurrences.id, input.id))
  if (input.active) await refreshRecurrences()
  return input
}

export async function deleteRecurrence(id: string) {
  await ensureDatabase()
  const occurrences = await db
    .select({ id: schema.recurrenceOccurrences.id })
    .from(schema.recurrenceOccurrences)
    .where(eq(schema.recurrenceOccurrences.recurrenceId, id))
  const matches = occurrences.length
    ? await db
        .select()
        .from(schema.recurrenceMatches)
        .where(
          inArray(
            schema.recurrenceMatches.occurrenceId,
            occurrences.map((occurrence) => occurrence.id),
          ),
        )
    : []
  if (matches.some((match) => isAcceptedRecurrenceMatchStatus(match.status))) {
    throw new Error(
      'Desvincule os pagamentos confirmados antes de excluir a recorrência.',
    )
  }
  await db.delete(schema.recurrences).where(eq(schema.recurrences.id, id))
  return { id }
}

export async function confirmMatch(matchId: string) {
  await ensureDatabase()
  const result = await settleSuggestedMatch(matchId, false)
  if (result.recurrence.matchMode === 'aggregate') {
    await refreshRecurrences()
  }
  return { id: matchId }
}

export async function rejectMatch(matchId: string) {
  await ensureDatabase()
  const match = await db
    .select({ status: schema.recurrenceMatches.status })
    .from(schema.recurrenceMatches)
    .where(eq(schema.recurrenceMatches.id, matchId))
    .limit(1)
  if (match[0]?.status !== 'suggested') {
    throw new Error('Somente sugestões abertas podem ser rejeitadas.')
  }
  await db
    .update(schema.recurrenceMatches)
    .set({ status: 'rejected', resolvedAt: new Date() })
    .where(eq(schema.recurrenceMatches.id, matchId))
  return { id: matchId }
}

export async function unlinkMatch(matchId: string) {
  await ensureDatabase()
  const match = await db
    .select()
    .from(schema.recurrenceMatches)
    .where(eq(schema.recurrenceMatches.id, matchId))
    .limit(1)
  if (!match[0]) throw new Error('Correspondência não encontrada.')
  if (!isAcceptedRecurrenceMatchStatus(match[0].status)) {
    throw new Error('Somente vínculos confirmados podem ser desfeitos.')
  }
  const [occurrences, rows] = await Promise.all([
    db
      .select()
      .from(schema.recurrenceOccurrences)
      .where(eq(schema.recurrenceOccurrences.id, match[0].occurrenceId))
      .limit(1),
    db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, match[0].transactionId))
      .limit(1),
  ])
  const occurrence = occurrences.at(0)
  const row = rows.at(0)
  const recurrences = occurrence
    ? await db
        .select()
        .from(schema.recurrences)
        .where(eq(schema.recurrences.id, occurrence.recurrenceId))
        .limit(1)
    : []
  if (!occurrence || !recurrences[0]) {
    throw new Error('A ocorrência ou recorrência não existe mais.')
  }
  db.transaction((transaction) => {
    if (
      match[0].categoryAppliedByMatch &&
      row?.categoryId === occurrence.categoryId
    ) {
      transaction
        .update(schema.transactions)
        .set({ categoryId: match[0].previousCategoryId })
        .where(eq(schema.transactions.id, match[0].transactionId))
        .run()
    }
    transaction
      .update(schema.recurrenceMatches)
      .set({ status: 'unlinked', resolvedAt: new Date() })
      .where(eq(schema.recurrenceMatches.id, matchId))
      .run()
    reopenOccurrence(transaction, recurrences[0], occurrence)
  })
  return { id: matchId }
}

export async function completeOccurrence(occurrenceId: string) {
  await ensureDatabase()
  const occurrence = await db
    .select()
    .from(schema.recurrenceOccurrences)
    .where(eq(schema.recurrenceOccurrences.id, occurrenceId))
    .limit(1)
  if (occurrence[0]?.status !== 'expected') {
    throw new Error('Somente ocorrências abertas podem ser concluídas.')
  }
  const [recurrences, matches] = await Promise.all([
    db
      .select()
      .from(schema.recurrences)
      .where(eq(schema.recurrences.id, occurrence[0].recurrenceId))
      .limit(1),
    db
      .select()
      .from(schema.recurrenceMatches)
      .where(eq(schema.recurrenceMatches.occurrenceId, occurrenceId)),
  ])
  if (!matches.some((match) => isAcceptedRecurrenceMatchStatus(match.status))) {
    throw new Error(
      'Vincule pelo menos um lançamento antes de concluir o período.',
    )
  }
  if (!recurrences[0]) throw new Error('Recorrência não encontrada.')
  db.transaction((transaction) => {
    closeOccurrence(transaction, recurrences[0], occurrence[0], 'matched')
  })
  await refreshRecurrences()
  return { id: occurrenceId }
}

export async function skipOccurrence(occurrenceId: string) {
  await ensureDatabase()
  const occurrence = await db
    .select()
    .from(schema.recurrenceOccurrences)
    .where(eq(schema.recurrenceOccurrences.id, occurrenceId))
    .limit(1)
  if (occurrence[0]?.status !== 'expected') {
    throw new Error('Somente ocorrências pendentes podem ser ignoradas.')
  }
  const recurrence = await db
    .select()
    .from(schema.recurrences)
    .where(eq(schema.recurrences.id, occurrence[0].recurrenceId))
    .limit(1)
  if (!recurrence[0]) throw new Error('Recorrência não encontrada.')
  db.transaction((transaction) => {
    closeOccurrence(transaction, recurrence[0], occurrence[0], 'skipped')
  })
  await refreshRecurrences()
  return { id: occurrenceId }
}

export async function linkTransactions(input: {
  occurrenceId: string
  transactionIds: string[]
}) {
  await ensureDatabase()
  const occurrence = await db
    .select()
    .from(schema.recurrenceOccurrences)
    .where(eq(schema.recurrenceOccurrences.id, input.occurrenceId))
    .limit(1)
  const recurrences = occurrence[0]
    ? await db
        .select()
        .from(schema.recurrences)
        .where(eq(schema.recurrences.id, occurrence[0].recurrenceId))
        .limit(1)
    : []
  const recurrence = assertOccurrenceCanBeLinked(recurrences[0], occurrence[0])
  const transactionIds = [...new Set(input.transactionIds)]
  if (!transactionIds.length) throw new Error('Selecione uma transação.')
  if (recurrence.matchMode !== 'aggregate' && transactionIds.length > 1) {
    throw new Error(
      'Esta recorrência aceita um pagamento por período. Para somar vários lançamentos, marque-a como envelope.',
    )
  }
  const [rows, matches, reconciliation] = await Promise.all([
    db
      .select()
      .from(schema.transactions)
      .where(inArray(schema.transactions.id, transactionIds)),
    db
      .select()
      .from(schema.recurrenceMatches)
      .where(inArray(schema.recurrenceMatches.transactionId, transactionIds)),
    loadReconciliationTypes(),
  ])
  const rowById = new Map(rows.map((row) => [row.id, row]))
  const contexts = await Promise.all(
    transactionIds.map(async (transactionId) => {
      const row = assertTransactionCanBeLinked({
        transaction: rowById.get(transactionId),
        occurrence: occurrence[0],
        reconciliationTypes: reconciliation.get(transactionId) ?? null,
        accepted: matches.some(
          (match) =>
            match.transactionId === transactionId &&
            isAcceptedRecurrenceMatchStatus(match.status),
        ),
      })
      return {
        row,
        existing: matches.find(
          (match) =>
            match.transactionId === transactionId &&
            match.occurrenceId === input.occurrenceId,
        ),
        companyTransaction: await transactionBelongsToCompany(row),
      }
    }),
  )

  db.transaction((transaction) => {
    for (const context of contexts) {
      settleMatch(transaction, {
        matchId: context.existing?.id ?? randomUUID(),
        existing: Boolean(context.existing),
        occurrence: occurrence[0],
        recurrence,
        row: context.row,
        automatic: false,
        companyTransaction: context.companyTransaction,
        score: 100,
        reason: 'vinculado manualmente',
        evidenceJson: JSON.stringify({ manual: true }),
      })
    }
  })
  if (recurrence.matchMode === 'aggregate') await refreshRecurrences()
  return { id: input.occurrenceId, linked: contexts.length }
}

export async function listLinkCandidates(input: {
  occurrenceId: string
  today?: string
}): Promise<LinkCandidate[]> {
  if (input.today) assertIsoDate(input.today)
  await ensureDatabase()
  const occurrence = await db
    .select()
    .from(schema.recurrenceOccurrences)
    .where(eq(schema.recurrenceOccurrences.id, input.occurrenceId))
    .limit(1)
  const recurrences = occurrence[0]
    ? await db
        .select()
        .from(schema.recurrences)
        .where(eq(schema.recurrences.id, occurrence[0].recurrenceId))
        .limit(1)
    : []
  const recurrence = assertOccurrenceCanBeLinked(recurrences[0], occurrence[0])
  const [rows, matches, categories, accounts, cards, reconciliation] =
    await Promise.all([
      db.select().from(schema.transactions),
      db.select().from(schema.recurrenceMatches),
      db.select().from(schema.categories),
      db.select().from(schema.accounts),
      db.select().from(schema.creditCards),
      loadReconciliationTypes(),
    ])
  const takenIds = new Set(
    matches
      .filter((match) => isAcceptedRecurrenceMatchStatus(match.status))
      .map((match) => match.transactionId),
  )
  const categoryById = new Map(
    categories.map((category) => [category.id, category]),
  )
  const accountById = new Map(accounts.map((account) => [account.id, account]))
  const cardById = new Map(cards.map((card) => [card.id, card]))
  const window = aggregateWindow(occurrence[0], recurrence)
  const expectedSign = occurrence[0].direction === 'expense' ? -1 : 1

  return rows
    .flatMap((row) => {
      if (
        row.status !== 'confirmed' ||
        row.currency !== occurrence[0].currency ||
        Math.sign(row.amountCents) !== expectedSign ||
        takenIds.has(row.id) ||
        !transactionEligibleForRecurrence({
          counterpartyAccountId: row.counterpartyAccountId,
          reconciliationTypes: reconciliation.get(row.id) ?? null,
        })
      ) {
        return []
      }
      const amountDifferenceCents = Math.abs(
        Math.abs(row.amountCents) - occurrence[0].expectedAmountCents,
      )
      const distance = daysBetween(occurrence[0].expectedDate, row.postedAt, {
        inclusive: false,
        absolute: true,
      })
      const inWindow = row.postedAt >= window.start && row.postedAt < window.end
      const sameCategory = row.categoryId === recurrence.categoryId
      const rank =
        recurrence.matchMode === 'aggregate'
          ? (inWindow ? 0 : 1_000) + (sameCategory ? 0 : 500) + distance
          : (amountDifferenceCents /
              Math.max(occurrence[0].expectedAmountCents, 1)) *
              100 +
            distance
      return [
        {
          id: row.id,
          postedAt: row.postedAt,
          description: row.description,
          amountCents: row.amountCents,
          currency: row.currency,
          baseAmountCents: row.baseAmountCents,
          categoryId: row.categoryId,
          categoryName: row.categoryId
            ? (categoryById.get(row.categoryId)?.name ?? null)
            : null,
          accountLabel: row.accountId
            ? (accountById.get(row.accountId)?.name ?? null)
            : null,
          cardLabel: row.creditCardId
            ? (cardById.get(row.creditCardId)?.name ?? null)
            : null,
          inWindow,
          sameCategory,
          amountDifferenceCents,
          daysApart: distance,
          rank,
        },
      ]
    })
    .sort((left, right) => left.rank - right.rank)
}

export async function detectRecurrenceCandidates(
  options: { today?: string } = {},
): Promise<DetectedRecurrence[]> {
  await ensureDatabase()
  const state = await loadEngineState()
  const ignores = await db.select().from(schema.recurrenceDetectionIgnores)
  const occurrenceById = new Map(
    state.occurrences.map((occurrence) => [occurrence.id, occurrence]),
  )
  const transactionById = new Map(
    state.transactions.map((transaction) => [transaction.id, transaction]),
  )
  const acceptedMatches = state.matches.filter((match) =>
    isAcceptedRecurrenceMatchStatus(match.status),
  )
  const acceptedTransactionIds = new Set(
    acceptedMatches.map((match) => match.transactionId),
  )
  const knownSignatures = new Set<string>()
  for (const recurrence of state.recurrences) {
    knownSignatures.add(merchantSignature(recurrence.name))
    for (const alias of learnedAliases({
      recurrenceId: recurrence.id,
      acceptedMatches,
      occurrenceById,
      transactionById,
    })) {
      knownSignatures.add(alias)
    }
  }
  knownSignatures.delete('')

  return detectRecurrences({
    transactions: state.transactions.map((transaction) => ({
      id: transaction.id,
      postedAt: transaction.postedAt,
      amountCents: transaction.amountCents,
      currency: transaction.currency,
      description: transaction.description,
      status: transaction.status,
      accountId: transaction.accountId,
      creditCardId: transaction.creditCardId,
      categoryId: transaction.categoryId,
      counterpartyAccountId: transaction.counterpartyAccountId,
      reconciliationTypes:
        state.reconciliationByTransaction.get(transaction.id) ?? null,
    })),
    excludedTransactionIds: acceptedTransactionIds,
    knownSignatures,
    ignoredKeys: new Set(
      ignores.map((ignore) => detectionKey(ignore.signature, ignore.direction)),
    ),
    excludedCategoryIds: NEVER_RECURRING_CATEGORIES,
    today: options.today,
  })
}

export async function approveDetectedRecurrence(
  input: ApproveDetectedRecurrenceInput,
) {
  await ensureDatabase()
  const category = await db
    .select()
    .from(schema.categories)
    .where(eq(schema.categories.id, input.categoryId))
    .limit(1)
  const allowedBuckets =
    input.direction === 'income' ? ['income'] : ['essential', 'lifestyle']
  if (!category[0] || !allowedBuckets.includes(category[0].bucket)) {
    throw new Error(
      input.direction === 'income'
        ? 'Escolha uma categoria de receita para esta recorrência.'
        : 'Escolha uma categoria de despesa (essencial ou estilo de vida).',
    )
  }
  const transactionIds = [...new Set(input.transactionIds)]
  if (!transactionIds.length) {
    throw new Error(
      'Nenhuma das transações detectadas continua disponível para vinculação.',
    )
  }
  const [rows, matches, reconciliation] = await Promise.all([
    db
      .select()
      .from(schema.transactions)
      .where(inArray(schema.transactions.id, transactionIds)),
    db
      .select()
      .from(schema.recurrenceMatches)
      .where(inArray(schema.recurrenceMatches.transactionId, transactionIds)),
    loadReconciliationTypes(),
  ])
  const rowsById = new Map(rows.map((row) => [row.id, row]))
  const acceptedTransactionIds = new Set(
    matches
      .filter((match) => isAcceptedRecurrenceMatchStatus(match.status))
      .map((match) => match.transactionId),
  )
  const eligibleRows = transactionIds
    .flatMap((transactionId) => {
      const row = rowsById.get(transactionId)
      return row &&
        transactionLinkIssue({
          transaction: row,
          currency: input.currency,
          direction: input.direction,
          reconciliationTypes: reconciliation.get(transactionId) ?? null,
          accepted: acceptedTransactionIds.has(transactionId),
        }) === null
        ? [row]
        : []
    })
    .sort((left, right) => left.postedAt.localeCompare(right.postedAt))
  if (!eligibleRows.length) {
    throw new Error(
      'Nenhuma das transações detectadas continua disponível para vinculação.',
    )
  }
  const earliestPostingDate = eligibleRows[0].postedAt.slice(0, 10)
  let startsOn = input.nextDate
  while (startsOn > earliestPostingDate) {
    startsOn = previousRecurrencePeriod(
      startsOn,
      input.frequency,
      input.nextDate,
    )
  }
  const recurrence = await createRecurrence({
    name: input.name,
    categoryId: input.categoryId,
    amountCents: Math.abs(input.amountCents),
    currency: input.currency,
    direction: input.direction,
    amountMode: input.amountMode,
    matchMode: 'single',
    destinationMode: 'automatic',
    frequency: input.frequency,
    nextDate: input.nextDate,
    startsOn,
    scheduleAnchor: input.nextDate,
    accountId: input.accountId,
    creditCardId: input.creditCardId,
  })
  try {
    const occurrences = await db
      .select()
      .from(schema.recurrenceOccurrences)
      .where(eq(schema.recurrenceOccurrences.recurrenceId, recurrence.id))
    const available = occurrences.filter(
      (occurrence) => occurrence.status === 'expected',
    )
    let linked = 0
    for (const row of eligibleRows) {
      const occurrence = available
        .filter((candidate) => candidate.status === 'expected')
        .sort(
          (left, right) =>
            daysBetween(left.expectedDate, row.postedAt, {
              inclusive: false,
              absolute: true,
            }) -
              daysBetween(right.expectedDate, row.postedAt, {
                inclusive: false,
                absolute: true,
              }) || left.expectedDate.localeCompare(right.expectedDate),
        )
        .at(0)
      if (!occurrence) break
      await linkTransactions({
        occurrenceId: occurrence.id,
        transactionIds: [row.id],
      })
      occurrence.status = 'matched'
      linked += 1
    }
    const today = todayIso()
    const recurrences = await db
      .select()
      .from(schema.recurrences)
      .where(eq(schema.recurrences.id, recurrence.id))
      .limit(1)
    if (!recurrences[0]) throw new Error('Recorrência não encontrada.')
    db.transaction((transaction) => {
      for (const occurrence of available) {
        if (
          occurrence.status === 'expected' &&
          occurrence.expectedDate < today
        ) {
          closeOccurrence(transaction, recurrences[0], occurrence, 'skipped')
        }
      }
    })
    await refreshRecurrences()
    return { id: recurrence.id, linked }
  } catch (error) {
    await compensateDetectedRecurrence(recurrence.id)
    throw error
  }
}

export async function ignoreDetectedRecurrence(input: {
  signature: string
  direction: 'income' | 'expense'
}) {
  await ensureDatabase()
  await db
    .insert(schema.recurrenceDetectionIgnores)
    .values({ id: randomUUID(), ...input })
    .onConflictDoNothing()
  return { ignored: true }
}

export function noteTransactionCategoryChanged(
  transaction: DatabaseTransaction,
  input: { transactionId: string; categoryId: string },
) {
  const row = transaction
    .select({
      accountId: schema.transactions.accountId,
      creditCardId: schema.transactions.creditCardId,
    })
    .from(schema.transactions)
    .where(eq(schema.transactions.id, input.transactionId))
    .get()
  const account = row?.accountId
    ? transaction
        .select({ scopeId: schema.accounts.ownershipScopeId })
        .from(schema.accounts)
        .where(eq(schema.accounts.id, row.accountId))
        .get()
    : null
  const card = row?.creditCardId
    ? transaction
        .select({ scopeId: schema.creditCards.ownershipScopeId })
        .from(schema.creditCards)
        .where(eq(schema.creditCards.id, row.creditCardId))
        .get()
    : null
  const scopeId = account?.scopeId ?? card?.scopeId
  const scope = scopeId
    ? transaction
        .select({ type: schema.ownershipScopes.type })
        .from(schema.ownershipScopes)
        .where(eq(schema.ownershipScopes.id, scopeId))
        .get()
    : null
  const companyTransaction =
    scope?.type === 'company_br' || scope?.type === 'company_us'
  const acceptedMatches = transaction
    .select()
    .from(schema.recurrenceMatches)
    .where(
      and(
        eq(schema.recurrenceMatches.transactionId, input.transactionId),
        inArray(schema.recurrenceMatches.status, [
          ...acceptedRecurrenceMatchStatuses,
        ]),
      ),
    )
    .all()
  const occurrences = acceptedMatches.length
    ? transaction
        .select()
        .from(schema.recurrenceOccurrences)
        .where(
          inArray(
            schema.recurrenceOccurrences.id,
            acceptedMatches.map((match) => match.occurrenceId),
          ),
        )
        .all()
    : []
  const occurrenceById = new Map(
    occurrences.map((occurrence) => [occurrence.id, occurrence]),
  )
  for (const match of acceptedMatches) {
    const occurrence = occurrenceById.get(match.occurrenceId)
    if (!occurrence) continue
    transaction
      .update(schema.recurrenceMatches)
      .set({
        categoryConflict:
          !companyTransaction && occurrence.categoryId !== input.categoryId,
      })
      .where(eq(schema.recurrenceMatches.id, match.id))
      .run()
  }
}
