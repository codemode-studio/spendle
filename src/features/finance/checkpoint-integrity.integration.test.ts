import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

describe('integridade dos pontos de controle', () => {
  const directory = mkdtempSync(
    join(tmpdir(), 'financas-checkpoint-integrity-'),
  )

  beforeAll(() => {
    process.env.DATABASE_URL = join(directory, 'integration.db')
    vi.resetModules()
  })

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('preserva linearidade, origem e tipo de saldo em importações e ajustes manuais', async () => {
    await expect(
      import('./checkpoint-integrity.integration.fixture'),
    ).resolves.toBeDefined()
  })
})
