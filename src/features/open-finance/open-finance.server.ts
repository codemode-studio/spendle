import { createHash, randomUUID } from 'node:crypto'

import {
  and,
  asc,
  desc,
  eq,
  gte,
  isNull,
  lt,
  lte,
  max,
  or,
  sql,
  sum,
} from 'drizzle-orm'
import type { Account, Item, Transaction } from 'pluggy-sdk'

import { db, ensureDatabase } from '#/db/index.server'
import * as schema from '#/db/schema'
import { suggestCategory } from '#/features/finance/categories.server'
import {
  addBalanceCheckpoint,
  invalidateCheckpointChain,
  refreshStatementAnchor,
} from '#/features/finance/checkpoint-chain.server'
import {
  createAccount,
  createCreditCard,
} from '#/features/finance/finance.server'
import { refreshReconciliationAfterCommit } from '#/features/finance/reconciliation-refresh.server'

import { shiftDays } from '#/domain/period'

import { getPluggyConfiguration } from './config.server'
import { pluggyContinuationStart, pluggyHistoryStart } from './history-window'
import type { PluggyHistoryMonths } from './history-window'
import {
  dateInSaoPaulo,
  normalizePluggyTransaction,
  pluggyAccountObservation,
} from './normalization'
import type {
  NormalizedPluggyTransaction,
  PluggyWebhookPayload,
} from './normalization'
import { getPluggyGateway, PluggyIntegrationError } from './pluggy.server'
import type { PluggyGateway } from './pluggy.server'

type Connection = typeof schema.openFinanceConnections.$inferSelect
type OpenFinanceAccount = typeof schema.openFinanceAccounts.$inferSelect
type SyncTrigger = NonNullable<
  typeof schema.openFinanceSyncRuns.$inferInsert.trigger
>

function connectionStatus(item: Item): Connection['status'] {
  const byStatus: Partial<Record<Item['status'], Connection['status']>> = {
    UPDATED: 'updated',
    UPDATING: 'updating',
    WAITING_USER_INPUT: 'waiting_user_input',
    WAITING_USER_ACTION: 'waiting_user_action',
    LOGIN_ERROR: 'login_error',
    OUTDATED: 'outdated',
  }
  return byStatus[item.status] ?? 'error'
}

function itemPatch(item: Item) {
  return {
    connectorId: item.connector.id,
    connectorName: item.connector.name,
    connectorImageUrl: item.connector.imageUrl,
    status: connectionStatus(item),
    executionStatus: item.executionStatus,
    lastSyncedAt: item.lastUpdatedAt,
    nextSyncAt: item.nextAutoSyncAt,
    errorCode: item.error?.code ?? null,
    errorMessage: item.error ? item.error.message.slice(0, 500) : null,
  }
}

async function requireConnection(connectionId: string) {
  const connection = (
    await db
      .select()
      .from(schema.openFinanceConnections)
      .where(eq(schema.openFinanceConnections.id, connectionId))
      .limit(1)
  ).at(0)
  if (!connection) throw new Error('Conexão Open Finance não encontrada.')
  return connection
}

async function requireProviderAccount(providerAccountId: string) {
  const account = (
    await db
      .select()
      .from(schema.openFinanceAccounts)
      .where(
        eq(schema.openFinanceAccounts.providerAccountId, providerAccountId),
      )
      .limit(1)
  ).at(0)
  if (!account) throw new Error('Conta da Pluggy não encontrada.')
  return account
}

async function saveProviderAccounts(connectionId: string, accounts: Account[]) {
  const observedAt = new Date()
  for (const account of accounts) {
    const observation = pluggyAccountObservation(account)
    await db
      .insert(schema.openFinanceAccounts)
      .values({
        id: randomUUID(),
        connectionId,
        ...observation,
        observedAt,
      })
      .onConflictDoUpdate({
        target: schema.openFinanceAccounts.providerAccountId,
        set: { ...observation, connectionId, observedAt },
      })
  }
}

export async function createPluggyConnectToken(
  input: { ownershipScopeId: string; connectionId?: string },
  gateway: PluggyGateway = getPluggyGateway(),
) {
  await ensureDatabase()
  const scope = (
    await db
      .select({ id: schema.ownershipScopes.id })
      .from(schema.ownershipScopes)
      .where(
        and(
          eq(schema.ownershipScopes.id, input.ownershipScopeId),
          eq(schema.ownershipScopes.active, true),
        ),
      )
      .limit(1)
  ).at(0)
  if (!scope) throw new Error('Proprietário não encontrado.')

  let connection: Connection
  if (input.connectionId) {
    connection = await requireConnection(input.connectionId)
    if (connection.ownershipScopeId !== input.ownershipScopeId) {
      throw new Error('A conexão não pertence ao proprietário selecionado.')
    }
    if (!connection.providerItemId) {
      throw new Error('A conexão ainda não possui um Item para reconectar.')
    }
  } else {
    const id = randomUUID()
    connection = {
      id,
      ownershipScopeId: input.ownershipScopeId,
      providerItemId: null,
      clientUserId: id,
      connectorId: null,
      connectorName: null,
      connectorImageUrl: null,
      status: 'pending',
      executionStatus: null,
      lastSyncedAt: null,
      nextSyncAt: null,
      errorCode: null,
      errorMessage: null,
      paused: false,
      disconnectedAt: null,
      createdAt: new Date(),
    }
    await db.insert(schema.openFinanceConnections).values({
      id,
      ownershipScopeId: input.ownershipScopeId,
      clientUserId: id,
      status: 'pending',
    })
  }

  try {
    const token = await gateway.createConnectToken({
      clientUserId: connection.clientUserId,
      itemId: connection.providerItemId ?? undefined,
    })
    return { connectionId: connection.id, accessToken: token.accessToken }
  } catch (error) {
    if (!input.connectionId) {
      await db
        .delete(schema.openFinanceConnections)
        .where(eq(schema.openFinanceConnections.id, connection.id))
    }
    throw error
  }
}

