import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

describe('transferências para investimentos', () => {
  const directory = mkdtempSync(join(tmpdir(), 'financas-investment-ledger-'))

  beforeAll(() => {
    process.env.DATABASE_URL = join(directory, 'integration.db')
    vi.resetModules()
  })

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('trata investimentos como contas normais com saldo e transferências', async () => {
    const [{ ensureDatabase }, finance] = await Promise.all([
      import('#/db/index.server'),
      import('./finance.server'),
    ])
    await ensureDatabase()
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
      ownershipScopeId: initialSnapshot.scopes[0].id,
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
