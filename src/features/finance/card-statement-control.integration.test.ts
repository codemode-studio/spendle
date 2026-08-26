import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

describe('fechamento posterior de fatura', () => {
  const directory = mkdtempSync(join(tmpdir(), 'financas-card-control-'))

  beforeAll(() => {
    process.env.DATABASE_URL = join(directory, 'integration.db')
    vi.resetModules()
  })

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('reaproveita o CSV sem ciclo prévio, respeita o ciclo diferente do PDF e aceita segunda via', async () => {
    await expect(
      import('./card-statement-control.integration.fixture'),
    ).resolves.toBeDefined()
  })
})