export async function registerPluggyItem(
  input: { connectionId: string; itemId: string },
  gateway: PluggyGateway = getPluggyGateway(),
) {
  await ensureDatabase()
  const connection = await requireConnection(input.connectionId)
  const item = await gateway.fetchItem(input.itemId)
  if (item.clientUserId !== connection.clientUserId) {
    throw new Error('O Item retornado não pertence a esta conexão.')
  }
  if (connection.providerItemId && connection.providerItemId !== input.itemId) {
    throw new Error('A reconexão retornou um Item diferente do esperado.')
  }
  const accounts = await gateway.fetchAccounts(item.id)
  db.transaction((transaction) => {
    transaction
      .update(schema.openFinanceConnections)
      .set({ providerItemId: item.id, paused: false, ...itemPatch(item) })
      .where(eq(schema.openFinanceConnections.id, connection.id))
      .run()
  })
  await saveProviderAccounts(connection.id, accounts)
  return { connectionId: connection.id, accountCount: accounts.length }
}

export type MapPluggyAccountInput = {
  providerAccountId: string
  historyMonths?: PluggyHistoryMonths
} & (
  | {
      existingTarget: { type: 'account' | 'card'; id: string }
      newTarget?: never
    }
  | {
      existingTarget?: never
      newTarget:
        | {
            type: 'account'
            name: string
            kind: 'checking' | 'savings'
            purpose: 'operating' | 'reserve' | 'investment'
          }
        | {
            type: 'card'
            name: string
            limitCents: number
            closingDay: number
            dueDay?: number
          }
    }
)

export async function mapPluggyAccount(
  input: MapPluggyAccountInput,
  gateway: PluggyGateway = getPluggyGateway(),
  now = new Date(),
) {
  await ensureDatabase()
  const providerAccount = await requireProviderAccount(input.providerAccountId)
  const connection = await requireConnection(providerAccount.connectionId)
  if (connection.paused || connection.status === 'disconnected') {
    throw new Error('Retome a conexão antes de vincular uma conta.')
  }
  const expectedTarget = providerAccount.type === 'BANK' ? 'account' : 'card'
  const requestedTarget = input.existingTarget?.type ?? input.newTarget?.type
  if (requestedTarget !== expectedTarget) {
    throw new Error(
      providerAccount.type === 'BANK'
        ? 'Uma conta bancária da Pluggy deve ser vinculada a uma conta local.'
        : 'Um cartão da Pluggy deve ser vinculado a um cartão local.',
    )
  }

  let accountId: string | null = null
  let creditCardId: string | null = null
  let closingDay: number | undefined
  if (input.existingTarget) {
    if (input.existingTarget.type === 'account') {
      const target = (
        await db
          .select()
          .from(schema.accounts)
          .where(eq(schema.accounts.id, input.existingTarget.id))
          .limit(1)
      ).at(0)
      if (
        !target?.active ||
        target.ownershipScopeId !== connection.ownershipScopeId ||
        target.currency !== providerAccount.currency
      ) {
        throw new Error('A conta local não é compatível com esta conexão.')
      }
      accountId = target.id
    } else {
      const target = (
        await db
          .select()
          .from(schema.creditCards)
          .where(eq(schema.creditCards.id, input.existingTarget.id))
          .limit(1)
      ).at(0)
      if (
        !target?.active ||
        target.ownershipScopeId !== connection.ownershipScopeId ||
        target.currency !== providerAccount.currency
      ) {
        throw new Error('O cartão local não é compatível com esta conexão.')
      }
      creditCardId = target.id
      closingDay = target.closingDay
    }
  } else if (input.newTarget.type === 'account') {
    const target = await createAccount({
      name: input.newTarget.name,
      institutionName: connection.connectorName ?? 'Open Finance',
      ownershipScopeId: connection.ownershipScopeId,
      kind: input.newTarget.kind,
      purpose: input.newTarget.purpose,
      currency: providerAccount.currency,
      initialBalanceCents: 0,
    })
    accountId = target.id
  } else {
    const target = await createCreditCard({
      name: input.newTarget.name,
      institutionName: connection.connectorName ?? 'Open Finance',
      ownershipScopeId: connection.ownershipScopeId,
      currency: providerAccount.currency,
      lastFour: providerAccount.lastFour ?? undefined,
      limitCents: input.newTarget.limitCents,
      closingDay: input.newTarget.closingDay,
      dueDay: input.newTarget.dueDay,
    })
    creditCardId = target.id
    closingDay = input.newTarget.closingDay
  }

  // Only settled facts up to today prove where local history ends; pending,
  // excluded or future-dated rows would skip real transactions before them.
  const today = dateInSaoPaulo(now)
  const latestLocal = (
    await db
      .select({ postedAt: max(schema.transactions.postedAt) })
      .from(schema.transactions)
      .where(
        and(
          accountId
            ? eq(schema.transactions.accountId, accountId)
            : eq(schema.transactions.creditCardId, creditCardId!),
          eq(schema.transactions.status, 'confirmed'),
          lte(schema.transactions.postedAt, today),
        ),
      )
  ).at(0)?.postedAt
  // Mapping the same account again while its bootstrap is unfinished keeps
  // the original window: facts it already copied are not local history.
  const resumesBootstrap =
    providerAccount.historyBootstrap === 'pending' &&
    providerAccount.historyStart !== null &&
    accountId !== null &&
    providerAccount.accountId === accountId
  const historyStart = resumesBootstrap
    ? providerAccount.historyStart!
    : latestLocal
      ? pluggyContinuationStart(latestLocal)
      : pluggyHistoryStart({
          today,
          months: input.historyMonths ?? 3,
          closingDay,
        })
  // A bank account copied from scratch is only initialized once its opening
  // balance is recorded; until then every full sync retries it.
  const historyBootstrap =
    accountId && (resumesBootstrap || !latestLocal)
      ? ('pending' as const)
      : ('complete' as const)

  await db
    .update(schema.openFinanceAccounts)
    .set({ accountId, creditCardId, historyStart, historyBootstrap })
    .where(eq(schema.openFinanceAccounts.id, providerAccount.id))
  const mapped = {
    ...providerAccount,
    accountId,
    creditCardId,
    historyStart,
    historyBootstrap,
  }
  const result = await syncProviderAccount(mapped, gateway, undefined, now)
  await refreshReconciliationAfterCommit()
  return {
    accountId,
    creditCardId,
    historyStart,
    ...result,
  }
}

