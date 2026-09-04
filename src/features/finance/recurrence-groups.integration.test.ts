import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { openTestDatabase } from '#/test/database'
import type { TestDatabase } from '#/test/database'
import { getFinanceSnapshot } from './finance-snapshot.server'
import * as recurrence from './recurrence.server'

describe('grupos de recorrências', () => {
  let database: TestDatabase

  beforeAll(async () => {
    database = await openTestDatabase()
  })

  afterAll(() => {
    database.close()
  })

  it('mantém linhas independentes no mesmo grupo e soma a projeção uma vez', async () => {
    const { ids } = database
    const before = await getFinanceSnapshot('2026-09')

    await recurrence.createRecurrence({
      name: 'Academia Donald',
      groupName: 'Academia',
      participantLabel: 'Donald',
      categoryId: ids.categories.personalCare,
      amountCents: 20_000,
      currency: 'BRL',
      direction: 'expense',
      amountMode: 'fixed',
      destinationMode: 'automatic',
      frequency: 'monthly',
      nextDate: '2026-09-15',
    })
    await recurrence.createRecurrence({
      name: 'Academia esposa',
      groupName: 'academia',
      participantLabel: 'Esposa',
      categoryId: ids.categories.personalCare,
      amountCents: 30_000,
      currency: 'BRL',
      direction: 'expense',
      amountMode: 'fixed',
      destinationMode: 'automatic',
      frequency: 'monthly',
      nextDate: '2026-09-15',
    })

    const snapshot = await getFinanceSnapshot('2026-09')
    const group = snapshot.recurrenceGroups.find(
      (candidate) => candidate.normalizedName === 'academia',
    )
    const items = snapshot.recurrences.filter(
      (item) => item.groupId === group?.id,
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
