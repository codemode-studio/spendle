import { eq } from 'drizzle-orm'
import type { Account, Item, Transaction } from 'pluggy-sdk'
import { TransactionStatus } from 'pluggy-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createManualBalanceCheckpoint,
  createManualTransaction,
  setReconciliationStatus,
  updateTransactionCategory,
} from '#/features/finance/finance.server'
import {
  getFinanceSnapshot,
  getPlanningSnapshot,
} from '#/features/finance/finance-snapshot.server'
import {
  classifyInvestmentTransaction,
  getInvestmentsSnapshot,
} from '#/features/investments/investments.server'
import { clearTransactionData } from '#/features/finance/import.server'
import { refreshReconciliationSuggestions } from '#/features/finance/reconciliation-refresh.server'
import { transactionFingerprint } from '#/features/finance/canonicalization.server'
import { openTestDatabase } from '#/test/database'
import type { TestDatabase } from '#/test/database'

import {
  createPluggyConnectToken,
  disconnectPluggyConnection,
  enqueuePluggyWebhook,
  mapPluggyAccount,
  processNextPluggyWebhook,
  recoverAbandonedPluggyEvents,
  registerPluggyItem,
  resolvePluggyCorrection,
  syncPluggyConnection,
} from './open-finance.server'
import { PluggyIntegrationError } from './pluggy.server'
import type { PluggyGateway } from './pluggy.server'

function account(type: 'BANK' | 'CREDIT' = 'BANK') {
  return {
    id: type === 'BANK' ? 'provider-bank' : 'provider-card',
    itemId: 'item-1',
    type,
    subtype: type === 'BANK' ? 'CHECKING_ACCOUNT' : 'CREDIT_CARD',
    number: type === 'BANK' ? '0001234' : '**** 4321',
    balance: type === 'BANK' ? 1000 : 250,
    name: type === 'BANK' ? 'Conta Pluggy' : 'Cartão Pluggy',
    marketingName: null,
    owner: 'Pessoa não persistida',
    taxNumber: '00000000000',
    currencyCode: 'BRL',
    bankData:
      type === 'BANK'
        ? {
            transferNumber: 'sensitive',
            closingBalance: 900,
            automaticallyInvestedBalance: null,
            overdraftContractedLimit: null,
            overdraftUsedLimit: null,
            unarrangedOverdraftAmount: null,
            hasReservedBalance: null,
            reservedBalances: null,
          }
        : null,
    creditData:
      type === 'CREDIT'
        ? {
            level: null,
            brand: 'VISA',
            balanceCloseDate: new Date('2026-09-20T12:00:00Z'),
            balanceDueDate: new Date('2026-09-27T12:00:00Z'),
            availableCreditLimit: 750,
            balanceForeignCurrency: null,
            minimumPayment: null,
            creditLimit: 1000,
            isLimitFlexible: false,
            status: 'ACTIVE',
            holderType: 'MAIN',
          }
        : null,
  } as Account
}

function providerTransaction(
  overrides: Partial<Transaction> = {},
): Transaction {
  return {
    id: 'provider-transaction-1',
    accountId: 'provider-bank',
    date: new Date('2026-09-10T15:00:00Z'),
    description: 'Mercado Pluggy',
    descriptionRaw: null,
    type: 'DEBIT',
    amount: 10,
    amountInAccountCurrency: null,
    balance: 890,
    currencyCode: 'BRL',
    category: 'Food',
    status: TransactionStatus.POSTED,
    creditCardMetadata: null,
    categoryId: null,
    operationType: null,
    operationTypeAdditionalInfo: null,
    providerId: null,
    createdAt: new Date('2026-09-10T15:00:00Z'),
    updatedAt: new Date('2026-09-10T15:00:00Z'),
    ...overrides,
  }
}

class FakePluggyGateway implements PluggyGateway {
  item = {
    id: 'item-1',
    connector: {
      id: 1,
      name: 'Banco Sandbox',
      imageUrl: 'https://example.com/bank.png',
    },
    status: 'UPDATED',
    statusDetail: null,
    error: null,
    executionStatus: 'SUCCESS',
    createdAt: new Date('2026-09-01T12:00:00Z'),
    updatedAt: new Date('2026-09-10T12:00:00Z'),
    lastUpdatedAt: new Date('2026-09-10T12:00:00Z'),
    parameter: null,
    webhookUrl: null,
    clientUserId: null,
    userAction: null,
    consecutiveFailedLoginAttempts: 0,
    nextAutoSyncAt: new Date('2026-09-11T12:00:00Z'),
    consentExpiresAt: null,
  } as Item
  accounts = [account()]
  transactions = new Map<string, Transaction[]>([
    ['provider-bank', [providerTransaction()]],
  ])
  deletedItems: string[] = []
  tokenInputs: Array<{ clientUserId: string; itemId?: string }> = []
  webhookInputs: Array<{ url: string; secret: string }> = []
  transactionFetches = 0
  transactionFilters: Array<{ dateFrom?: string; createdAtFrom?: string }> = []

  async createConnectToken(input: { clientUserId: string; itemId?: string }) {
    this.tokenInputs.push(input)
    this.item.clientUserId = input.clientUserId
    return { accessToken: 'connect-token-only' }
  }
  async fetchItem() {
    return this.item
  }
  async fetchAccounts() {
    return this.accounts
  }
  async fetchAllTransactions(
    accountId: string,
    filters: { dateFrom?: string; createdAtFrom?: string } = {},
  ) {
    this.transactionFetches += 1
    this.transactionFilters.push(filters)
    return this.transactions.get(accountId) ?? []
  }
  async fetchTransactionsByIds(accountId: string, ids: string[]) {
    return (this.transactions.get(accountId) ?? []).filter((item) =>
      ids.includes(item.id),
    )
  }
  async deleteItem(itemId: string) {
    this.deletedItems.push(itemId)
  }
  async ensureWebhook(input: { url: string; secret: string }) {
    this.webhookInputs.push(input)
  }
}

const mappedAt = new Date('2026-09-15T15:00:00Z')

async function registeredConnection(
  database: TestDatabase,
  gateway: FakePluggyGateway,
) {
  const token = await createPluggyConnectToken(
    { ownershipScopeId: database.ids.personScope },
    gateway,
  )
  await registerPluggyItem(
    { connectionId: token.connectionId, itemId: gateway.item.id },
    gateway,
  )
  return token.connectionId
}

async function connectedAccount(
  database: TestDatabase,
  gateway: FakePluggyGateway,
) {
  const token = await createPluggyConnectToken(
    { ownershipScopeId: database.ids.personScope },
    gateway,
  )
  expect(token.accessToken).toBe('connect-token-only')
  await registerPluggyItem(
    { connectionId: token.connectionId, itemId: gateway.item.id },
    gateway,
  )
  await mapPluggyAccount(
    {
      providerAccountId: gateway.accounts[0].id,
      existingTarget: { type: 'account', id: database.ids.brlAccount },
    },
    gateway,
    mappedAt,
  )
  return token.connectionId
}