type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

const inferredOpeningMethod = 'pluggy_booked_balance_minus_copied_movement'

function copiedMovementCents(
  transaction: DatabaseTransaction,
  input: { accountId: string; historyStart: string; balanceAsOf: string },
) {
  const movement = transaction
    .select({ totalCents: sum(schema.transactions.amountCents) })
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.accountId, input.accountId),
        eq(schema.transactions.status, 'confirmed'),
        gte(schema.transactions.postedAt, input.historyStart),
        lte(schema.transactions.postedAt, input.balanceAsOf),
      ),
    )
    .get()
  return Number(movement?.totalCents ?? 0)
}

/**
 * A bank account copied from `historyStart` has no earlier facts, so its
 * opening balance is the booked balance Pluggy reports minus the copied
 * movement. The available balance is never used: it may include overdraft
 * or blocked funds that posted transactions do not explain.
 */
async function completeHistoryBootstrap(
  account: OpenFinanceAccount,
  now: Date,
) {
  if (
    account.historyBootstrap !== 'pending' ||
    !account.accountId ||
    !account.historyStart ||
    account.observedBalanceCents === null
  ) {
    return null
  }
  const accountId = account.accountId
  const historyStart = account.historyStart
  const bookedBalanceCents = account.observedBalanceCents
  const balanceAsOf = dateInSaoPaulo(account.observedAt ?? now)
  return db.transaction((transaction) => {
    const claimed = transaction
      .update(schema.openFinanceAccounts)
      .set({ historyBootstrap: 'complete' })
      .where(
        and(
          eq(schema.openFinanceAccounts.id, account.id),
          eq(schema.openFinanceAccounts.historyBootstrap, 'pending'),
        ),
      )
      .run()
    if (claimed.changes === 0) return null
    const openingBalanceCents =
      bookedBalanceCents -
      copiedMovementCents(transaction, { accountId, historyStart, balanceAsOf })
    addBalanceCheckpoint(transaction, {
      accountId,
      kind: 'opening',
      balanceType: 'posted',
      source: 'integration',
      reviewState: 'observed',
      verified: false,
      balanceCents: openingBalanceCents,
      asOf: shiftDays(historyStart, -1),
      evidenceJson: JSON.stringify({
        method: inferredOpeningMethod,
        providerBookedBalanceCents: bookedBalanceCents,
        providerBalanceAsOf: balanceAsOf,
      }),
    })
    refreshStatementAnchor(transaction, {
      targetType: 'account',
      targetId: accountId,
      balanceType: 'posted',
    })
    return openingBalanceCents
  })
}

/**
 * The inferred opening is a projection of one booked balance observation
 * and the copied facts. An accepted correction changes those facts (or
 * moves one across the opening date, invalidating the checkpoint), so the
 * opening is derived again from the same observation. Called after the
 * correction is applied, with the opening that was active before it.
 */
function rebuildInferredOpening(
  transaction: DatabaseTransaction,
  input: {
    accountId: string
    historyStart: string
    opening: typeof schema.balanceCheckpoints.$inferSelect
    reason: string
  },
) {
  const evidence = JSON.parse(input.opening.evidenceJson ?? '{}') as {
    method?: string
    providerBookedBalanceCents?: number
    providerBalanceAsOf?: string
  }
  if (
    evidence.method !== inferredOpeningMethod ||
    typeof evidence.providerBookedBalanceCents !== 'number' ||
    typeof evidence.providerBalanceAsOf !== 'string'
  ) {
    return
  }
  const openingBalanceCents =
    evidence.providerBookedBalanceCents -
    copiedMovementCents(transaction, {
      accountId: input.accountId,
      historyStart: input.historyStart,
      balanceAsOf: evidence.providerBalanceAsOf,
    })
  const current = transaction
    .select({ reviewState: schema.balanceCheckpoints.reviewState })
    .from(schema.balanceCheckpoints)
    .where(eq(schema.balanceCheckpoints.id, input.opening.id))
    .get()
  if (
    current?.reviewState !== 'invalidated' &&
    openingBalanceCents === input.opening.balanceCents
  ) {
    return
  }
  transaction
    .update(schema.balanceCheckpoints)
    .set({
      verified: false,
      reviewState: 'invalidated',
      invalidatedAt: new Date(),
      invalidatedReason: input.reason,
    })
    .where(eq(schema.balanceCheckpoints.id, input.opening.id))
    .run()
  addBalanceCheckpoint(transaction, {
    accountId: input.accountId,
    kind: 'opening',
    balanceType: 'posted',
    source: 'integration',
    reviewState: 'observed',
    verified: false,
    balanceCents: openingBalanceCents,
    asOf: input.opening.asOf,
    evidenceJson: input.opening.evidenceJson,
  })
}

