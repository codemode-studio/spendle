import { eq } from 'drizzle-orm'
import type { Account, Item, Transaction } from 'pluggy-sdk'
import { TransactionStatus } from 'pluggy-sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { clearTransactionData } from '#/features/finance/import.server'
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
  async fetchAllTransactions(accountId: string) {
    this.transactionFetches += 1
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
      observedBalanceCents: 100_000,
      observedAvailableBalanceCents: 90_000,
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
