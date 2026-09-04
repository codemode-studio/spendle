import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { openTestDatabase } from '#/test/database'
import type { TestDatabase } from '#/test/database'
import { runImportCorrectionFixture } from './import-correction.integration.fixture'

describe('correções e identidade canônica', () => {
  let database: TestDatabase

  beforeAll(async () => {
    database = await openTestDatabase({ seed: 'production' })
  })

  afterAll(() => {
    database.close()
  })

  it('preserva lançamentos novos, promove identidade e recalcula a âncora', async () => {
    await expect(runImportCorrectionFixture()).resolves.toBeUndefined()
  })
})