async function exactCanonicalCandidate(
  account: OpenFinanceAccount,
  normalized: NormalizedPluggyTransaction,
) {
  const target = account.accountId
    ? eq(schema.transactions.accountId, account.accountId)
    : eq(schema.transactions.creditCardId, account.creditCardId!)
  const bySource = await db
    .select()
    .from(schema.transactions)
    .where(
      and(
        target,
        eq(
          schema.transactions.sourceKey,
          `pluggy:${account.providerAccountId}:${normalized.providerTransactionId}`,
        ),
      ),
    )
    .limit(1)
  if (bySource[0]) return bySource[0]

  const previousObservation = await db
    .select({ transaction: schema.transactions })
    .from(schema.openFinanceTransactionObservations)
    .innerJoin(
      schema.transactions,
      eq(
        schema.transactions.id,
        schema.openFinanceTransactionObservations.canonicalTransactionId,
      ),
    )
    .where(
      and(
        eq(
          schema.openFinanceTransactionObservations.openFinanceAccountId,
          account.id,
        ),
        eq(
          schema.openFinanceTransactionObservations.providerTransactionId,
          normalized.providerTransactionId,
        ),
      ),
    )
    .orderBy(desc(schema.openFinanceTransactionObservations.observedAt))
    .limit(1)
  if (previousObservation[0]) return previousObservation[0].transaction

  const external = await db
    .select()
    .from(schema.transactions)
    .where(
      and(
        target,
        eq(schema.transactions.externalId, normalized.providerTransactionId),
      ),
    )
    .limit(1)
  if (external[0]) return external[0]

  const usedCanonical = db
    .select({
      id: schema.openFinanceTransactionObservations.canonicalTransactionId,
    })
    .from(schema.openFinanceTransactionObservations)
    .where(
      and(
        eq(
          schema.openFinanceTransactionObservations.openFinanceAccountId,
          account.id,
        ),
        sql`${schema.openFinanceTransactionObservations.canonicalTransactionId} is not null`,
      ),
    )
  return (
    await db
      .select()
      .from(schema.transactions)
      .where(
        and(
          target,
          eq(schema.transactions.fingerprint, normalized.fingerprint),
          sql`${schema.transactions.id} not in ${usedCanonical}`,
        ),
      )
      .orderBy(asc(schema.transactions.createdAt))
      .limit(1)
  ).at(0)
}

function sameCanonicalContent(
  transaction: typeof schema.transactions.$inferSelect,
  normalized: NormalizedPluggyTransaction,
) {
  return (
    transaction.postedAt === normalized.postedAt &&
    transaction.description === normalized.description &&
    transaction.amountCents === normalized.amountCents &&
    transaction.currency === normalized.currency
  )
}

async function isKnownProviderTransaction(
  account: OpenFinanceAccount,
  normalized: NormalizedPluggyTransaction,
) {
  const observation = await db
    .select({ id: schema.openFinanceTransactionObservations.id })
    .from(schema.openFinanceTransactionObservations)
    .where(
      and(
        eq(
          schema.openFinanceTransactionObservations.openFinanceAccountId,
          account.id,
        ),
        eq(
          schema.openFinanceTransactionObservations.providerTransactionId,
          normalized.providerTransactionId,
        ),
      ),
    )
    .limit(1)
  if (observation.length) return true
  const bySource = await db
    .select({ id: schema.transactions.id })
    .from(schema.transactions)
    .where(
      eq(
        schema.transactions.sourceKey,
        `pluggy:${account.providerAccountId}:${normalized.providerTransactionId}`,
      ),
    )
    .limit(1)
  return bySource.length > 0
}

async function storeTransactionObservation(
  account: OpenFinanceAccount,
  providerTransaction: Transaction,
) {
  const normalized = normalizePluggyTransaction(
    {
      type: account.type,
      currencyCode: account.currency as Account['currencyCode'],
    },
    providerTransaction,
  )
  const existingVersion = (
    await db
      .select()
      .from(schema.openFinanceTransactionObservations)
      .where(
        and(
          eq(
            schema.openFinanceTransactionObservations.openFinanceAccountId,
            account.id,
          ),
          eq(
            schema.openFinanceTransactionObservations.providerTransactionId,
            normalized.providerTransactionId,
          ),
          eq(
            schema.openFinanceTransactionObservations.contentHash,
            normalized.contentHash,
          ),
        ),
      )
      .limit(1)
  ).at(0)
  if (existingVersion) return { kind: 'evidence' as const }

  // Pluggy may resend facts older than the copied window on refreshes. The
  // window only filters facts never seen before: an update to a known
  // transaction that moves it before the window is still a correction.
  if (
    account.historyStart &&
    normalized.postedAt < account.historyStart &&
    !(await isKnownProviderTransaction(account, normalized))
  ) {
    return { kind: 'skipped' as const }
  }

  const canonical = await exactCanonicalCandidate(account, normalized)
  if (canonical && !sameCanonicalContent(canonical, normalized)) {
    await db.insert(schema.openFinanceTransactionObservations).values({
      id: randomUUID(),
      openFinanceAccountId: account.id,
      providerTransactionId: normalized.providerTransactionId,
      contentHash: normalized.contentHash,
      providerStatus: normalized.providerStatus,
      postedAt: normalized.postedAt,
      description: normalized.description,
      normalizedDescription: normalized.normalizedDescription,
      amountCents: normalized.amountCents,
      currency: normalized.currency,
      providerCategory: normalized.providerCategory,
      sanitizedMetadataJson: normalized.sanitizedMetadataJson,
      canonicalTransactionId: canonical.id,
      resolution: 'correction_pending',
    })
    return { kind: 'correction' as const }
  }

  if (canonical) {
    db.transaction((transaction) => {
      if (canonical.status === 'pending' && normalized.status === 'confirmed') {
        transaction
          .update(schema.transactions)
          .set({ status: 'confirmed' })
          .where(eq(schema.transactions.id, canonical.id))
          .run()
      }
      transaction
        .insert(schema.openFinanceTransactionObservations)
        .values({
          id: randomUUID(),
          openFinanceAccountId: account.id,
          providerTransactionId: normalized.providerTransactionId,
          contentHash: normalized.contentHash,
          providerStatus: normalized.providerStatus,
          postedAt: normalized.postedAt,
          description: normalized.description,
          normalizedDescription: normalized.normalizedDescription,
          amountCents: normalized.amountCents,
          currency: normalized.currency,
          providerCategory: normalized.providerCategory,
          sanitizedMetadataJson: normalized.sanitizedMetadataJson,
          canonicalTransactionId: canonical.id,
          resolution: 'evidence',
        })
        .run()
    })
    return { kind: 'evidence' as const }
  }

  const suggestion = await suggestCategory({
    description: normalized.description,
    amountCents: normalized.amountCents,
    accountId: account.accountId,
    creditCardId: account.creditCardId,
  })
  const transactionId = randomUUID()
  db.transaction((transaction) => {
    transaction
      .insert(schema.transactions)
      .values({
        id: transactionId,
        importId: null,
        accountId: account.accountId,
        creditCardId: account.creditCardId,
        categoryId: suggestion.categoryId,
        counterpartyAccountId: suggestion.counterpartyAccountId ?? null,
        externalId: normalized.providerTransactionId,
        sourceKey: `pluggy:${account.providerAccountId}:${normalized.providerTransactionId}`,
        fingerprint: normalized.fingerprint,
        postedAt: normalized.postedAt,
        description: normalized.description,
        normalizedDescription: normalized.normalizedDescription,
        amountCents: normalized.amountCents,
        currency: normalized.currency,
        baseAmountCents:
          normalized.currency === 'BRL' ? normalized.amountCents : null,
        baseCurrency: 'BRL',
        exchangeRateMicros: normalized.currency === 'BRL' ? 1_000_000 : null,
        status: normalized.status,
      })
      .run()
    transaction
      .insert(schema.openFinanceTransactionObservations)
      .values({
        id: randomUUID(),
        openFinanceAccountId: account.id,
        providerTransactionId: normalized.providerTransactionId,
        contentHash: normalized.contentHash,
        providerStatus: normalized.providerStatus,
        postedAt: normalized.postedAt,
        description: normalized.description,
        normalizedDescription: normalized.normalizedDescription,
        amountCents: normalized.amountCents,
        currency: normalized.currency,
        providerCategory: normalized.providerCategory,
        sanitizedMetadataJson: normalized.sanitizedMetadataJson,
        canonicalTransactionId: transactionId,
        resolution: 'created',
      })
      .run()
    const target = account.accountId
      ? { targetType: 'account' as const, targetId: account.accountId }
      : { targetType: 'card' as const, targetId: account.creditCardId! }
    invalidateCheckpointChain(transaction, {
      ...target,
      from: normalized.postedAt,
      reason: `Reaberto pela transação Open Finance ${transactionId}.`,
    })
    refreshStatementAnchor(transaction, {
      ...target,
      balanceType: account.accountId ? 'posted' : 'card_statement',
    })
  })
  return { kind: 'created' as const }
}

