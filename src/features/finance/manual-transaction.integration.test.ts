import { eq, isNull } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { openTestDatabase } from '#/test/database'
import type { TestDatabase } from '#/test/database'
import * as finance from './finance.server'

describe('lançamentos manuais', () => {
  let database: TestDatabase

  beforeAll(async () => {
    database = await openTestDatabase({ seed: 'production' })
  })

  afterAll(() => {
    database.close()
  })

  it('completa uma transferência e registra uma despesa em BTC sem dupla contagem', async () => {
    const { db, schema } = database

    const initialSnapshot = await finance.getFinanceSnapshot()
    const btg = initialSnapshot.accounts.find(
      (account) => account.name === 'BTG compartilhada',
    )!
    const nubank = initialSnapshot.accounts.find((account) =>
      account.name.startsWith('Nubank PF'),
    )!
    const personScope = initialSnapshot.scopes.find(
      (scope) => scope.type === 'person',
    )!

    await finance.createManualBalanceCheckpoint({
      targetType: 'account',
      targetId: btg.id,
      balanceCents: 3_500_000,
      asOf: '2026-07-14',
      balanceType: 'posted',
    })
    const divergentBtgCheckpoint = await finance.createManualBalanceCheckpoint({
      targetType: 'account',
      targetId: btg.id,
      balanceCents: 3_660_000,
      asOf: '2026-08-01',
      balanceType: 'posted',
    })
    expect(divergentBtgCheckpoint.differenceCents).toBe(160_000)

    const nubankSide = await finance.createManualTransaction({
      targetType: 'account',
      targetId: nubank.id,
      postedAt: '2026-08-01',
      description: 'Transferência para BTG',
      direction: 'outflow',
      amountCents: 160_000,
      categoryId: 'transfer',
      counterpartyAccountId: btg.id,
    })
    const btgSide = await finance.createManualTransaction({
      targetType: 'account',
      targetId: btg.id,
      postedAt: '2026-08-01',
      description: 'Transferência recebida do Nubank',
      direction: 'inflow',
      amountCents: 160_000,
      categoryId: 'transfer',
      counterpartyAccountId: nubank.id,
    })

    expect(nubankSide).toMatchObject({ amountCents: -160_000, currency: 'BRL' })
    expect(btgSide).toMatchObject({ amountCents: 160_000, currency: 'BRL' })

    const bitcoin = await finance.createAccount({
      name: 'Bitcoin de teste',
      institutionName: 'Carteira',
      ownershipScopeId: personScope.id,
      kind: 'investment',
      purpose: 'investment',
      currency: 'BTC',
      initialBalanceCents: 0,
    })
    await finance.createManualBalanceCheckpoint({
      targetType: 'account',
      targetId: bitcoin.id,
      balanceCents: 6_348_388,
      asOf: '2026-02-25',
      balanceType: 'posted',
    })
    const divergentBitcoinCheckpoint =
      await finance.createManualBalanceCheckpoint({
        targetType: 'account',
        targetId: bitcoin.id,
        balanceCents: 6_276_108,
        asOf: '2026-08-26',
        balanceType: 'posted',
      })
    expect(divergentBitcoinCheckpoint.differenceCents).toBe(-72_280)

    const bitcoinExpense = await finance.createManualTransaction({
      targetType: 'account',
      targetId: bitcoin.id,
      postedAt: '2026-08-26',
      description: 'Serviço pago em Bitcoin',
      direction: 'outflow',
      amountCents: 72_280,
      categoryId: 'subscriptions',
      notes: 'Lançamento manual',
    })
    expect(bitcoinExpense).toMatchObject({
      amountCents: -72_280,
      currency: 'BTC',
    })

    const [snapshot, manualRows, btgCheckpoints, bitcoinCheckpoints, groups] =
      await Promise.all([
        finance.getFinanceSnapshot(),
        db
          .select()
          .from(schema.transactions)
          .where(isNull(schema.transactions.importId)),
        db
          .select()
          .from(schema.balanceCheckpoints)
          .where(eq(schema.balanceCheckpoints.accountId, btg.id)),
        db
          .select()
          .from(schema.balanceCheckpoints)
          .where(eq(schema.balanceCheckpoints.accountId, bitcoin.id)),
        db.select().from(schema.reconciliationGroups),
      ])

    expect(
      snapshot.accounts.find((account) => account.id === btg.id)?.balanceCents,
    ).toBe(3_660_000)
    expect(
      snapshot.accounts.find((account) => account.id === bitcoin.id)
        ?.balanceCents,
    ).toBe(6_276_108)
    expect(snapshot.dashboard.currentExpenseCents).toBe(0)
    expect(manualRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: btgSide.id,
          importId: null,
          accountId: btg.id,
          status: 'confirmed',
          sourceKey: `manual:${btgSide.id}`,
        }),
        expect.objectContaining({
          id: bitcoinExpense.id,
          importId: null,
          accountId: bitcoin.id,
          status: 'confirmed',
          sourceKey: `manual:${bitcoinExpense.id}`,
        }),
      ]),
    )
    expect(
      btgCheckpoints.find((checkpoint) => checkpoint.asOf === '2026-08-01')
        ?.reviewState,
    ).toBe('invalidated')
    expect(
      bitcoinCheckpoints.find((checkpoint) => checkpoint.asOf === '2026-08-26')
        ?.reviewState,
    ).toBe('invalidated')
    expect(groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'transfer', status: 'confirmed' }),
      ]),
    )
  })
})
