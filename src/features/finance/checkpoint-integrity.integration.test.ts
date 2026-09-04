import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { openTestDatabase } from '#/test/database'
import type { TestDatabase } from '#/test/database'
import { runCheckpointIntegrityFixture } from './checkpoint-integrity.integration.fixture'

describe('integridade dos pontos de controle', () => {
  let database: TestDatabase

  beforeAll(async () => {
    database = await openTestDatabase({ seed: 'production' })
  })

  afterAll(() => {
    database.close()
  })

  it('preserva linearidade, origem e tipo de saldo em importações e ajustes manuais', async () => {
    await expect(runCheckpointIntegrityFixture()).resolves.toBeUndefined()
  })
})