async function syncProviderAccount(
  account: OpenFinanceAccount,
  gateway: PluggyGateway,
  filters?: { createdAtFrom?: string; ids?: string[] },
  now = new Date(),
) {
  if (!account.accountId && !account.creditCardId) {
    return {
      fetched: 0,
      created: 0,
      evidence: 0,
      corrections: 0,
      openingBalanceCents: null,
    }
  }
  const providerTransactions = filters?.ids
    ? await gateway.fetchTransactionsByIds(
        account.providerAccountId,
        filters.ids,
      )
    : await gateway.fetchAllTransactions(
        account.providerAccountId,
        // Pluggy rejects dateFrom together with createdAtFrom; the stored
        // window still applies to each observation.
        filters?.createdAtFrom
          ? { createdAtFrom: filters.createdAtFrom }
          : { dateFrom: account.historyStart ?? undefined },
      )
  const counts = {
    fetched: providerTransactions.length,
    created: 0,
    evidence: 0,
    corrections: 0,
  }
  for (const providerTransaction of providerTransactions) {
    const result = await storeTransactionObservation(
      account,
      providerTransaction,
    )
    if (result.kind === 'skipped') continue
    counts[result.kind === 'correction' ? 'corrections' : result.kind] += 1
  }
  // Only a full read of the window explains the balance; filtered webhook
  // reads leave a pending bootstrap for the next full sync.
  const openingBalanceCents = filters
    ? null
    : await completeHistoryBootstrap(account, now)
  return { ...counts, openingBalanceCents }
}

export async function syncPluggyConnection(
  input: {
    connectionId: string
    trigger?: SyncTrigger
    includeTransactions?: boolean
  },
  gateway: PluggyGateway = getPluggyGateway(),
) {
  await ensureDatabase()
  const connection = await requireConnection(input.connectionId)
  const runId = randomUUID()
  await db.insert(schema.openFinanceSyncRuns).values({
    id: runId,
    connectionId: connection.id,
    trigger: input.trigger ?? 'manual',
  })
  if (connection.paused) {
    await db
      .update(schema.openFinanceSyncRuns)
      .set({ status: 'paused', finishedAt: new Date() })
      .where(eq(schema.openFinanceSyncRuns.id, runId))
    return { status: 'paused' as const }
  }
  if (!connection.providerItemId) {
    throw new Error('A conexão ainda não recebeu um Item da Pluggy.')
  }

  try {
    const item = await gateway.fetchItem(connection.providerItemId)
    await db
      .update(schema.openFinanceConnections)
      .set(itemPatch(item))
      .where(eq(schema.openFinanceConnections.id, connection.id))
    const canReadAccounts =
      item.executionStatus === 'SUCCESS' ||
      (item.executionStatus === 'PARTIAL_SUCCESS' &&
        Boolean(
          item.statusDetail?.accounts?.isUpdated ||
          item.statusDetail?.creditCards?.isUpdated,
        ))
    const canReadTransactions =
      input.includeTransactions !== false &&
      (item.executionStatus === 'SUCCESS' ||
        (item.executionStatus === 'PARTIAL_SUCCESS' &&
          item.statusDetail?.transactions?.isUpdated === true))
    const providerAccounts = canReadAccounts
      ? await gateway.fetchAccounts(connection.providerItemId)
      : []
    if (providerAccounts.length) {
      await saveProviderAccounts(connection.id, providerAccounts)
    }
    const accounts = await db
      .select()
      .from(schema.openFinanceAccounts)
      .where(eq(schema.openFinanceAccounts.connectionId, connection.id))
    const totals = {
      fetched: 0,
      created: 0,
      evidence: 0,
      corrections: 0,
      openings: 0,
    }
    if (canReadTransactions) {
      for (const account of accounts) {
        const result = await syncProviderAccount(account, gateway)
        totals.fetched += result.fetched
        totals.created += result.created
        totals.evidence += result.evidence
        totals.corrections += result.corrections
        if (result.openingBalanceCents !== null) totals.openings += 1
      }
    }
    await db
      .update(schema.openFinanceSyncRuns)
      .set({
        status:
          item.executionStatus === 'PARTIAL_SUCCESS' ? 'partial' : 'completed',
        accountsFetched: providerAccounts.length,
        transactionsFetched: totals.fetched,
        transactionsCreated: totals.created,
        evidenceAdded: totals.evidence,
        correctionsPending: totals.corrections,
        finishedAt: new Date(),
      })
      .where(eq(schema.openFinanceSyncRuns.id, runId))
    if (totals.created || totals.openings) {
      await refreshReconciliationAfterCommit()
    }
    return {
      status:
        item.executionStatus === 'PARTIAL_SUCCESS'
          ? ('partial' as const)
          : ('completed' as const),
      ...totals,
    }
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message.slice(0, 500)
        : 'Falha desconhecida.'
    await db
      .update(schema.openFinanceSyncRuns)
      .set({ status: 'failed', errorMessage: message, finishedAt: new Date() })
      .where(eq(schema.openFinanceSyncRuns.id, runId))
    throw error
  }
}

