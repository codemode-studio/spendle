import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

describe('correções e identidade canônica', () => {
  const directory = mkdtempSync(join(tmpdir(), 'financas-import-correction-'))

  beforeAll(() => {
    process.env.DATABASE_URL = join(directory, 'integration.db')
    vi.resetModules()
  })

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('preserva lançamentos novos, promove identidade e recalcula a âncora', async () => {
    await expect(
      import('./import-correction.integration.fixture'),
    ).resolves.toBeDefined()
  })
})
