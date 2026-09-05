import { unlink, writeFile } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { eq } from 'drizzle-orm'

import { openTestDatabase } from '#/test/database'
import type { TestDatabase } from '#/test/database'
import { linkStatementObservation } from './import-resolution.server'
import {
  commitImport,
  confirmImportCoverage,
  retryImportFinalization,
} from './import.server'

describe('conflitos ao vivo em lotes e restaurações', () => {
  let database: TestDatabase

  beforeAll(async () => {
    database = await openTestDatabase()
  })

  afterAll(() => {
    database.close()
  })

  it('não usa o PDF conflitante como controle ao confirmar a cobertura do CSV', async () => {
    const { db, ids, schema } = database
    await db.insert(schema.creditCards).values({
      id: 'live-batch-coverage-card',
      ownershipScopeId: ids.personScope,
      institutionId: ids.institution,
      name: 'Cartão do lote com cobertura',
      currency: 'BRL',
      lastFour: '4242',
      closingDay: 5,
    })
    await db.insert(schema.importBatches).values({
      id: 'live-batch-coverage',
      creditCardId: 'live-batch-coverage-card',
      status: 'review',
    })
    await db.insert(schema.sourceFiles).values([
      {
        id: 'live-batch-coverage-csv-source',
        sha256: 'live-batch-coverage-csv-source',
        originalName: 'lote-cobertura.csv',
        mediaType: 'text/csv',
        sizeBytes: 10,
        storagePath: '/tmp/lote-cobertura.csv',
      },
      {
        id: 'live-batch-coverage-pdf-source',
        sha256: 'live-batch-coverage-pdf-source',
        originalName: 'lote-cobertura.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 10,
        storagePath: '/tmp/lote-cobertura.pdf',
      },
    ])
    await db.insert(schema.imports).values([
      {
        id: 'live-batch-coverage-csv',
        sourceFileId: 'live-batch-coverage-csv-source',
        batchId: 'live-batch-coverage',
        creditCardId: 'live-batch-coverage-card',
        parser: 'csv',
        documentKind: 'card_statement',
        sourceTransactionCount: 1,
        parsedTransactionCount: 1,
        activityStart: '2027-09-10',
        activityEnd: '2027-09-10',
        periodSource: 'activity',
        validationStatus: 'imported',
        validationReason: 'needs_balance',
        status: 'review',
      },
      {
        id: 'live-batch-coverage-pdf',
        sourceFileId: 'live-batch-coverage-pdf-source',
        batchId: 'live-batch-coverage',
        creditCardId: 'live-batch-coverage-card',
        parser: 'pdf_inspector',
        documentKind: 'card_statement',
        detectedLastFour: '4242',
        closingBalanceCents: 1_000,
        closingBalanceType: 'card_statement',
        balanceAsOf: '2027-09-30',
        sourceTransactionCount: 1,
        parsedTransactionCount: 1,
        activityStart: '2027-09-10',
        activityEnd: '2027-09-10',
        periodStart: '2027-09-01',
        periodEnd: '2027-09-30',
        periodSource: 'metadata',
        coverageConfidence: 'high',
        validationStatus: 'imported',
        validationReason: 'ready',
        status: 'review',
      },
    ])
    await db.insert(schema.stagedTransactions).values([
      {
        id: 'live-batch-coverage-csv-row',
        importId: 'live-batch-coverage-csv',
        externalId: 'live-batch-coverage-id',
        fingerprint: 'live-batch-coverage-csv-fingerprint',
        postedAt: '2027-09-10',
        description: 'Compra do CSV',
        normalizedDescription: 'compra do csv',
        amountCents: -1_000,
        currency: 'BRL',
        suggestedCategoryId: ids.categories.uncategorized,
      },
      {
        id: 'live-batch-coverage-pdf-row',
        importId: 'live-batch-coverage-pdf',
        fingerprint: 'live-batch-coverage-pdf-fingerprint',
        postedAt: '2027-09-10',
        description: 'Compra do PDF',
        normalizedDescription: 'compra do pdf',
        amountCents: -1_000,
        currency: 'BRL',
        suggestedCategoryId: ids.categories.uncategorized,
      },
    ])
    await db
      .update(schema.creditCards)
      .set({ lastFour: '9999' })
      .where(eq(schema.creditCards.id, 'live-batch-coverage-card'))

    await confirmImportCoverage({
      importId: 'live-batch-coverage-csv',
      periodStart: '2027-09-01',
      periodEnd: '2027-09-30',
    })

    const [csvImport, pdfImport] = await Promise.all([
      db
        .select()
        .from(schema.imports)
        .where(eq(schema.imports.id, 'live-batch-coverage-csv'))
        .limit(1),
      db
        .select()
        .from(schema.imports)
        .where(eq(schema.imports.id, 'live-batch-coverage-pdf'))
        .limit(1),
    ])
    expect(csvImport[0]).toMatchObject({
      closingBalanceCents: null,
      dependsOnImportId: null,
    })
    expect(pdfImport[0]).toMatchObject({
      validationStatus: 'divergent',
      validationReason: 'destination_conflict',
      dependsOnImportId: null,
    })
  })

  it('não vincula evidência de um membro cujo destino mudou', async () => {
    const { db, ids, schema } = database
    await db.insert(schema.creditCards).values({
      id: 'live-batch-evidence-card',
      ownershipScopeId: ids.personScope,
      institutionId: ids.institution,
      name: 'Cartão do lote com evidência',
      currency: 'BRL',
      lastFour: '5151',
      closingDay: 5,
    })
    await db.insert(schema.importBatches).values({
      id: 'live-batch-evidence',
      creditCardId: 'live-batch-evidence-card',
      status: 'committed',
    })
    await db.insert(schema.sourceFiles).values([
      {
        id: 'live-batch-evidence-csv-source',
        sha256: 'live-batch-evidence-csv-source',
        originalName: 'lote-evidencia.csv',
        mediaType: 'text/csv',
        sizeBytes: 10,
        storagePath: '/tmp/lote-evidencia.csv',
      },
      {
        id: 'live-batch-evidence-pdf-source',
        sha256: 'live-batch-evidence-pdf-source',
        originalName: 'lote-evidencia.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 10,
        storagePath: '/tmp/lote-evidencia.pdf',
      },
    ])
    await db.insert(schema.imports).values([
      {
        id: 'live-batch-evidence-csv',
        sourceFileId: 'live-batch-evidence-csv-source',
        batchId: 'live-batch-evidence',
        creditCardId: 'live-batch-evidence-card',
        parser: 'csv',
        documentKind: 'card_statement',
        periodStart: '2027-10-01',
        periodEnd: '2027-10-31',
        periodSource: 'user',
        coverageConfidence: 'high',
        validationStatus: 'imported',
        validationReason: 'ready',
        status: 'committed',
      },
      {
        id: 'live-batch-evidence-pdf',
        sourceFileId: 'live-batch-evidence-pdf-source',
        batchId: 'live-batch-evidence',
        creditCardId: 'live-batch-evidence-card',
        parser: 'pdf_inspector',
        documentKind: 'card_statement',
        detectedLastFour: '5151',
        periodStart: '2027-10-01',
        periodEnd: '2027-10-31',
        periodSource: 'metadata',
        coverageConfidence: 'high',
        validationStatus: 'reconciled',
        validationReason: 'ready',
        status: 'evidence',
      },
    ])
    await db.insert(schema.stagedTransactions).values({
      id: 'live-batch-evidence-pdf-row',
      importId: 'live-batch-evidence-pdf',
      fingerprint: 'live-batch-evidence-fingerprint',
      postedAt: '2027-10-10',
      description: 'Compra preservada como evidência',
      normalizedDescription: 'compra preservada como evidencia',
      amountCents: -2_000,
      currency: 'BRL',
      suggestedCategoryId: ids.categories.uncategorized,
    })
    await db.insert(schema.transactions).values({
      id: 'live-batch-evidence-transaction',
      importId: 'live-batch-evidence-csv',
      creditCardId: 'live-batch-evidence-card',
      categoryId: ids.categories.uncategorized,
      sourceKey: 'live-batch-evidence-transaction',
      fingerprint: 'live-batch-evidence-fingerprint',
      postedAt: '2027-10-10',
      description: 'Compra preservada como evidência',
      normalizedDescription: 'compra preservada como evidencia',
      amountCents: -2_000,
      currency: 'BRL',
      status: 'confirmed',
    })
    await db
      .update(schema.creditCards)
      .set({ lastFour: '0000' })
      .where(eq(schema.creditCards.id, 'live-batch-evidence-card'))

    await retryImportFinalization('live-batch-evidence-csv')

    const [evidence, pdfImport] = await Promise.all([
      db
        .select()
        .from(schema.transactionEvidence)
        .where(
          eq(
            schema.transactionEvidence.stagedTransactionId,
            'live-batch-evidence-pdf-row',
          ),
        ),
      db
        .select()
        .from(schema.imports)
        .where(eq(schema.imports.id, 'live-batch-evidence-pdf'))
        .limit(1),
    ])
    expect(evidence).toHaveLength(0)
    expect(pdfImport[0]).toMatchObject({
      validationStatus: 'divergent',
      validationReason: 'destination_conflict',
    })
  })

  it('recupera evidência mesmo quando o checkpoint do membro foi substituído', async () => {
    const { db, ids, schema } = database
    await db.insert(schema.creditCards).values({
      id: 'replaced-checkpoint-evidence-card',
      ownershipScopeId: ids.personScope,
      institutionId: ids.institution,
      name: 'Cartão com checkpoint substituído',
      currency: 'BRL',
      lastFour: '5252',
      closingDay: 5,
    })
    await db.insert(schema.importBatches).values({
      id: 'replaced-checkpoint-evidence-batch',
      creditCardId: 'replaced-checkpoint-evidence-card',
      status: 'committed',
    })
    await db.insert(schema.sourceFiles).values([
      {
        id: 'replaced-checkpoint-csv-source',
        sha256: 'replaced-checkpoint-csv-source',
        originalName: 'checkpoint-substituido.csv',
        mediaType: 'text/csv',
        sizeBytes: 10,
        storagePath: '/tmp/checkpoint-substituido.csv',
      },
      {
        id: 'replaced-checkpoint-pdf-source',
        sha256: 'replaced-checkpoint-pdf-source',
        originalName: 'checkpoint-substituido.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 10,
        storagePath: '/tmp/checkpoint-substituido.pdf',
      },
    ])
    await db.insert(schema.imports).values([
      {
        id: 'replaced-checkpoint-csv-import',
        sourceFileId: 'replaced-checkpoint-csv-source',
        batchId: 'replaced-checkpoint-evidence-batch',
        creditCardId: 'replaced-checkpoint-evidence-card',
        parser: 'csv',
        documentKind: 'card_statement',
        periodStart: '2027-11-01',
        periodEnd: '2027-11-30',
        periodSource: 'user',
        coverageConfidence: 'high',
        validationStatus: 'imported',
        validationReason: 'ready',
        status: 'committed',
      },
      {
        id: 'replaced-checkpoint-pdf-import',
        sourceFileId: 'replaced-checkpoint-pdf-source',
        batchId: 'replaced-checkpoint-evidence-batch',
        creditCardId: 'replaced-checkpoint-evidence-card',
        parser: 'pdf_inspector',
        documentKind: 'card_statement',
        detectedLastFour: '5252',
        closingBalanceCents: 2_000,
        closingBalanceType: 'card_statement',
        balanceAsOf: '2027-11-30',
        periodStart: '2027-11-01',
        periodEnd: '2027-11-30',
        periodSource: 'metadata',
        coverageConfidence: 'high',
        validationStatus: 'reconciled',
        validationReason: 'ready',
        status: 'evidence',
      },
    ])
    await db.insert(schema.stagedTransactions).values({
      id: 'replaced-checkpoint-pdf-row',
      importId: 'replaced-checkpoint-pdf-import',
      fingerprint: 'replaced-checkpoint-evidence-fingerprint',
      postedAt: '2027-11-10',
      description: 'Compra usada como evidência',
      normalizedDescription: 'compra usada como evidencia',
      amountCents: -2_000,
      currency: 'BRL',
      suggestedCategoryId: ids.categories.uncategorized,
    })
    await db.insert(schema.transactions).values({
      id: 'replaced-checkpoint-transaction',
      importId: 'replaced-checkpoint-csv-import',
      creditCardId: 'replaced-checkpoint-evidence-card',
      categoryId: ids.categories.uncategorized,
      sourceKey: 'replaced-checkpoint-transaction',
      fingerprint: 'replaced-checkpoint-evidence-fingerprint',
      postedAt: '2027-11-10',
      description: 'Compra usada como evidência',
      normalizedDescription: 'compra usada como evidencia',
      amountCents: -2_000,
      currency: 'BRL',
      status: 'confirmed',
    })
    await db.insert(schema.balanceCheckpoints).values({
      id: 'replacement-checkpoint',
      creditCardId: 'replaced-checkpoint-evidence-card',
      kind: 'statement_closing',
      balanceType: 'card_statement',
      source: 'manual',
      reviewState: 'verified',
      balanceCents: 3_000,
      asOf: '2027-11-30',
    })

    const result = await retryImportFinalization(
      'replaced-checkpoint-csv-import',
    )
    const evidence = await db
      .select()
      .from(schema.transactionEvidence)
      .where(
        eq(
          schema.transactionEvidence.stagedTransactionId,
          'replaced-checkpoint-pdf-row',
        ),
      )

    expect(result.batchEvidence).toEqual({ status: 'completed' })
    expect(evidence).toHaveLength(1)
    expect(evidence[0]).toMatchObject({
      transactionId: 'replaced-checkpoint-transaction',
      stagedTransactionId: 'replaced-checkpoint-pdf-row',
    })
  })

  it('recusa o commit do CSV quando o PDF dependente conflita com o destino atual', async () => {
    const { db, ids, schema } = database
    const csvPath = `${database.directory}/live-batch-commit.csv`
    await writeFile(
      csvPath,
      [
        'date,description,amount',
        '2027-10-10,Compra sem identidade,10.00',
      ].join('\n'),
    )
    try {
      await db.insert(schema.creditCards).values({
        id: 'live-batch-commit-card',
        ownershipScopeId: ids.personScope,
        institutionId: ids.institution,
        name: 'Cartão do commit com dependência',
        currency: 'BRL',
        lastFour: '6161',
        closingDay: 5,
      })
      await db.insert(schema.importBatches).values({
        id: 'live-batch-commit',
        creditCardId: 'live-batch-commit-card',
        status: 'review',
      })
      await db.insert(schema.sourceFiles).values([
        {
          id: 'live-batch-commit-csv-source',
          sha256: 'live-batch-commit-csv-source',
          originalName: 'lote-commit.csv',
          mediaType: 'text/csv',
          sizeBytes: 57,
          storagePath: csvPath,
        },
        {
          id: 'live-batch-commit-pdf-source',
          sha256: 'live-batch-commit-pdf-source',
          originalName: 'lote-commit.pdf',
          mediaType: 'application/pdf',
          sizeBytes: 10,
          storagePath: '/tmp/lote-commit.pdf',
        },
      ])
      await db.insert(schema.imports).values([
        {
          id: 'live-batch-commit-csv',
          sourceFileId: 'live-batch-commit-csv-source',
          batchId: 'live-batch-commit',
          creditCardId: 'live-batch-commit-card',
          parser: 'csv',
          documentKind: 'card_statement',
          sourceTransactionCount: 1,
          parsedTransactionCount: 1,
          activityStart: '2027-10-10',
          activityEnd: '2027-10-10',
          periodStart: '2027-10-01',
          periodEnd: '2027-10-31',
          periodSource: 'user',
          coverageConfidence: 'high',
          closingBalanceCents: 1_000,
          closingBalanceType: 'card_statement',
          balanceAsOf: '2027-10-31',
          validationStatus: 'reconciled',
          validationReason: 'ready',
          status: 'review',
        },
        {
          id: 'live-batch-commit-pdf',
          sourceFileId: 'live-batch-commit-pdf-source',
          batchId: 'live-batch-commit',
          creditCardId: 'live-batch-commit-card',
          dependsOnImportId: 'live-batch-commit-csv',
          parser: 'pdf_inspector',
          documentKind: 'card_statement',
          detectedLastFour: '6161',
          sourceTransactionCount: 1,
          parsedTransactionCount: 1,
          activityStart: '2027-10-10',
          activityEnd: '2027-10-10',
          periodStart: '2027-10-01',
          periodEnd: '2027-10-31',
          periodSource: 'metadata',
          coverageConfidence: 'high',
          closingBalanceCents: 1_000,
          closingBalanceType: 'card_statement',
          balanceAsOf: '2027-10-31',
          validationStatus: 'reconciled',
          validationReason: 'ready',
          status: 'review',
        },
      ])
      await db.insert(schema.stagedTransactions).values([
        {
          id: 'live-batch-commit-csv-row',
          importId: 'live-batch-commit-csv',
          fingerprint: 'live-batch-commit-csv-fingerprint',
          postedAt: '2027-10-10',
          description: 'Compra sem identidade',
          normalizedDescription: 'compra sem identidade',
          amountCents: -1_000,
          currency: 'BRL',
          suggestedCategoryId: ids.categories.uncategorized,
        },
        {
          id: 'live-batch-commit-pdf-row',
          importId: 'live-batch-commit-pdf',
          fingerprint: 'live-batch-commit-pdf-fingerprint',
          postedAt: '2027-10-10',
          description: 'Compra sem identidade',
          normalizedDescription: 'compra sem identidade',
          amountCents: -1_000,
          currency: 'BRL',
          suggestedCategoryId: ids.categories.uncategorized,
        },
      ])
      await db
        .update(schema.creditCards)
        .set({ lastFour: '0000' })
        .where(eq(schema.creditCards.id, 'live-batch-commit-card'))

      await expect(commitImport('live-batch-commit-csv')).rejects.toThrow(
        'Esta importação está bloqueada por uma validação obrigatória.',
      )

      const [pdfImport, checkpoints] = await Promise.all([
        db
          .select()
          .from(schema.imports)
          .where(eq(schema.imports.id, 'live-batch-commit-pdf'))
          .limit(1),
        db
          .select()
          .from(schema.balanceCheckpoints)
          .where(
            eq(
              schema.balanceCheckpoints.creditCardId,
              'live-batch-commit-card',
            ),
          ),
      ])
      expect(pdfImport[0]).toMatchObject({
        validationStatus: 'divergent',
        validationReason: 'destination_conflict',
      })
      expect(checkpoints).toHaveLength(0)
    } finally {
      await unlink(csvPath).catch(() => undefined)
    }
  })

  it('reavalia o import dono da exclusão após consolidar o import restaurador', async () => {
    const { db, ids, schema } = database
    await db.insert(schema.creditCards).values({
      id: 'manual-restoration-card',
      ownershipScopeId: ids.personScope,
      institutionId: ids.institution,
      name: 'Cartão com restauração manual',
      currency: 'BRL',
      lastFour: '7373',
      closingDay: 5,
    })
    await db.insert(schema.sourceFiles).values([
      {
        id: 'manual-restoration-owner-source',
        sha256: 'manual-restoration-owner-source',
        originalName: 'fatura-dona-da-exclusao.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 10,
        storagePath: '/tmp/fatura-dona-da-exclusao.pdf',
      },
      {
        id: 'manual-restoration-current-source',
        sha256: 'manual-restoration-current-source',
        originalName: 'fatura-que-restaura.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 10,
        storagePath: '/tmp/fatura-que-restaura.pdf',
      },
    ])
    await db.insert(schema.imports).values([
      {
        id: 'manual-restoration-owner-import',
        sourceFileId: 'manual-restoration-owner-source',
        creditCardId: 'manual-restoration-card',
        parser: 'pdf_inspector',
        documentKind: 'card_statement',
        periodStart: '2027-11-01',
        periodEnd: '2027-11-30',
        periodSource: 'metadata',
        coverageConfidence: 'high',
        validationStatus: 'reconciled',
        validationReason: 'ready',
        status: 'committed',
      },
      {
        id: 'manual-restoration-current-import',
        sourceFileId: 'manual-restoration-current-source',
        creditCardId: 'manual-restoration-card',
        parser: 'pdf_inspector',
        documentKind: 'card_statement',
        sourceTransactionCount: 1,
        parsedTransactionCount: 1,
        periodStart: '2027-11-01',
        periodEnd: '2027-11-30',
        closingBalanceCents: 3_100,
        closingBalanceType: 'card_statement',
        balanceAsOf: '2027-11-30',
        periodSource: 'metadata',
        coverageConfidence: 'high',
        validationStatus: 'divergent',
        validationReason: 'statement_match_candidates',
        status: 'review',
      },
    ])
    await db.insert(schema.transactions).values({
      id: 'manual-restoration-transaction',
      importId: 'manual-restoration-owner-import',
      creditCardId: 'manual-restoration-card',
      categoryId: ids.categories.uncategorized,
      externalId: 'manual-restoration-id',
      sourceKey: 'manual-restoration-transaction',
      fingerprint: 'manual-restoration-old-fingerprint',
      postedAt: '2027-11-10',
      description: 'Autorização excluída',
      normalizedDescription: 'autorizacao excluida',
      amountCents: -3_000,
      currency: 'BRL',
      status: 'excluded',
    })
    await db.insert(schema.stagedTransactions).values({
      id: 'manual-restoration-observation',
      importId: 'manual-restoration-current-import',
      externalId: 'manual-restoration-id',
      fingerprint: 'manual-restoration-new-fingerprint',
      postedAt: '2027-11-11',
      description: 'Autorização corrigida',
      normalizedDescription: 'autorizacao corrigida',
      amountCents: -3_100,
      currency: 'BRL',
      suggestedCategoryId: ids.categories.uncategorized,
    })
    await db.insert(schema.statementExclusions).values({
      id: 'manual-restoration-exclusion',
      importId: 'manual-restoration-owner-import',
      transactionId: 'manual-restoration-transaction',
      previousStatus: 'pending',
      reason: 'A autorização não constava na primeira fatura.',
    })
    await db.insert(schema.balanceCheckpoints).values({
      id: 'manual-restoration-owner-checkpoint',
      importId: 'manual-restoration-owner-import',
      creditCardId: 'manual-restoration-card',
      kind: 'statement_closing',
      balanceType: 'card_statement',
      source: 'pdf',
      reviewState: 'verified',
      balanceCents: 3_000,
      asOf: '2027-11-30',
    })

    await linkStatementObservation({
      stagedTransactionId: 'manual-restoration-observation',
      transactionId: 'manual-restoration-transaction',
    })

    const reopenedOwnerImport = await db
      .select()
      .from(schema.imports)
      .where(eq(schema.imports.id, 'manual-restoration-owner-import'))
      .limit(1)
    expect(reopenedOwnerImport[0]).toMatchObject({
      status: 'committed',
      validationStatus: 'divergent',
      validationReason: 'pending_correction',
    })

    await expect(
      commitImport('manual-restoration-current-import'),
    ).resolves.toMatchObject({ reused: false })

    const [ownerImport, checkpoint] = await Promise.all([
      db
        .select()
        .from(schema.imports)
        .where(eq(schema.imports.id, 'manual-restoration-owner-import'))
        .limit(1),
      db
        .select()
        .from(schema.balanceCheckpoints)
        .where(
          eq(
            schema.balanceCheckpoints.id,
            'manual-restoration-owner-checkpoint',
          ),
        )
        .limit(1),
    ])
    expect(ownerImport[0]).toMatchObject({
      status: 'committed',
      validationStatus: 'reconciled',
      validationReason: 'ready',
    })
    expect(checkpoint[0]?.reviewState).toBe('invalidated')
  })
})