export async function resolvePluggyCorrection(input: {
  observationId: string
  action: 'accept' | 'reject'
}) {
  await ensureDatabase()
  const row = (
    await db
      .select({
        observation: schema.openFinanceTransactionObservations,
        account: schema.openFinanceAccounts,
      })
      .from(schema.openFinanceTransactionObservations)
      .innerJoin(
        schema.openFinanceAccounts,
        eq(
          schema.openFinanceAccounts.id,
          schema.openFinanceTransactionObservations.openFinanceAccountId,
        ),
      )
      .where(
        and(
          eq(schema.openFinanceTransactionObservations.id, input.observationId),
          eq(
            schema.openFinanceTransactionObservations.resolution,
            'correction_pending',
          ),
        ),
      )
      .limit(1)
  ).at(0)
  if (!row?.observation.canonicalTransactionId) {
    throw new Error('Correção pendente não encontrada.')
  }
  const observation = row.observation
  if (
    !observation.postedAt ||
    !observation.description ||
    !observation.normalizedDescription ||
    observation.amountCents === null ||
    !observation.currency
  ) {
    throw new Error('A correção não possui todos os dados necessários.')
  }
  db.transaction((transaction) => {
    if (input.action === 'accept') {
      const accountId = row.account.accountId
      const historyStart = row.account.historyStart
      const opening =
        accountId && historyStart
          ? transaction
              .select()
              .from(schema.balanceCheckpoints)
              .where(
                and(
                  eq(schema.balanceCheckpoints.accountId, accountId),
                  eq(schema.balanceCheckpoints.kind, 'opening'),
                  eq(schema.balanceCheckpoints.source, 'integration'),
                  eq(
                    schema.balanceCheckpoints.asOf,
                    shiftDays(historyStart, -1),
                  ),
                  sql`${schema.balanceCheckpoints.reviewState} <> 'invalidated'`,
                ),
              )
              .get()
          : undefined
      transaction
        .update(schema.transactions)
        .set({
          postedAt: observation.postedAt!,
          description: observation.description!,
          normalizedDescription: observation.normalizedDescription!,
          amountCents: observation.amountCents!,
          currency: observation.currency!,
          fingerprint: createHash('sha256')
            .update(
              [
                observation.postedAt,
                observation.amountCents,
                observation.normalizedDescription,
                observation.currency,
              ].join('|'),
            )
            .digest('hex'),
          status:
            observation.providerStatus === 'PENDING' ? 'pending' : 'confirmed',
          baseAmountCents:
            observation.currency === 'BRL' ? observation.amountCents : null,
          exchangeRateMicros: observation.currency === 'BRL' ? 1_000_000 : null,
        })
        .where(eq(schema.transactions.id, observation.canonicalTransactionId!))
        .run()
      const target = row.account.accountId
        ? { targetType: 'account' as const, targetId: row.account.accountId }
        : {
            targetType: 'card' as const,
            targetId: row.account.creditCardId!,
          }
      invalidateCheckpointChain(transaction, {
        ...target,
        from: observation.postedAt!,
        reason: `Reaberto pela correção Open Finance ${observation.id}.`,
      })
      if (opening) {
        rebuildInferredOpening(transaction, {
          accountId: accountId!,
          historyStart: historyStart!,
          opening,
          reason: `Recalculado pela correção Open Finance ${observation.id}.`,
        })
      }
      refreshStatementAnchor(transaction, {
        ...target,
        balanceType: row.account.accountId ? 'posted' : 'card_statement',
      })
    }
    transaction
      .update(schema.openFinanceTransactionObservations)
      .set({
        resolution: input.action === 'accept' ? 'accepted' : 'rejected',
        resolvedAt: new Date(),
      })
      .where(eq(schema.openFinanceTransactionObservations.id, observation.id))
      .run()
  })
  if (input.action === 'accept') await refreshReconciliationAfterCommit()
  return { resolved: true }
}

