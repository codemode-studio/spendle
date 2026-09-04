import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { openTestDatabase } from '#/test/database'
import type { TestDatabase } from '#/test/database'
import { repairImportProvenance } from './import-provenance-repair.server'

describe('reparo de proveniência', () => {
  let database: TestDatabase

  beforeAll(async () => {
    database = await openTestDatabase()
  })

  afterAll(() => {
    database.close()
  })

  it('é idempotente e preserva cobertura OFX quando o arquivo não está disponível', async () => {
    const { db, schema } = database
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
      storagePath: join(tmpdir(), `${randomUUID()}.ofx`),
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
