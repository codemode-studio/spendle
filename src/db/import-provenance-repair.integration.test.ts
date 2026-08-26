import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

describe('reparo de proveniência', () => {
  const directory = mkdtempSync(join(tmpdir(), 'financas-provenance-repair-'))

  beforeAll(() => {
    process.env.DATABASE_URL = join(directory, 'integration.db')
    vi.resetModules()
  })

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('é idempotente e preserva cobertura OFX quando o arquivo não está disponível', async () => {
    const [{ db, ensureDatabase }, schema, { repairImportProvenance }] =
      await Promise.all([
        import('./index.server'),
        import('./schema'),
        import('./import-provenance-repair.server'),
      ])
    await ensureDatabase()
    const scope = (await db.select().from(schema.ownershipScopes).limit(1))[0]

    await db.insert(schema.accounts).values({
      id: 'repair-account',
      ownershipScopeId: scope.id,
      name: 'Conta do reparo',
    })
    await db.insert(schema.sourceFiles).values({
      id: 'repair-source',
      sha256: 'repair-source',
      originalName: 'repair.ofx',
      mediaType: 'application/x-ofx',
      sizeBytes: 10,
      storagePath: join(directory, 'arquivo-removido.ofx'),
    })
    await db.insert(schema.imports).values({
      id: 'repair-import',
      sourceFileId: 'repair-source',
      accountId: 'repair-account',
      parser: 'ofx',
      documentKind: 'bank_statement',
      parsedTransactionCount: 0,
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      periodSource: 'metadata',
      coverageConfidence: 'high',
      validationStatus: 'imported',
      status: 'committed',
    })
    await db.insert(schema.coverageIntervals).values({
      id: 'repair-coverage',
      importId: 'repair-import',
      accountId: 'repair-account',
      start: '2026-08-01',
      end: '2026-08-31',
      source: 'metadata',
      confidence: 'high',
    })

    await repairImportProvenance(db)
    await repairImportProvenance(db)

    const [importRows, coverageRows] = await Promise.all([
      db
        .select()
        .from(schema.imports)
        .where(eq(schema.imports.id, 'repair-import')),
      db
        .select()
        .from(schema.coverageIntervals)
        .where(eq(schema.coverageIntervals.importId, 'repair-import')),
    ])
    expect(importRows[0]).toMatchObject({
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      periodSource: 'metadata',
      coverageConfidence: 'high',
    })
    expect(coverageRows).toHaveLength(1)
  })
})
