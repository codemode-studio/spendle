import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { openTestDatabase } from '#/test/database'
import type { TestDatabase } from '#/test/database'
import { getPlanningSnapshot } from '#/features/finance/finance-snapshot.server'

import {
  classifyInvestmentTransaction,
  deleteInvestmentMovement,
  getInvestmentsSnapshot,
} from './investments.server'

const quotes = {
  USD: { rateMicros: 5_000_000, date: '2026-09-01', source: 'test' },
  BTC: { rateMicros: 400_000_000_000, date: '2026-09-01', source: 'test' },
}

describe('carteira de investimentos', () => {
  let database: TestDatabase

  beforeAll(async () => {
    database = await openTestDatabase()
    await database.db.insert(database.schema.accounts).values([
      {
        id: 'test-broker-brl',
        ownershipScopeId: database.ids.personScope,
        institutionId: database.ids.institution,
        name: 'Corretora BRL de teste',
        kind: 'investment',
        purpose: 'investment',
        currency: 'BRL',
      },
      {
        id: 'test-broker-usd',
        ownershipScopeId: database.ids.personScope,
        institutionId: database.ids.institution,
        name: 'Corretora USD de teste',
        kind: 'investment',
        purpose: 'investment',
        currency: 'USD',
      },
      {
        id: 'test-broker-btc',
        ownershipScopeId: database.ids.personScope,
        institutionId: database.ids.institution,
        name: 'Carteira BTC de teste',
        kind: 'investment',
        purpose: 'investment',
        currency: 'BTC',
      },
      {
        id: 'test-broker-empty',
        ownershipScopeId: database.ids.personScope,
        institutionId: database.ids.institution,
        name: 'Corretora sem aportes',
        kind: 'investment',
        purpose: 'investment',
        currency: 'BRL',
      },
    ])
    await database.db.insert(database.schema.investmentGoals).values({
      id: 'test-goal-emergency-reserve',
      name: 'Reserva de emergência',
      type: 'emergency_reserve',
      targetCents: 0,
      currentCents: 0,
      priority: 1,
    })
    await database.db.insert(database.schema.investmentPositions).values([
      {
        id: 'test-position-reserve',
        accountId: 'test-broker-brl',
        assetClassId: 'fixed-income',
        goalId: 'test-goal-emergency-reserve',
        name: 'CDB Liquidez diária',
        currency: 'BRL',
        initialAmountMinor: 3_660_000,
        initialBaseCents: 3_660_000,
        manualCurrentAmountMinor: 3_660_000,
        manualCurrentAt: '2026-09-01',
      },
      {
        id: 'test-position-voo',
        accountId: 'test-broker-usd',
        assetClassId: 'stocks',
        name: 'VOO',
        currency: 'USD',
        initialAmountMinor: 200_000,
        initialBaseCents: 1_024_000,
        manualCurrentAmountMinor: 225_000,
        manualCurrentAt: '2026-09-01',
      },
      {
        id: 'test-position-bitcoin',
        accountId: 'test-broker-btc',
        assetClassId: 'crypto',
        name: 'Bitcoin',
        symbol: 'BTC',
        currency: 'BTC',
        initialAmountMinor: 2_000_000,
        initialBaseCents: 700_000,
        manualCurrentAmountMinor: 2_150_000,
        manualCurrentAt: '2026-09-01',
      },
    ])
    await database.db.insert(database.schema.transactions).values({
      id: 'test-investment-entry',
      accountId: 'test-broker-brl',
      categoryId: database.ids.categories.transfer,
      counterpartyAccountId: database.ids.brlAccount,
      fingerprint: 'test-investment-entry-fingerprint',
      sourceKey: 'qa:test-investment-entry',
      postedAt: '2026-09-01',
      description: 'Aporte para investimentos',
      normalizedDescription: 'APORTE PARA INVESTIMENTOS',
      amountCents: 150_000,
      currency: 'BRL',
      baseAmountCents: 150_000,
      baseCurrency: 'BRL',
      exchangeRateMicros: 1_000_000,
      status: 'confirmed',
    })
  })

  afterAll(() => database.close())

  it('preserva o valor original de USD e BTC e converte apenas os totais em BRL', async () => {
    const snapshot = await getInvestmentsSnapshot(quotes)
    const usd = snapshot.positions.find(
      (position) => position.currency === 'USD',
    )!
    const btc = snapshot.positions.find(
      (position) => position.currency === 'BTC',
    )!

    expect(usd.currentAmountMinor).toBe(225_000)
    expect(usd.currentBaseCents).toBe(1_125_000)
    expect(usd.resultBaseCents).toBe(101_000)
    expect(btc.currentAmountMinor).toBe(2_150_000)
    expect(btc.currentBaseCents).toBe(860_000)
    expect(btc.resultBaseCents).toBe(160_000)
    const planning = await getPlanningSnapshot()
    expect(snapshot.summary.reserveTargetCents).toBe(
      planning.dashboard.reserve.targetCents,
    )
    expect(snapshot.positions).toHaveLength(3)
    expect(
      snapshot.positions.some(
        (position) => position.accountName === 'Corretora sem aportes',
      ),
    ).toBe(false)
  })

  it('cria uma posição a partir da transação real e não deixa o aporte solto', async () => {
    await classifyInvestmentTransaction({
      transactionId: 'test-investment-entry',
      newPosition: {
        name: 'Tesouro Selic 2029',
        assetClassId: 'fixed-income',
        goalId: 'test-goal-emergency-reserve',
      },
    })

    const snapshot = await getInvestmentsSnapshot(quotes)
    const position = snapshot.positions.find(
      (item) => item.name === 'Tesouro Selic 2029',
    )!
    expect(position.currentAmountMinor).toBe(150_000)
    expect(position.valueKind).toBe('estimated')
    expect(position.movements).toHaveLength(1)
    expect(snapshot.availableTransactions).toHaveLength(0)
    expect(snapshot.summary.reserveCurrentCents).toBe(3_810_000)

    await deleteInvestmentMovement({ movementId: position.movements[0].id })

    const afterDeletion = await getInvestmentsSnapshot(quotes)
    expect(
      afterDeletion.positions.some((item) => item.id === position.id),
    ).toBe(false)
    expect(
      afterDeletion.availableTransactions.some(
        (item) => item.id === 'test-investment-entry',
      ),
    ).toBe(true)
    expect(afterDeletion.summary.reserveCurrentCents).toBe(3_660_000)
  })
})
