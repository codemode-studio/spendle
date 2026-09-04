import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { openTestDatabase } from '#/test/database'
import type { TestDatabase } from '#/test/database'
import { runCardStatementControlFixture } from './card-statement-control.integration.fixture'

describe('fechamento posterior de fatura', () => {
  let database: TestDatabase

  beforeAll(async () => {
    database = await openTestDatabase({ seed: 'production' })
  })

  afterAll(() => {
    database.close()
  })

  it('reaproveita o CSV sem ciclo prévio, respeita o ciclo diferente do PDF e aceita segunda via', async () => {
    await expect(runCardStatementControlFixture()).resolves.toBeUndefined()
  })
})