describe('Open Finance persistence', () => {
  let database: TestDatabase

  beforeEach(async () => {
    database = await openTestDatabase()
  })

  afterEach(() => database.close())

  it('creates a pending connection, validates clientUserId and stores sanitized account observations', async () => {
    const gateway = new FakePluggyGateway()
    const token = await createPluggyConnectToken(
      { ownershipScopeId: database.ids.householdScope },
      gateway,
    )
    expect(gateway.tokenInputs).toEqual([
      { clientUserId: token.connectionId, itemId: undefined },
    ])
    await registerPluggyItem(
      { connectionId: token.connectionId, itemId: 'item-1' },
      gateway,
    )
    const stored = await database.db
      .select()
      .from(database.schema.openFinanceAccounts)
    expect(stored[0]).toMatchObject({
      providerAccountId: 'provider-bank',
      // Pluggy's BANK `balance` is available; closingBalance is booked.
      observedBalanceCents: 90_000,
      observedAvailableBalanceCents: 100_000,
      accountId: null,
    })
    expect(JSON.stringify(stored[0])).not.toContain('00000000000')
    expect(JSON.stringify(stored[0])).not.toContain('sensitive')
  })

  it('bootstraps a mapped account once and never learns the Pluggy category', async () => {
    const gateway = new FakePluggyGateway()
    const knowledgeBefore = (
      await database.db.select().from(database.schema.knowledgeBase)
    ).length
    const connectionId = await connectedAccount(database, gateway)
    await syncPluggyConnection({ connectionId }, gateway)

    const pluggyTransactions = await database.db
      .select()
      .from(database.schema.transactions)
      .where(
        eq(database.schema.transactions.externalId, 'provider-transaction-1'),
      )
    const observations = await database.db
      .select()
      .from(database.schema.openFinanceTransactionObservations)
    expect(pluggyTransactions).toHaveLength(1)
    expect(pluggyTransactions[0]).toMatchObject({
      amountCents: -1000,
      status: 'confirmed',
      sourceKey: 'pluggy:provider-bank:provider-transaction-1',
    })
    expect(observations).toHaveLength(1)
    expect(
      (await database.db.select().from(database.schema.knowledgeBase)).length,
    ).toBe(knowledgeBefore)
  })

  it('uses exact overlap as evidence while preserving transaction multiplicity', async () => {
    const gateway = new FakePluggyGateway()
    gateway.transactions.set('provider-bank', [
      providerTransaction({ id: 'p-1' }),
      providerTransaction({ id: 'p-2' }),
    ])
    const postedAt = '2026-09-10'
    const fingerprint = transactionFingerprint({
      postedAt,
      amountCents: -1000,
      description: 'Mercado Pluggy',
      currency: 'BRL',
    })
    await database.db.insert(database.schema.transactions).values([
      {
        id: 'file-1',
        accountId: database.ids.brlAccount,
        fingerprint,
        postedAt,
        description: 'Mercado Pluggy',
        normalizedDescription: 'mercado pluggy',
        amountCents: -1000,
        currency: 'BRL',
        status: 'confirmed',
      },
      {
        id: 'file-2',
        accountId: database.ids.brlAccount,
        fingerprint,
        postedAt,
        description: 'Mercado Pluggy',
        normalizedDescription: 'mercado pluggy',
        amountCents: -1000,
        currency: 'BRL',
        status: 'confirmed',
      },
    ])

    await connectedAccount(database, gateway)
    const all = await database.db.select().from(database.schema.transactions)
    const observations = await database.db
      .select()
      .from(database.schema.openFinanceTransactionObservations)
    expect(all.filter((item) => item.fingerprint === fingerprint)).toHaveLength(
      2,
    )
    expect(
      new Set(observations.map((item) => item.canonicalTransactionId)).size,
    ).toBe(2)
    expect(observations.every((item) => item.resolution === 'evidence')).toBe(
      true,
    )
  })

  it('promotes pending data and holds changed facts for human review', async () => {
    const gateway = new FakePluggyGateway()
    gateway.transactions.set('provider-bank', [
      providerTransaction({ status: TransactionStatus.PENDING }),
    ])
    const connectionId = await connectedAccount(database, gateway)
    gateway.transactions.set('provider-bank', [providerTransaction()])
    await syncPluggyConnection({ connectionId }, gateway)
    let canonical = (
      await database.db
        .select()
        .from(database.schema.transactions)
        .where(
          eq(database.schema.transactions.externalId, 'provider-transaction-1'),
        )
    )[0]
    expect(canonical.status).toBe('confirmed')

    gateway.transactions.set('provider-bank', [
      providerTransaction({ amount: 12 }),
    ])
    await syncPluggyConnection({ connectionId }, gateway)
    canonical = (
      await database.db
        .select()
        .from(database.schema.transactions)
        .where(eq(database.schema.transactions.id, canonical.id))
    )[0]
    const correction = (
      await database.db
        .select()
        .from(database.schema.openFinanceTransactionObservations)
        .where(
          eq(
            database.schema.openFinanceTransactionObservations.resolution,
            'correction_pending',
          ),
        )
    )[0]
    expect(canonical.amountCents).toBe(-1000)
    expect(correction.amountCents).toBe(-1200)
    await resolvePluggyCorrection({
      observationId: correction.id,
      action: 'accept',
    })
    canonical = (
      await database.db
        .select()
        .from(database.schema.transactions)
        .where(eq(database.schema.transactions.id, canonical.id))
    )[0]
    expect(canonical.amountCents).toBe(-1200)
  })

  it('deletes Pluggy-only facts but preserves a fact with another source', async () => {
    const gateway = new FakePluggyGateway()
    const connectionId = await connectedAccount(database, gateway)
    const pluggyOnly = (
      await database.db
        .select()
        .from(database.schema.transactions)
        .where(
          eq(database.schema.transactions.externalId, 'provider-transaction-1'),
        )
    )[0]
    await enqueuePluggyWebhook({
      eventId: 'delete-only',
      event: 'transactions/deleted',
      itemId: 'item-1',
      accountId: 'provider-bank',
      transactionIds: ['provider-transaction-1'],
    })
    await processNextPluggyWebhook(gateway)
    expect(
      await database.db
        .select()
        .from(database.schema.transactions)
        .where(eq(database.schema.transactions.id, pluggyOnly.id)),
    ).toHaveLength(0)
    const deletionRun = (
      await database.db
        .select()
        .from(database.schema.openFinanceSyncRuns)
        .where(eq(database.schema.openFinanceSyncRuns.transactionsDeleted, 1))
    )[0]
    expect(deletionRun).toMatchObject({
      trigger: 'webhook',
      status: 'completed',
      transactionsDeleted: 1,
    })

    gateway.transactions.set('provider-bank', [
      providerTransaction({
        id: 'shared-provider',
        description: 'Compartilhada',
      }),
    ])
    const fingerprint = transactionFingerprint({
      postedAt: '2026-09-10',
      amountCents: -1000,
      description: 'Compartilhada',
      currency: 'BRL',
    })
    await database.db.insert(database.schema.transactions).values({
      id: 'manual-shared',
      accountId: database.ids.brlAccount,
      fingerprint,
      postedAt: '2026-09-10',
      description: 'Compartilhada',
      normalizedDescription: 'compartilhada',
      amountCents: -1000,
      currency: 'BRL',
      sourceKey: 'manual:shared',
      status: 'confirmed',
    })
    await syncPluggyConnection({ connectionId }, gateway)
    await enqueuePluggyWebhook({
      eventId: 'delete-shared',
      event: 'transactions/deleted',
      itemId: 'item-1',
      accountId: 'provider-bank',
      transactionIds: ['shared-provider'],
    })
    await processNextPluggyWebhook(gateway)
    expect(
      await database.db
        .select()
        .from(database.schema.transactions)
        .where(eq(database.schema.transactions.id, 'manual-shared')),
    ).toHaveLength(1)
  })

  it('recovers abandoned events, disconnects remotely first and pauses after cleanup', async () => {
    const gateway = new FakePluggyGateway()
    const connectionId = await connectedAccount(database, gateway)
    await database.db.insert(database.schema.pluggyWebhookEvents).values({
      eventId: 'abandoned',
      event: 'item/updated',
      providerItemId: 'item-1',
      payloadJson: JSON.stringify({
        eventId: 'abandoned',
        event: 'item/updated',
        itemId: 'item-1',
      }),
      state: 'processing',
      claimedAt: new Date('2026-09-01T00:00:00Z'),
    })
    expect(
      await recoverAbandonedPluggyEvents(new Date('2026-09-11T00:00:00Z')),
    ).toBe(1)

    await clearTransactionData()
    const connection = (
      await database.db
        .select()
        .from(database.schema.openFinanceConnections)
        .where(eq(database.schema.openFinanceConnections.id, connectionId))
    )[0]
    expect(connection.paused).toBe(true)
    expect(
      await database.db
        .select()
        .from(database.schema.openFinanceTransactionObservations),
    ).toHaveLength(0)

    await disconnectPluggyConnection(
      { connectionId, confirmation: 'DESCONECTAR' },
      gateway,
    )
    expect(gateway.deletedItems).toEqual(['item-1'])
  })

  it('finishes local disconnection when the Item is already absent remotely', async () => {
    const gateway = new FakePluggyGateway()
    const connectionId = await connectedAccount(database, gateway)
    gateway.deleteItem = async () => {
      throw new PluggyIntegrationError(
        'ITEM_NOT_FOUND',
        'Item já removido.',
        false,
      )
    }

    await disconnectPluggyConnection(
      { connectionId, confirmation: 'DESCONECTAR' },
      gateway,
    )
    const connection = (
      await database.db
        .select()
        .from(database.schema.openFinanceConnections)
        .where(eq(database.schema.openFinanceConnections.id, connectionId))
    )[0]
    expect(connection).toMatchObject({
      status: 'disconnected',
      paused: true,
    })
  })

  it('refreshes entity data on item webhooks without fetching all transactions', async () => {
    const gateway = new FakePluggyGateway()
    await connectedAccount(database, gateway)
    const fetchesAfterBootstrap = gateway.transactionFetches
    await enqueuePluggyWebhook({
      eventId: 'item-update',
      event: 'item/updated',
      itemId: 'item-1',
      triggeredBy: 'SYNC',
    })
    await processNextPluggyWebhook(gateway)
    expect(gateway.transactionFetches).toBe(fetchesAfterBootstrap)
  })
})