async function applyProviderDeletions(
  account: OpenFinanceAccount,
  transactionIds: string[],
) {
  let deleted = 0
  for (const providerTransactionId of transactionIds) {
    const linked = (
      await db
        .select({
          observation: schema.openFinanceTransactionObservations,
          transaction: schema.transactions,
        })
        .from(schema.openFinanceTransactionObservations)
        .leftJoin(
          schema.transactions,
          eq(
            schema.transactions.id,
            schema.openFinanceTransactionObservations.canonicalTransactionId,
          ),
        )
        .where(
          and(
            eq(
              schema.openFinanceTransactionObservations.openFinanceAccountId,
              account.id,
            ),
            eq(
              schema.openFinanceTransactionObservations.providerTransactionId,
              providerTransactionId,
            ),
          ),
        )
        .orderBy(desc(schema.openFinanceTransactionObservations.observedAt))
        .limit(1)
    ).at(0)
    if (!linked) continue
    const deletionHash = createHash('sha256')
      .update(`deleted:${providerTransactionId}`)
      .digest('hex')
    const exists = (
      await db
        .select({ id: schema.openFinanceTransactionObservations.id })
        .from(schema.openFinanceTransactionObservations)
        .where(
          and(
            eq(
              schema.openFinanceTransactionObservations.openFinanceAccountId,
              account.id,
            ),
            eq(
              schema.openFinanceTransactionObservations.providerTransactionId,
              providerTransactionId,
            ),
            eq(
              schema.openFinanceTransactionObservations.contentHash,
              deletionHash,
            ),
          ),
        )
        .limit(1)
    ).at(0)
    if (exists) continue

    const canonical = linked.transaction
    const fileEvidence = canonical
      ? await db
          .select({ id: schema.transactionEvidence.id })
          .from(schema.transactionEvidence)
          .where(eq(schema.transactionEvidence.transactionId, canonical.id))
          .limit(1)
      : []
    const pluggyOnly = Boolean(
      canonical?.sourceKey?.startsWith('pluggy:') &&
      !canonical.importId &&
      fileEvidence.length === 0,
    )
    db.transaction((transaction) => {
      transaction
        .insert(schema.openFinanceTransactionObservations)
        .values({
          id: randomUUID(),
          openFinanceAccountId: account.id,
          providerTransactionId,
          contentHash: deletionHash,
          providerStatus: 'DELETED',
          sanitizedMetadataJson: '{}',
          canonicalTransactionId: canonical?.id ?? null,
          resolution: pluggyOnly ? 'deleted' : 'preserved',
        })
        .run()
      if (pluggyOnly && canonical) {
        transaction
          .delete(schema.transactions)
          .where(eq(schema.transactions.id, canonical.id))
          .run()
        deleted += 1
      }
    })
  }
  if (deleted) await refreshReconciliationAfterCommit()
  return deleted
}

export async function disconnectPluggyConnection(
  input: { connectionId: string; confirmation: string },
  gateway: PluggyGateway = getPluggyGateway(),
) {
  await ensureDatabase()
  if (input.confirmation !== 'DESCONECTAR') {
    throw new Error('Digite DESCONECTAR para confirmar.')
  }
  const connection = await requireConnection(input.connectionId)
  if (connection.providerItemId) {
    try {
      await gateway.deleteItem(connection.providerItemId)
    } catch (error) {
      if (
        !(error instanceof PluggyIntegrationError) ||
        error.code !== 'ITEM_NOT_FOUND'
      ) {
        throw error
      }
    }
  }
  await db
    .update(schema.openFinanceConnections)
    .set({ status: 'disconnected', paused: true, disconnectedAt: new Date() })
    .where(eq(schema.openFinanceConnections.id, connection.id))
  return { disconnected: true }
}

export async function resumePluggyConnection(
  input: { connectionId: string },
  gateway: PluggyGateway = getPluggyGateway(),
) {
  await ensureDatabase()
  const connection = await requireConnection(input.connectionId)
  if (connection.status === 'disconnected') {
    throw new Error('Uma conexão desconectada não pode ser retomada.')
  }
  await db
    .update(schema.openFinanceConnections)
    .set({ paused: false })
    .where(eq(schema.openFinanceConnections.id, connection.id))
  return syncPluggyConnection(
    { connectionId: connection.id, trigger: 'manual' },
    gateway,
  )
}

export async function registerPluggyWebhook(
  gateway: PluggyGateway = getPluggyGateway(),
) {
  const configuration = getPluggyConfiguration()
  if (!configuration.webhookUrl || !configuration.webhookSecret) {
    throw new Error(
      'Configure PLUGGY_WEBHOOK_URL e PLUGGY_WEBHOOK_SECRET para ativar o webhook.',
    )
  }
  await gateway.ensureWebhook({
    url: configuration.webhookUrl,
    secret: configuration.webhookSecret,
  })
  return { registered: true }
}

export async function enqueuePluggyWebhook(payload: PluggyWebhookPayload) {
  await ensureDatabase()
  const sanitizedPayload = {
    eventId: payload.eventId,
    event: payload.event,
    itemId: payload.itemId,
    accountId: payload.accountId,
    transactionIds: payload.transactionIds,
    transactionsCreatedAtFrom: payload.transactionsCreatedAtFrom,
    triggeredBy: payload.triggeredBy,
    error: payload.error,
  }
  const inserted = await db
    .insert(schema.pluggyWebhookEvents)
    .values({
      eventId: payload.eventId,
      event: payload.event,
      providerItemId: payload.itemId,
      providerAccountId: payload.accountId ?? null,
      payloadJson: JSON.stringify(sanitizedPayload),
    })
    .onConflictDoNothing()
    .returning({ eventId: schema.pluggyWebhookEvents.eventId })
  return { accepted: true, duplicate: inserted.length === 0 }
}

type WebhookTransactionResult = {
  fetched?: number
  created?: number
  evidence?: number
  corrections?: number
  deleted?: number
}

async function recordWebhookTransactionSync(
  connectionId: string,
  operation: () => Promise<WebhookTransactionResult>,
) {
  const runId = randomUUID()
  await db.insert(schema.openFinanceSyncRuns).values({
    id: runId,
    connectionId,
    trigger: 'webhook',
  })
  try {
    const result = await operation()
    await db
      .update(schema.openFinanceSyncRuns)
      .set({
        status: 'completed',
        transactionsFetched: result.fetched ?? 0,
        transactionsCreated: result.created ?? 0,
        evidenceAdded: result.evidence ?? 0,
        correctionsPending: result.corrections ?? 0,
        transactionsDeleted: result.deleted ?? 0,
        finishedAt: new Date(),
      })
      .where(eq(schema.openFinanceSyncRuns.id, runId))
    return result
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message.slice(0, 500)
        : 'Falha desconhecida.'
    await db
      .update(schema.openFinanceSyncRuns)
      .set({ status: 'failed', errorMessage: message, finishedAt: new Date() })
      .where(eq(schema.openFinanceSyncRuns.id, runId))
    throw error
  }
}

