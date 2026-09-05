import { afterEach, beforeEach, expect, it } from 'vitest'
import { openTestDatabase } from '#/test/database'
import type { TestDatabase } from '#/test/database'
import { applyTargetCategoryPolicy } from './categories.server'

let database: TestDatabase
beforeEach(async () => {
  database = await openTestDatabase()
})
afterEach(() => database.close())
it('não deduz finalidade empresarial apenas pela conta PJ', () => {
  const input = {
    amountCents: -5_000,
    description: 'Fornecedor não identificado',
    purpose: 'operating',
    scopeName: 'Empresa',
    scopeType: 'company_br' as const,
  }
  expect(
    applyTargetCategoryPolicy({
      ...input,
      suggestion: {
        categoryId: 'uncategorized',
        confidence: 0,
        source: 'none',
      },
    }).categoryId,
  ).toBe('uncategorized')
  expect(
    applyTargetCategoryPolicy({
      ...input,
      suggestion: { categoryId: 'business', confidence: 100, source: 'rule' },
    }).categoryId,
  ).toBe('business')
})