describe('Open Finance history window', () => {
  let database: TestDatabase

  beforeEach(async () => {
    database = await openTestDatabase()
  })

  afterEach(() => database.close())

  it('copies three months to a new account and opens it at the booked bank balance', async () => {
    const gateway = new FakePluggyGateway()
    gateway.transactions.set('provider-bank', [
      providerTransaction({
        id: 'too-old',
        date: new Date('2026-05-20T15:00:00Z'),
      }),
      providerTransaction({
        id: 'first-day',
        date: new Date('2026-06-01T15:00:00Z'),
        type: 'CREDIT',
        amount: 300.25,
      }),
      providerTransaction({ id: 'recent', amount: 10.1 }),
      providerTransaction({
        id: 'pending',
        status: TransactionStatus.PENDING,
        amount: 5,
      }),
    ])
    await registeredConnection(database, gateway)

    const result = await mapPluggyAccount(
      {
        providerAccountId: 'provider-bank',
        newTarget: {
          type: 'account',
          name: 'Conta Pluggy',
          kind: 'checking',
          purpose: 'operating',
        },
      },
      gateway,
      mappedAt,
    )

    expect(result).toMatchObject({
      historyStart: '2026-06-01',
      created: 3,
      // Booked 900.00 (not the 1000.00 available) minus +300.25 and -10.10.
      openingBalanceCents: 60_985,
    })
    expect(gateway.transactionFilters.at(-1)).toEqual({
      dateFrom: '2026-06-01',
    })
    const copied = await database.db
      .select({ externalId: database.schema.transactions.externalId })
      .from(database.schema.transactions)
      .where(eq(database.schema.transactions.accountId, result.accountId!))
    expect(copied.map((row) => row.externalId).sort()).toEqual([
      'first-day',
      'pending',
      'recent',
    ])
    const [opening] = await database.db
      .select()
      .from(database.schema.balanceCheckpoints)
      .where(
        eq(database.schema.balanceCheckpoints.accountId, result.accountId!),
      )
    expect(opening).toMatchObject({
      kind: 'opening',
      source: 'integration',
      reviewState: 'observed',
      balanceType: 'posted',
      asOf: '2026-05-31',
      balanceCents: 60_985,
    })
    const snapshot = await getFinanceSnapshot()
    expect(
      snapshot.accounts.find((item) => item.id === result.accountId)
        ?.balanceCents,
    ).toBe(90_000)
  })

  it('copies six months when chosen', async () => {
    const gateway = new FakePluggyGateway()
    gateway.transactions.set('provider-bank', [
      providerTransaction({
        id: 'march',
        date: new Date('2026-03-02T15:00:00Z'),
      }),
    ])
    await registeredConnection(database, gateway)
    const result = await mapPluggyAccount(
      {
        providerAccountId: 'provider-bank',
        historyMonths: 6,
        newTarget: {
          type: 'account',
          name: 'Conta Pluggy',
          kind: 'checking',
          purpose: 'operating',
        },
      },
      gateway,
      mappedAt,
    )
    expect(result).toMatchObject({ historyStart: '2026-03-01', created: 1 })
  })

  it('keeps ignoring facts older than the window on later webhooks', async () => {
    const gateway = new FakePluggyGateway()
    const connectionId = await connectedAccount(database, gateway)
    gateway.transactions.set('provider-bank', [
      providerTransaction(),
      providerTransaction({
        id: 'late-old',
        date: new Date('2026-04-02T15:00:00Z'),
      }),
    ])
    await enqueuePluggyWebhook({
      eventId: 'late-created',
      event: 'transactions/created',
      itemId: 'item-1',
      accountId: 'provider-bank',
      transactionsCreatedAtFrom: '2026-09-15T00:00:00Z',
      triggeredBy: 'SYNC',
    })
    await processNextPluggyWebhook(gateway)
    await syncPluggyConnection({ connectionId }, gateway)

    expect(gateway.transactionFilters).toContainEqual({
      createdAtFrom: '2026-09-15T00:00:00Z',
    })
    expect(gateway.transactionFilters.at(-1)).toEqual({
      dateFrom: '2026-06-01',
    })
    const late = await database.db
      .select()
      .from(database.schema.transactions)
      .where(eq(database.schema.transactions.externalId, 'late-old'))
    expect(late).toHaveLength(0)
  })

  it('continues an account with local history from its latest fact without a new opening', async () => {
    const gateway = new FakePluggyGateway()
    await database.db.insert(database.schema.transactions).values({
      id: 'file-latest',
      accountId: database.ids.brlAccount,
      fingerprint: 'file-latest',
      postedAt: '2026-09-03',
      description: 'Aluguel',
      normalizedDescription: 'aluguel',
      amountCents: -150_000,
      currency: 'BRL',
      status: 'confirmed',
    })
    await registeredConnection(database, gateway)
    const result = await mapPluggyAccount(
      {
        providerAccountId: 'provider-bank',
        existingTarget: { type: 'account', id: database.ids.brlAccount },
      },
      gateway,
      mappedAt,
    )
    expect(result).toMatchObject({
      historyStart: '2026-08-27',
      openingBalanceCents: null,
    })
    const checkpoints = await database.db
      .select()
      .from(database.schema.balanceCheckpoints)
      .where(
        eq(
          database.schema.balanceCheckpoints.accountId,
          database.ids.brlAccount,
        ),
      )
    expect(checkpoints).toHaveLength(0)
  })

  it('continues only from settled history up to today', async () => {
    const gateway = new FakePluggyGateway()
    const local = {
      accountId: database.ids.brlAccount,
      description: 'Local',
      normalizedDescription: 'local',
      amountCents: -1_000,
      currency: 'BRL',
    }
    await database.db.insert(database.schema.transactions).values([
      {
        ...local,
        id: 'settled',
        fingerprint: 'settled',
        postedAt: '2026-09-03',
        status: 'confirmed',
      },
      {
        ...local,
        id: 'future-pending',
        fingerprint: 'future-pending',
        postedAt: '2026-12-31',
        status: 'pending',
      },
      {
        ...local,
        id: 'future-confirmed',
        fingerprint: 'future-confirmed',
        postedAt: '2026-11-30',
        status: 'confirmed',
      },
      {
        ...local,
        id: 'excluded',
        fingerprint: 'excluded',
        postedAt: '2026-09-14',
        status: 'excluded',
      },
    ])
    await registeredConnection(database, gateway)
    const result = await mapPluggyAccount(
      {
        providerAccountId: 'provider-bank',
        existingTarget: { type: 'account', id: database.ids.brlAccount },
      },
      gateway,
      mappedAt,
    )
    expect(result).toMatchObject({ historyStart: '2026-08-27', created: 1 })
    const imported = await database.db
      .select()
      .from(database.schema.transactions)
      .where(
        eq(database.schema.transactions.externalId, 'provider-transaction-1'),
      )
    expect(imported).toHaveLength(1)
  })

  it('treats an account with only pending or future rows as new', async () => {
    const gateway = new FakePluggyGateway()
    await database.db.insert(database.schema.transactions).values({
      id: 'future-pending',
      accountId: database.ids.brlAccount,
      fingerprint: 'future-pending',
      postedAt: '2026-12-31',
      description: 'Agendado',
      normalizedDescription: 'agendado',
      amountCents: -5_000,
      currency: 'BRL',
      status: 'pending',
    })
    await registeredConnection(database, gateway)
    const result = await mapPluggyAccount(
      {
        providerAccountId: 'provider-bank',
        existingTarget: { type: 'account', id: database.ids.brlAccount },
      },
      gateway,
      mappedAt,
    )
    // Booked 900.00 minus the copied -10.00 on Sep 10.
    expect(result).toMatchObject({
      historyStart: '2026-06-01',
      created: 1,
      openingBalanceCents: 91_000,
    })
  })

  it('records the opening balance on the next sync when the bootstrap fetch fails', async () => {
    const gateway = new FakePluggyGateway()
    const connectionId = await registeredConnection(database, gateway)
    const fetchAll = gateway.fetchAllTransactions.bind(gateway)
    gateway.fetchAllTransactions = async () => {
      throw new Error('Pluggy indisponível')
    }
    await expect(
      mapPluggyAccount(
        {
          providerAccountId: 'provider-bank',
          existingTarget: { type: 'account', id: database.ids.brlAccount },
        },
        gateway,
        mappedAt,
      ),
    ).rejects.toThrow('Pluggy indisponível')
    gateway.fetchAllTransactions = fetchAll

    const first = await syncPluggyConnection({ connectionId }, gateway)
    expect(first).toMatchObject({ created: 1, openings: 1 })
    await syncPluggyConnection({ connectionId }, gateway)

    const checkpoints = await database.db
      .select()
      .from(database.schema.balanceCheckpoints)
      .where(
        eq(
          database.schema.balanceCheckpoints.accountId,
          database.ids.brlAccount,
        ),
      )
    expect(checkpoints).toHaveLength(1)
    expect(checkpoints[0]).toMatchObject({
      kind: 'opening',
      balanceType: 'posted',
      asOf: '2026-05-31',
      balanceCents: 91_000,
    })
    const [providerAccount] = await database.db
      .select()
      .from(database.schema.openFinanceAccounts)
      .where(
        eq(
          database.schema.openFinanceAccounts.providerAccountId,
          'provider-bank',
        ),
      )
    expect(providerAccount.historyBootstrap).toBe('complete')
  })

  it('never records the available balance as a posted opening', async () => {
    const gateway = new FakePluggyGateway()
    gateway.accounts = [
      {
        ...account(),
        bankData: { ...account().bankData!, closingBalance: null },
      },
    ]
    const connectionId = await registeredConnection(database, gateway)
    const result = await mapPluggyAccount(
      {
        providerAccountId: 'provider-bank',
        existingTarget: { type: 'account', id: database.ids.brlAccount },
      },
      gateway,
      mappedAt,
    )
    expect(result).toMatchObject({ created: 1, openingBalanceCents: null })
    const checkpointsFor = () =>
      database.db
        .select()
        .from(database.schema.balanceCheckpoints)
        .where(
          eq(
            database.schema.balanceCheckpoints.accountId,
            database.ids.brlAccount,
          ),
        )
    expect(await checkpointsFor()).toHaveLength(0)

    // Once the booked balance is reported, the pending bootstrap completes.
    gateway.accounts = [account()]
    await syncPluggyConnection({ connectionId }, gateway)
    expect(await checkpointsFor()).toMatchObject([
      { kind: 'opening', balanceType: 'posted', balanceCents: 91_000 },
    ])
  })

  it('applies corrections that move a known transaction before the window', async () => {
    const gateway = new FakePluggyGateway()
    await connectedAccount(database, gateway)
    gateway.transactions.set('provider-bank', [
      providerTransaction({ date: new Date('2026-05-20T15:00:00Z') }),
    ])
    await enqueuePluggyWebhook({
      eventId: 'moved-before-window',
      event: 'transactions/updated',
      itemId: 'item-1',
      accountId: 'provider-bank',
      transactionIds: ['provider-transaction-1'],
      triggeredBy: 'SYNC',
    })
    await processNextPluggyWebhook(gateway)

    const pending = await database.db
      .select()
      .from(database.schema.openFinanceTransactionObservations)
      .where(
        eq(
          database.schema.openFinanceTransactionObservations.resolution,
          'correction_pending',
        ),
      )
    expect(pending).toHaveLength(1)
    expect(pending[0].postedAt).toBe('2026-05-20')
  })

  it('keeps the booked opening when a correction moves a fact before the window', async () => {
    const gateway = new FakePluggyGateway()
    const connectionId = await connectedAccount(database, gateway)
    const balance = async () =>
      (await getFinanceSnapshot()).accounts.find(
        (item) => item.id === database.ids.brlAccount,
      )?.balanceCents
    expect(await balance()).toBe(90_000)

    gateway.transactions.set('provider-bank', [
      providerTransaction({
        date: new Date('2026-05-20T15:00:00Z'),
        amount: 20,
      }),
    ])
    await syncPluggyConnection({ connectionId }, gateway)
    const [pending] = await database.db
      .select()
      .from(database.schema.openFinanceTransactionObservations)
      .where(
        eq(
          database.schema.openFinanceTransactionObservations.resolution,
          'correction_pending',
        ),
      )
    await resolvePluggyCorrection({
      observationId: pending.id,
      action: 'accept',
    })

    // The moved debit now predates the opening, which Pluggy's booked
    // 900.00 already explains.
    expect(await balance()).toBe(90_000)
    await syncPluggyConnection({ connectionId }, gateway)
    expect(await balance()).toBe(90_000)
    const active = await database.db
      .select()
      .from(database.schema.balanceCheckpoints)
      .where(
        eq(
          database.schema.balanceCheckpoints.accountId,
          database.ids.brlAccount,
        ),
      )
    expect(
      active.filter((checkpoint) => checkpoint.reviewState !== 'invalidated'),
    ).toMatchObject([
      { kind: 'opening', asOf: '2026-05-31', balanceCents: 90_000 },
    ])
  })

  it('derives a resumed opening from the accepted correction', async () => {
    const gateway = new FakePluggyGateway()
    gateway.accounts = [
      {
        ...account(),
        bankData: { ...account().bankData!, closingBalance: null },
      },
    ]
    const connectionId = await registeredConnection(database, gateway)
    await mapPluggyAccount(
      {
        providerAccountId: 'provider-bank',
        existingTarget: { type: 'account', id: database.ids.brlAccount },
      },
      gateway,
      mappedAt,
    )

    // The retry reports the booked 900.00 and corrects the debit to 20.00.
    gateway.accounts = [account()]
    gateway.transactions.set('provider-bank', [
      providerTransaction({ amount: 20 }),
    ])
    const retry = await syncPluggyConnection({ connectionId }, gateway)
    expect(retry).toMatchObject({ corrections: 1 })
    const balance = async () =>
      (await getFinanceSnapshot()).accounts.find(
        (item) => item.id === database.ids.brlAccount,
      )?.balanceCents
    expect(await balance()).toBe(90_000)

    const [pending] = await database.db
      .select()
      .from(database.schema.openFinanceTransactionObservations)
      .where(
        eq(
          database.schema.openFinanceTransactionObservations.resolution,
          'correction_pending',
        ),
      )
    await resolvePluggyCorrection({
      observationId: pending.id,
      action: 'accept',
    })
    expect(await balance()).toBe(90_000)
  })

  it('values an investment position from the accepted correction', async () => {
    const { db, schema, ids } = database
    await db.insert(schema.accounts).values({
      id: 'pluggy-broker',
      ownershipScopeId: ids.personScope,
      institutionId: ids.institution,
      name: 'Corretora Pluggy',
      kind: 'investment',
      purpose: 'investment',
      currency: 'BRL',
    })
    await db.insert(schema.investmentGoals).values({
      id: 'pluggy-reserve-goal',
      name: 'Reserva de emergência',
      type: 'emergency_reserve',
      targetCents: 1_000_000,
      currentCents: 0,
      priority: 1,
    })
    const gateway = new FakePluggyGateway()
    const contribution = providerTransaction({
      id: 'provider-contribution',
      description: 'Aporte CDB',
      type: 'CREDIT',
      amount: 300,
    })
    gateway.transactions.set('provider-bank', [contribution])
    const connectionId = await registeredConnection(database, gateway)
    await mapPluggyAccount(
      {
        providerAccountId: 'provider-bank',
        existingTarget: { type: 'account', id: 'pluggy-broker' },
      },
      gateway,
      mappedAt,
    )
    const [copied] = await db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.accountId, 'pluggy-broker'))
    expect(copied.amountCents).toBe(30_000)
    const { positionId } = await classifyInvestmentTransaction({
      transactionId: copied.id,
      newPosition: {
        name: 'CDB',
        assetClassId: 'fixed-income',
        goalId: 'pluggy-reserve-goal',
      },
    })

    gateway.transactions.set('provider-bank', [
      { ...contribution, amount: 500 },
    ])
    await syncPluggyConnection({ connectionId }, gateway)
    const [pending] = await db
      .select()
      .from(schema.openFinanceTransactionObservations)
      .where(
        eq(
          schema.openFinanceTransactionObservations.resolution,
          'correction_pending',
        ),
      )
    await resolvePluggyCorrection({
      observationId: pending.id,
      action: 'accept',
    })

    const investments = await getInvestmentsSnapshot({})
    const position = investments.positions.find(
      (item) => item.id === positionId,
    )
    expect(position).toMatchObject({
      currentAmountMinor: 50_000,
      currentBaseCents: 50_000,
    })
    expect(position?.movements[0]).toMatchObject({
      transactionId: copied.id,
      amountMinor: 50_000,
    })
    expect(investments.summary).toMatchObject({
      totalCents: 50_000,
      reserveCurrentCents: 50_000,
    })
    const planning = await getPlanningSnapshot()
    expect(planning.dashboard.reserve.currentCents).toBe(50_000)
  })

  it('derives the opening again when Pluggy deletes a copied fact', async () => {
    const gateway = new FakePluggyGateway()
    await connectedAccount(database, gateway)
    const balance = async () =>
      (await getFinanceSnapshot()).accounts.find(
        (item) => item.id === database.ids.brlAccount,
      )?.balanceCents
    expect(await balance()).toBe(90_000)

    await enqueuePluggyWebhook({
      eventId: 'delete-copied',
      event: 'transactions/deleted',
      itemId: 'item-1',
      accountId: 'provider-bank',
      transactionIds: ['provider-transaction-1'],
    })
    await processNextPluggyWebhook(gateway)
    // The booked 900.00 never contained the deleted debit.
    expect(await balance()).toBe(90_000)
  })

  it('derives the opening again when a copied pending fact is confirmed', async () => {
    const gateway = new FakePluggyGateway()
    const pendingDebit = providerTransaction({
      id: 'historical-pending',
      date: new Date('2026-09-12T15:00:00Z'),
      status: TransactionStatus.PENDING,
    })
    gateway.transactions.set('provider-bank', [
      providerTransaction(),
      pendingDebit,
    ])
    const connectionId = await connectedAccount(database, gateway)
    const balance = async () =>
      (await getFinanceSnapshot()).accounts.find(
        (item) => item.id === database.ids.brlAccount,
      )?.balanceCents
    expect(await balance()).toBe(90_000)

    gateway.transactions.set('provider-bank', [
      providerTransaction(),
      { ...pendingDebit, status: TransactionStatus.POSTED },
    ])
    await syncPluggyConnection({ connectionId }, gateway)
    expect(await balance()).toBe(90_000)
  })

  it('derives the opening again for late facts inside the observed interval only', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-09-15T15:00:00Z'))
      const gateway = new FakePluggyGateway()
      const connectionId = await connectedAccount(database, gateway)
      const balance = async () =>
        (await getFinanceSnapshot()).accounts.find(
          (item) => item.id === database.ids.brlAccount,
        )?.balanceCents
      expect(await balance()).toBe(90_000)

      // Booked 900.00 was observed on Sep 15: the Sep 12 debit was already
      // in it, the Sep 16 debit happened afterwards.
      vi.setSystemTime(new Date('2026-09-17T15:00:00Z'))
      gateway.transactions.set('provider-bank', [
        providerTransaction(),
        providerTransaction({
          id: 'late-inside',
          date: new Date('2026-09-12T15:00:00Z'),
          amount: 20,
        }),
        providerTransaction({
          id: 'after-observation',
          date: new Date('2026-09-16T15:00:00Z'),
          amount: 5,
        }),
      ])
      await syncPluggyConnection({ connectionId }, gateway)
      expect(await balance()).toBe(89_500)
    } finally {
      vi.useRealTimers()
    }
  })

  it('explains facts left by a failed batch on the next successful sync', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-09-15T15:00:00Z'))
      const gateway = new FakePluggyGateway()
      const connectionId = await connectedAccount(database, gateway)
      const balance = async () =>
        (await getFinanceSnapshot()).accounts.find(
          (item) => item.id === database.ids.brlAccount,
        )?.balanceCents
      expect(await balance()).toBe(90_000)

      vi.setSystemTime(new Date('2026-09-17T15:00:00Z'))
      const lateInside = providerTransaction({
        id: 'late-inside',
        date: new Date('2026-09-12T15:00:00Z'),
        amount: 20,
      })
      gateway.transactions.set('provider-bank', [
        providerTransaction(),
        lateInside,
        providerTransaction({ id: 'broken', date: new Date('invalid') }),
      ])
      await expect(
        syncPluggyConnection({ connectionId }, gateway),
      ).rejects.toThrow()

      gateway.transactions.set('provider-bank', [
        providerTransaction(),
        lateInside,
        providerTransaction({
          id: 'broken',
          date: new Date('2026-09-16T15:00:00Z'),
          amount: 5,
        }),
      ])
      await syncPluggyConnection({ connectionId }, gateway)
      // Booked 900.00 on Sep 15 already held the Sep 12 debit.
      expect(await balance()).toBe(89_500)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the booked balance as anchor over an earlier checkpoint', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-09-15T15:00:00Z'))
      const gateway = new FakePluggyGateway()
      const pendingDebit = providerTransaction({
        id: 'historical-pending',
        date: new Date('2026-09-12T15:00:00Z'),
        status: TransactionStatus.PENDING,
      })
      gateway.transactions.set('provider-bank', [
        providerTransaction(),
        pendingDebit,
      ])
      const connectionId = await connectedAccount(database, gateway)
      const balance = async () =>
        (await getFinanceSnapshot()).accounts.find(
          (item) => item.id === database.ids.brlAccount,
        )?.balanceCents
      await createManualBalanceCheckpoint({
        targetType: 'account',
        targetId: database.ids.brlAccount,
        balanceCents: 90_000,
        asOf: '2026-09-11',
        balanceType: 'posted',
      })
      expect(await balance()).toBe(90_000)

      gateway.transactions.set('provider-bank', [
        providerTransaction(),
        { ...pendingDebit, status: TransactionStatus.POSTED },
      ])
      await syncPluggyConnection({ connectionId }, gateway)
      expect(await balance()).toBe(90_000)

      await enqueuePluggyWebhook({
        eventId: 'delete-after-checkpoint',
        event: 'transactions/deleted',
        itemId: 'item-1',
        accountId: 'provider-bank',
        transactionIds: ['historical-pending'],
      })
      await processNextPluggyWebhook(gateway)
      expect(await balance()).toBe(90_000)

      // A later dated checkpoint still wins.
      await createManualBalanceCheckpoint({
        targetType: 'account',
        targetId: database.ids.brlAccount,
        balanceCents: 85_000,
        asOf: '2026-09-16',
        balanceType: 'posted',
      })
      expect(await balance()).toBe(85_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('derives the opening again for a manual fact inside the observed interval', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-09-15T15:00:00Z'))
      const gateway = new FakePluggyGateway()
      const connectionId = await connectedAccount(database, gateway)
      const balance = async () =>
        (await getFinanceSnapshot()).accounts.find(
          (item) => item.id === database.ids.brlAccount,
        )?.balanceCents
      const opening = async () =>
        (
          await database.db
            .select()
            .from(database.schema.balanceCheckpoints)
            .where(
              eq(
                database.schema.balanceCheckpoints.accountId,
                database.ids.brlAccount,
              ),
            )
        ).find(
          (row) => row.kind === 'opening' && row.reviewState !== 'invalidated',
        )?.balanceCents
      expect(await opening()).toBe(91_000)

      await createManualTransaction({
        targetType: 'account',
        targetId: database.ids.brlAccount,
        postedAt: '2026-09-12',
        description: 'Débito omitido',
        direction: 'outflow',
        amountCents: 2_000,
        categoryId: 'groceries',
      })
      expect(await balance()).toBe(90_000)
      expect(await opening()).toBe(93_000)

      await syncPluggyConnection({ connectionId }, gateway)
      expect(await balance()).toBe(90_000)
      expect(await opening()).toBe(93_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the booked anchor after a manual fact dated before the window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-09-15T15:00:00Z'))
      const gateway = new FakePluggyGateway()
      const connectionId = await registeredConnection(database, gateway)
      const mapped = await mapPluggyAccount(
        {
          providerAccountId: 'provider-bank',
          newTarget: {
            type: 'account',
            name: 'Conta Pluggy',
            kind: 'checking',
            purpose: 'operating',
          },
        },
        gateway,
        mappedAt,
      )
      expect(mapped.historyStart).toBe('2026-06-01')
      const balance = async () =>
        (await getFinanceSnapshot()).accounts.find(
          (item) => item.id === mapped.accountId,
        )?.balanceCents
      expect(await balance()).toBe(90_000)

      await createManualTransaction({
        targetType: 'account',
        targetId: mapped.accountId!,
        postedAt: '2026-05-30',
        description: 'Débito anterior à janela',
        direction: 'outflow',
        amountCents: 2_000,
        categoryId: 'groceries',
      })
      expect(await balance()).toBe(90_000)

      await syncPluggyConnection({ connectionId }, gateway)
      expect(await balance()).toBe(90_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the same balance across a sync after replacing an earlier checkpoint', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-09-15T15:00:00Z'))
      const gateway = new FakePluggyGateway()
      const connectionId = await connectedAccount(database, gateway)
      const balance = async () =>
        (await getFinanceSnapshot()).accounts.find(
          (item) => item.id === database.ids.brlAccount,
        )?.balanceCents
      await createManualBalanceCheckpoint({
        targetType: 'account',
        targetId: database.ids.brlAccount,
        balanceCents: 90_000,
        asOf: '2026-09-11',
        balanceType: 'posted',
      })
      await createManualBalanceCheckpoint({
        targetType: 'account',
        targetId: database.ids.brlAccount,
        balanceCents: 80_000,
        asOf: '2026-09-11',
        balanceType: 'posted',
        replaceExisting: true,
      })
      const afterReplacement = await balance()

      await syncPluggyConnection({ connectionId }, gateway)
      expect(await balance()).toBe(afterReplacement)
      // The booked observation of Sept 15 is newer than the replaced checkpoint.
      expect(afterReplacement).toBe(90_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the booked anchor after replacing a checkpoint dated before the opening', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-09-15T15:00:00Z'))
      const gateway = new FakePluggyGateway()
      const connectionId = await registeredConnection(database, gateway)
      const mapped = await mapPluggyAccount(
        {
          providerAccountId: 'provider-bank',
          newTarget: {
            type: 'account',
            name: 'Conta Pluggy',
            kind: 'checking',
            purpose: 'operating',
          },
        },
        gateway,
        mappedAt,
      )
      expect(mapped.historyStart).toBe('2026-06-01')
      const accountId = mapped.accountId!
      const balance = async () =>
        (await getFinanceSnapshot()).accounts.find(
          (item) => item.id === accountId,
        )?.balanceCents
      await createManualBalanceCheckpoint({
        targetType: 'account',
        targetId: accountId,
        balanceCents: 80_000,
        asOf: '2026-05-30',
        balanceType: 'posted',
      })
      expect(await balance()).toBe(90_000)

      // Replacing May 30 also reaches the May 31 inferred opening; the booked
      // 900.00 of Sept 15 still anchors the account.
      await createManualBalanceCheckpoint({
        targetType: 'account',
        targetId: accountId,
        balanceCents: 70_000,
        asOf: '2026-05-30',
        balanceType: 'posted',
        replaceExisting: true,
      })
      expect(await balance()).toBe(90_000)
      await syncPluggyConnection({ connectionId }, gateway)
      expect(await balance()).toBe(90_000)
      const active = (
        await database.db
          .select()
          .from(database.schema.balanceCheckpoints)
          .where(eq(database.schema.balanceCheckpoints.accountId, accountId))
      ).filter((checkpoint) => checkpoint.reviewState !== 'invalidated')
      expect(
        active.map(({ kind, asOf, balanceCents }) => ({
          kind,
          asOf,
          balanceCents,
        })),
      ).toEqual(
        expect.arrayContaining([
          { kind: 'manual', asOf: '2026-05-30', balanceCents: 70_000 },
          { kind: 'opening', asOf: '2026-05-31', balanceCents: 91_000 },
        ]),
      )
      expect(active).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ['a refund', 'Estorno loja', 'Shopping', 'suggested'],
    [
      'a Pluggy bill payment receipt',
      'Pagamento efetuado',
      'Credit card payment',
      'confirmed',
    ],
  ])(
    'auto-confirms a bill payment against %s only when the card credit is a payment',
    async (_label, cardDescription, cardCategory, expectedStatus) => {
      const gateway = new FakePluggyGateway()
      gateway.accounts = [account(), account('CREDIT')]
      gateway.transactions.set('provider-bank', [
        providerTransaction({
          id: 'bill-payment',
          description: 'Pagamento fatura cartão principal',
          amount: 1000,
          category: 'Transfers',
        }),
      ])
      gateway.transactions.set('provider-card', [
        providerTransaction({
          id: 'card-credit',
          accountId: 'provider-card',
          description: cardDescription,
          type: 'CREDIT',
          amount: -1000,
          category: cardCategory,
        }),
      ])
      await registeredConnection(database, gateway)
      await mapPluggyAccount(
        {
          providerAccountId: 'provider-bank',
          existingTarget: { type: 'account', id: database.ids.brlAccount },
        },
        gateway,
        mappedAt,
      )
      await mapPluggyAccount(
        {
          providerAccountId: 'provider-card',
          newTarget: {
            type: 'card',
            name: 'Outro cartão',
            limitCents: 500_000,
            closingDay: 20,
            dueDay: 27,
          },
        },
        gateway,
        mappedAt,
      )
      const { db, schema } = database
      const copied = await db
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.postedAt, '2026-09-10'))
      const bank = copied.find((row) => row.amountCents === -100_000)
      const card = copied.find(
        (row) => row.creditCardId && row.amountCents === 100_000,
      )
      expect(bank).toBeDefined()
      expect(card).toBeDefined()

      await refreshReconciliationSuggestions()

      const groups = await db
        .select({
          status: schema.reconciliationGroups.status,
          type: schema.reconciliationGroups.type,
          transactionId: schema.reconciliationLinks.transactionId,
        })
        .from(schema.reconciliationLinks)
        .innerJoin(
          schema.reconciliationGroups,
          eq(
            schema.reconciliationGroups.id,
            schema.reconciliationLinks.groupId,
          ),
        )
        .where(eq(schema.reconciliationLinks.transactionId, card!.id))
      expect(groups).toEqual([
        {
          status: expectedStatus,
          type: 'card_payment',
          transactionId: card!.id,
        },
      ])
      const [cardAfter] = await db
        .select({ categoryId: schema.transactions.categoryId })
        .from(schema.transactions)
        .where(eq(schema.transactions.id, card!.id))
      if (expectedStatus === 'suggested') {
        expect(cardAfter.categoryId).toBe(card!.categoryId)
      } else {
        expect(cardAfter.categoryId).toBe('card_payment')
      }
    },
  )

  async function bankAndCardWithBillPayment(input: {
    purchases: Array<{ id: string; date: string; amount: number }>
    paymentDate: string
    cardDescription: string
    cardCategory: string
  }) {
    const gateway = new FakePluggyGateway()
    gateway.accounts = [account(), account('CREDIT')]
    gateway.transactions.set('provider-bank', [
      providerTransaction({
        id: 'bill-payment',
        date: new Date(`${input.paymentDate}T15:00:00Z`),
        description: 'Pagamento fatura cartão principal',
        amount: 1000,
        category: 'Transfers',
      }),
    ])
    gateway.transactions.set('provider-card', [
      ...input.purchases.map((purchase) =>
        providerTransaction({
          id: purchase.id,
          accountId: 'provider-card',
          date: new Date(`${purchase.date}T15:00:00Z`),
          description: `Loja ${purchase.id}`,
          amount: purchase.amount,
          category: 'Shopping',
        }),
      ),
      providerTransaction({
        id: 'card-credit',
        accountId: 'provider-card',
        date: new Date(`${input.paymentDate}T15:00:00Z`),
        description: input.cardDescription,
        type: 'CREDIT',
        amount: -1000,
        category: input.cardCategory,
      }),
    ])
    const connectionId = await registeredConnection(database, gateway)
    await mapPluggyAccount(
      {
        providerAccountId: 'provider-bank',
        existingTarget: { type: 'account', id: database.ids.brlAccount },
      },
      gateway,
      mappedAt,
    )
    await mapPluggyAccount(
      {
        providerAccountId: 'provider-card',
        newTarget: {
          type: 'card',
          name: 'Outro cartão',
          limitCents: 500_000,
          closingDay: 20,
          dueDay: 27,
        },
      },
      gateway,
      mappedAt,
    )
    await refreshReconciliationSuggestions()
    const { db, schema } = database
    const rows = await db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.postedAt, input.paymentDate))
    const bank = rows.find((row) => row.amountCents === -100_000)!
    const card = rows.find(
      (row) => row.creditCardId && row.amountCents === 100_000,
    )!
    return { gateway, connectionId, bank, card }
  }

  async function groupsOf(transactionId: string) {
    const { db, schema } = database
    return db
      .select({
        status: schema.reconciliationGroups.status,
        type: schema.reconciliationGroups.type,
      })
      .from(schema.reconciliationLinks)
      .innerJoin(
        schema.reconciliationGroups,
        eq(schema.reconciliationGroups.id, schema.reconciliationLinks.groupId),
      )
      .where(eq(schema.reconciliationLinks.transactionId, transactionId))
  }

  async function categoryOf(transactionId: string) {
    const { db, schema } = database
    const [row] = await db
      .select({ categoryId: schema.transactions.categoryId })
      .from(schema.transactions)
      .where(eq(schema.transactions.id, transactionId))
    return row.categoryId
  }

  it('reopens an automatic bill payment match when an accepted correction turns the receipt into a refund', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-09-25T15:00:00Z'))
      const { gateway, connectionId, bank, card } =
        await bankAndCardWithBillPayment({
          purchases: [
            { id: 'purchase-a', date: '2026-09-01', amount: 1200 },
            { id: 'purchase-b', date: '2026-09-05', amount: 800 },
          ],
          paymentDate: '2026-09-10',
          cardDescription: 'Pagamento recebido',
          cardCategory: 'Credit card payment',
        })
      expect(await groupsOf(card.id)).toEqual([
        { status: 'confirmed', type: 'card_payment' },
      ])
      expect(await categoryOf(card.id)).toBe('card_payment')

      const transactions = gateway.transactions.get('provider-card')!
      gateway.transactions.set(
        'provider-card',
        transactions.map((transaction) =>
          transaction.id === 'card-credit'
            ? {
                ...transaction,
                description: 'Estorno loja',
                category: 'Shopping',
              }
            : transaction,
        ),
      )
      await syncPluggyConnection({ connectionId }, gateway)
      const { db, schema } = database
      const [correction] = await db
        .select()
        .from(schema.openFinanceTransactionObservations)
        .where(
          eq(
            schema.openFinanceTransactionObservations.resolution,
            'correction_pending',
          ),
        )
      expect(correction.canonicalTransactionId).toBe(card.id)
      await resolvePluggyCorrection({
        observationId: correction.id,
        action: 'accept',
      })

      expect(
        (await groupsOf(card.id)).filter(
          (group) => group.status === 'confirmed',
        ),
      ).toEqual([])
      expect(await categoryOf(card.id)).not.toBe('card_payment')
      // The bank debit is still a bill payment.
      expect(await categoryOf(bank.id)).toBe('card_payment')
      const statement = (await getFinanceSnapshot()).cards
        .find((row) => row.id === card.creditCardId)
        ?.statements.find((row) => row.dueDate === '2026-09-27')
      expect(statement?.amountCents).toBe(100_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a person-confirmed bill payment when a correction turns the receipt into a refund', async () => {
    const { gateway, connectionId, card } = await bankAndCardWithBillPayment({
      purchases: [],
      paymentDate: '2026-09-10',
      cardDescription: 'Crédito na fatura',
      cardCategory: 'Transfers',
    })
    const { db, schema } = database
    const [link] = await db
      .select()
      .from(schema.reconciliationLinks)
      .where(eq(schema.reconciliationLinks.transactionId, card.id))
    expect(await groupsOf(card.id)).toEqual([
      { status: 'suggested', type: 'card_payment' },
    ])
    await setReconciliationStatus({
      groupId: link.groupId,
      status: 'confirmed',
    })

    const transactions = gateway.transactions.get('provider-card')!
    gateway.transactions.set(
      'provider-card',
      transactions.map((transaction) =>
        transaction.id === 'card-credit'
          ? {
              ...transaction,
              description: 'Estorno loja',
              category: 'Shopping',
            }
          : transaction,
      ),
    )
    await syncPluggyConnection({ connectionId }, gateway)
    const [correction] = await db
      .select()
      .from(schema.openFinanceTransactionObservations)
      .where(
        eq(
          schema.openFinanceTransactionObservations.resolution,
          'correction_pending',
        ),
      )
    await resolvePluggyCorrection({
      observationId: correction.id,
      action: 'accept',
    })

    expect(await groupsOf(card.id)).toEqual([
      { status: 'confirmed', type: 'card_payment' },
    ])
    expect(await categoryOf(card.id)).toBe('card_payment')
  })

  it('settles the statement with a receipt identified only by the Pluggy category', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-08-29T15:00:00Z'))
      const { card } = await bankAndCardWithBillPayment({
        purchases: [{ id: 'purchase-a', date: '2026-08-05', amount: 1000 }],
        paymentDate: '2026-08-27',
        cardDescription: 'Pagamento efetuado',
        cardCategory: 'Credit card payment',
      })
      expect(await groupsOf(card.id)).toEqual([
        { status: 'confirmed', type: 'card_payment' },
      ])
      const snapshot = await getFinanceSnapshot()
      const statement = snapshot.cards
        .find((row) => row.id === card.creditCardId)
        ?.statements.find((row) => row.dueDate === '2026-08-27')
      expect(statement).toMatchObject({
        amountCents: 100_000,
        paidCents: 100_000,
        status: 'paid',
      })
      expect(
        snapshot.cashProjection.scheduled.filter((event) =>
          event.id.startsWith(`${card.creditCardId}-`),
        ),
      ).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('settles a card-only statement with a receipt identified only by the Pluggy category', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-08-26T15:00:00Z'))
      const gateway = new FakePluggyGateway()
      gateway.accounts = [account('CREDIT')]
      const purchase = (id: string, date: string, amount: number) =>
        providerTransaction({
          id,
          accountId: 'provider-card',
          date: new Date(`${date}T15:00:00Z`),
          description: `Loja ${id}`,
          amount,
          category: 'Shopping',
        })
      gateway.transactions.set('provider-card', [
        purchase('august', '2026-08-05', 1000),
        purchase('september-a', '2026-08-21', 300),
        purchase('september-b', '2026-08-24', 100),
        providerTransaction({
          id: 'card-credit',
          accountId: 'provider-card',
          date: new Date('2026-08-25T15:00:00Z'),
          description: 'Pagamento efetuado',
          type: 'CREDIT',
          amount: -1000,
          category: 'Credit card payment',
        }),
      ])
      await registeredConnection(database, gateway)
      await mapPluggyAccount(
        {
          providerAccountId: 'provider-card',
          newTarget: {
            type: 'card',
            name: 'Cartão só',
            limitCents: 500_000,
            closingDay: 20,
            dueDay: 27,
          },
        },
        gateway,
        mappedAt,
      )
      await refreshReconciliationSuggestions()

      const snapshot = await getFinanceSnapshot()
      const card = snapshot.cards.find((row) => row.name === 'Cartão só')!
      const statement = (dueDate: string) =>
        card.statements.find((row) => row.dueDate === dueDate)
      expect(statement('2026-08-27')).toMatchObject({
        amountCents: 100_000,
        paidCents: 100_000,
        status: 'paid',
      })
      // The receipt is not a September credit.
      expect(statement('2026-09-27')?.amountCents).toBe(40_000)
      expect(
        snapshot.cashProjection.scheduled.filter(
          (event) =>
            event.id.startsWith(`${card.id}-`) && event.date === '2026-08-27',
        ),
      ).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('dissolves an automatic match when a sync changes only the provider category of the receipt', async () => {
    const { gateway, connectionId, card } = await bankAndCardWithBillPayment({
      purchases: [],
      paymentDate: '2026-09-10',
      cardDescription: 'Pagamento efetuado',
      cardCategory: 'Credit card payment',
    })
    expect(await groupsOf(card.id)).toEqual([
      { status: 'confirmed', type: 'card_payment' },
    ])

    const transactions = gateway.transactions.get('provider-card')!
    gateway.transactions.set(
      'provider-card',
      transactions.map((transaction) =>
        transaction.id === 'card-credit'
          ? { ...transaction, category: 'Shopping' }
          : transaction,
      ),
    )
    await syncPluggyConnection({ connectionId }, gateway)

    expect(
      (await groupsOf(card.id)).filter((group) => group.status === 'confirmed'),
    ).toEqual([])
    expect(await categoryOf(card.id)).not.toBe('card_payment')
  })

  it('keeps a later human category when an accepted correction dissolves an automatic match', async () => {
    const { gateway, connectionId, bank, card } =
      await bankAndCardWithBillPayment({
        purchases: [],
        paymentDate: '2026-09-10',
        cardDescription: 'Pagamento recebido',
        cardCategory: 'Credit card payment',
      })
    expect(await groupsOf(card.id)).toEqual([
      { status: 'confirmed', type: 'card_payment' },
    ])
    await updateTransactionCategory({
      transactionId: card.id,
      categoryId: 'shopping',
      saveRule: false,
    })

    const transactions = gateway.transactions.get('provider-card')!
    gateway.transactions.set(
      'provider-card',
      transactions.map((transaction) =>
        transaction.id === 'card-credit'
          ? {
              ...transaction,
              description: 'Estorno loja',
              category: 'Shopping',
            }
          : transaction,
      ),
    )
    await syncPluggyConnection({ connectionId }, gateway)
    const { db, schema } = database
    const [correction] = await db
      .select()
      .from(schema.openFinanceTransactionObservations)
      .where(
        eq(
          schema.openFinanceTransactionObservations.resolution,
          'correction_pending',
        ),
      )
    await resolvePluggyCorrection({
      observationId: correction.id,
      action: 'accept',
    })

    expect(
      (await groupsOf(card.id)).filter((group) => group.status === 'confirmed'),
    ).toEqual([])
    expect(await categoryOf(card.id)).toBe('shopping')
    // The bank debit still carries the rule's classification of itself.
    expect(await categoryOf(bank.id)).toBe('card_payment')
  })

  it('starts a new card at the statement cycle containing the window start', async () => {
    const gateway = new FakePluggyGateway()
    gateway.accounts = [account('CREDIT')]
    gateway.transactions.set('provider-card', [
      providerTransaction({
        id: 'previous-cycle',
        accountId: 'provider-card',
        date: new Date('2026-05-10T15:00:00Z'),
      }),
      providerTransaction({
        id: 'first-cycle',
        accountId: 'provider-card',
        date: new Date('2026-05-11T15:00:00Z'),
      }),
    ])
    await registeredConnection(database, gateway)
    const result = await mapPluggyAccount(
      {
        providerAccountId: 'provider-card',
        newTarget: {
          type: 'card',
          name: 'Cartão Pluggy',
          limitCents: 100_000,
          closingDay: 10,
          dueDay: 17,
        },
      },
      gateway,
      mappedAt,
    )
    expect(result).toMatchObject({
      historyStart: '2026-05-11',
      created: 1,
      openingBalanceCents: null,
    })
  })
})
