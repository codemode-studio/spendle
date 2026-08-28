import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

describe('grupos de recorrências', () => {
  const directory = mkdtempSync(join(tmpdir(), 'financas-recurrence-groups-'))

  beforeAll(() => {
    process.env.DATABASE_URL = join(directory, 'integration.db')
    vi.resetModules()
  })

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('mantém linhas independentes no mesmo grupo e soma a projeção uma vez', async () => {
    const finance = await import('./finance.server')
    const before = await finance.getFinanceSnapshot('2026-09')

    await finance.createRecurrence({
      name: 'Academia Donald',
      groupName: 'Academia',
      participantLabel: 'Donald',
      categoryId: 'personal_care',
      amountCents: 20_000,
      currency: 'BRL',
      direction: 'expense',
      amountMode: 'fixed',
      destinationMode: 'automatic',
      frequency: 'monthly',
      nextDate: '2026-09-15',
    })
    await finance.createRecurrence({
      name: 'Academia esposa',
      groupName: 'academia',
      participantLabel: 'Esposa',
      categoryId: 'personal_care',
      amountCents: 30_000,
      currency: 'BRL',
      direction: 'expense',
      amountMode: 'fixed',
      destinationMode: 'automatic',
      frequency: 'monthly',
      nextDate: '2026-09-15',
    })

    const snapshot = await finance.getFinanceSnapshot('2026-09')
    const group = snapshot.recurrenceGroups.find(
      (candidate) => candidate.normalizedName === 'academia',
    )
    const items = snapshot.recurrences.filter(
      (recurrence) => recurrence.groupId === group?.id,
    )

    expect(snapshot.recurrenceGroups).toHaveLength(3)
    expect(items).toHaveLength(2)
    expect(items.map((item) => item.participantLabel).sort()).toEqual([
      'Donald',
      'Esposa',
    ])
    expect(items.reduce((sum, item) => sum + item.amountCents, 0)).toBe(50_000)
    expect(snapshot.dashboard.budgetProjected.lifestyle).toBe(
      before.dashboard.budgetProjected.lifestyle + 50_000,
    )
  })
})
