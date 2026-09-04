import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { openTestDatabase } from '#/test/database'
import type { TestDatabase } from '#/test/database'
import * as finance from './finance.server'

describe('transferências para investimentos', () => {
  let database: TestDatabase

  beforeAll(async () => {
    database = await openTestDatabase({ seed: 'production' })
  })

  afterAll(() => {
    database.close()
  })

  it('trata investimentos como contas normais com saldo e transferências', async () => {
    const initialSnapshot = await finance.getFinanceSnapshot()
    expect(initialSnapshot.accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Inter investimentos',
          kind: 'investment',
          purpose: 'investment',
        }),
      ]),
    )
    const account = await finance.createAccount({
      name: 'Carteira de teste',
      institutionName: 'Corretora',
      ownershipScopeId: initialSnapshot.scopes.find(
        (scope) => scope.type === 'household',
      )!.id,
      kind: 'investment' as const,
      purpose: 'investment' as const,
      currency: 'BRL',
      initialBalanceCents: 0,
    })

    await finance.createManualBalanceCheckpoint({
      targetType: 'account',
      targetId: account.id,
      balanceCents: 15_000,
      asOf: '2026-08-26',
      balanceType: 'posted',
    })

    const updatedSnapshot = await finance.getFinanceSnapshot()
    expect(updatedSnapshot.accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Carteira de teste',
          kind: 'investment',
          purpose: 'investment',
          currency: 'BRL',
          balanceCents: 15_000,
        }),
      ]),
    )
    expect(updatedSnapshot.dashboard.netWorthCents).toBe(15_000)
  })
})