async function processWebhookPayload(
  payload: PluggyWebhookPayload,
  gateway: PluggyGateway,
) {
  const connection = (
    await db
      .select()
      .from(schema.openFinanceConnections)
      .where(eq(schema.openFinanceConnections.providerItemId, payload.itemId))
      .limit(1)
  ).at(0)
  if (
    !connection ||
    connection.paused ||
    connection.status === 'disconnected'
  ) {
    return
  }
  if (payload.event === 'item/deleted') {
    await db
      .update(schema.openFinanceConnections)
      .set({ status: 'disconnected', paused: true, disconnectedAt: new Date() })
      .where(eq(schema.openFinanceConnections.id, connection.id))
    return
  }
  if (
    payload.event === 'item/error' ||
    payload.event === 'item/waiting_user_input' ||
    payload.event === 'item/waiting_user_action'
  ) {
    const item = await gateway.fetchItem(payload.itemId)
    await db
      .update(schema.openFinanceConnections)
      .set(itemPatch(item))
      .where(eq(schema.openFinanceConnections.id, connection.id))
    return
  }
  if (payload.event === 'item/created' || payload.event === 'item/updated') {
    await syncPluggyConnection(
      {
        connectionId: connection.id,
        trigger: 'webhook',
        includeTransactions: false,
      },
      gateway,
    )
    return
  }
  if (!payload.accountId) return
  const account = await requireProviderAccount(payload.accountId)
  if (account.connectionId !== connection.id) return
  if (payload.event === 'transactions/deleted') {
    await recordWebhookTransactionSync(connection.id, async () => ({
      deleted: await applyProviderDeletions(
        account,
        payload.transactionIds ?? [],
      ),
    }))
    return
  }
  if (payload.event === 'transactions/updated') {
    await recordWebhookTransactionSync(connection.id, async () => {
      const result = await syncProviderAccount(account, gateway, {
        ids: payload.transactionIds ?? [],
      })
      await refreshReconciliationAfterCommit()
      return result
    })
    return
  }
  await recordWebhookTransactionSync(connection.id, async () => {
    const result = await syncProviderAccount(account, gateway, {
      createdAtFrom: payload.transactionsCreatedAtFrom,
    })
    await refreshReconciliationAfterCommit()
    return result
  })
}

export async function recoverAbandonedPluggyEvents(now = new Date()) {
  await ensureDatabase()
  const abandonedBefore = new Date(now.getTime() - 5 * 60 * 1000)
  const recovered = await db
    .update(schema.pluggyWebhookEvents)
    .set({ state: 'pending', claimedAt: null })
    .where(
      and(
        eq(schema.pluggyWebhookEvents.state, 'processing'),
        or(
          isNull(schema.pluggyWebhookEvents.claimedAt),
          lt(schema.pluggyWebhookEvents.claimedAt, abandonedBefore),
        ),
      ),
    )
  return recovered.changes
}

export async function processNextPluggyWebhook(
  gateway: PluggyGateway = getPluggyGateway(),
) {
  await ensureDatabase()
  const event = (
    await db
      .select()
      .from(schema.pluggyWebhookEvents)
      .where(
        and(
          eq(schema.pluggyWebhookEvents.state, 'pending'),
          sql`not exists (
            select 1
            from pluggy_webhook_events processing
            where processing.state = 'processing'
              and processing.provider_item_id = ${schema.pluggyWebhookEvents.providerItemId}
          )`,
        ),
      )
      .orderBy(asc(schema.pluggyWebhookEvents.receivedAt))
      .limit(1)
  ).at(0)
  if (!event) return false
  const claimed = await db
    .update(schema.pluggyWebhookEvents)
    .set({
      state: 'processing',
      attempts: event.attempts + 1,
      claimedAt: new Date(),
      errorMessage: null,
    })
    .where(
      and(
        eq(schema.pluggyWebhookEvents.eventId, event.eventId),
        eq(schema.pluggyWebhookEvents.state, 'pending'),
      ),
    )
    .returning({ eventId: schema.pluggyWebhookEvents.eventId })
  if (!claimed.length) return true
  try {
    await processWebhookPayload(
      JSON.parse(event.payloadJson) as PluggyWebhookPayload,
      gateway,
    )
    await db
      .update(schema.pluggyWebhookEvents)
      .set({ state: 'processed', processedAt: new Date(), claimedAt: null })
      .where(eq(schema.pluggyWebhookEvents.eventId, event.eventId))
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message.slice(0, 500)
        : 'Falha desconhecida.'
    await db
      .update(schema.pluggyWebhookEvents)
      .set({
        state: event.attempts + 1 >= 5 ? 'failed' : 'pending',
        claimedAt: null,
        errorMessage: message,
      })
      .where(eq(schema.pluggyWebhookEvents.eventId, event.eventId))
  }
  return true
}

export async function getOpenFinanceSnapshot() {
  await ensureDatabase()
  const configuration = getPluggyConfiguration()
  const [connections, accounts, corrections] = await Promise.all([
    db
      .select()
      .from(schema.openFinanceConnections)
      .orderBy(desc(schema.openFinanceConnections.createdAt)),
    db
      .select()
      .from(schema.openFinanceAccounts)
      .orderBy(asc(schema.openFinanceAccounts.name)),
    db
      .select()
      .from(schema.openFinanceTransactionObservations)
      .where(
        eq(
          schema.openFinanceTransactionObservations.resolution,
          'correction_pending',
        ),
      )
      .orderBy(desc(schema.openFinanceTransactionObservations.observedAt)),
  ])
  return {
    configuration: {
      enabled: configuration.enabled,
      automaticSync: configuration.automaticSync,
      includeSandbox: configuration.includeSandbox,
    },
    connections,
    accounts,
    corrections,
  }
}
