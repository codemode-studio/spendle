import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

import { eq, inArray } from 'drizzle-orm'

import { db, ensureDatabase } from '#/db/index.server'
import * as schema from '#/db/schema'
import { identifyDuplicateReasons } from '#/domain/import-audit'
import {
  linkStatementObservation,
  resolveStatementExclusion,
} from './finance.server'
import {
  commitImport,
  reconcileCsvWithPdfControl,
  rejectImport,
} from './import.server'

export async function runCardStatementControlFixture() {
  await ensureDatabase()

  const scope = (await db.select().from(schema.ownershipScopes).limit(1))[0]
  assert(scope)

  await db.insert(schema.creditCards).values({
    id: 'card-integration',
    ownershipScopeId: scope.id,
    name: 'Cartão de teste',
    lastFour: '1234',
    closingDay: 31,
  })
  await db.insert(schema.sourceFiles).values([
    {
      id: 'source-open-csv',
      sha256: 'open-csv-sha',
      originalName: 'fatura-aberta.csv',
      mediaType: 'text/csv',
      sizeBytes: 10,
      storagePath: '/tmp/fatura-aberta.csv',
    },
    {
      id: 'source-final-pdf',
      sha256: 'final-pdf-sha',
      originalName: 'fatura-definitiva.pdf',
      mediaType: 'application/pdf',
      sizeBytes: 10,
      storagePath: '/tmp/fatura-definitiva.pdf',
    },
    {
      id: 'source-repeat-pdf',
      sha256: 'repeat-pdf-different-sha',
      originalName: 'fatura-definitiva-segunda-via.pdf',
      mediaType: 'application/pdf',
      sizeBytes: 11,
      storagePath: '/tmp/fatura-definitiva-segunda-via.pdf',
    },
  ])
  await db.insert(schema.importBatches).values([
    {
      id: 'batch-open-csv',
      creditCardId: 'card-integration',
      status: 'committed',
    },
    {
      id: 'batch-final-pdf',
      creditCardId: 'card-integration',
      status: 'review',
    },
    {
      id: 'batch-repeat-pdf',
      creditCardId: 'card-integration',
      status: 'review',
    },
  ])
  await db.insert(schema.imports).values([
    {
      id: 'import-open-csv',
      sourceFileId: 'source-open-csv',
      batchId: 'batch-open-csv',
      creditCardId: 'card-integration',
      parser: 'csv',
      documentKind: 'card_statement',
      parsedTransactionCount: 3,
      activityStart: '2026-08-03',
      activityEnd: '2026-08-03',
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      periodSource: 'user',
      coverageConfidence: 'high',
      totalDebitsCents: 12_345,
      netMovementCents: -12_345,
      validationStatus: 'imported',
      status: 'committed',
    },
    {
      id: 'import-final-pdf',
      sourceFileId: 'source-final-pdf',
      batchId: 'batch-final-pdf',
      creditCardId: 'card-integration',
      parser: 'pdf_inspector',
      documentKind: 'card_statement',
      closingBalanceCents: 17_345,
      balanceAsOf: '2026-09-02',
      parsedTransactionCount: 2,
      activityStart: '2026-08-03',
      activityEnd: '2026-08-25',
      periodStart: '2026-08-03',
      periodEnd: '2026-09-02',
      periodSource: 'metadata',
      coverageConfidence: 'high',
      totalDebitsCents: 17_345,
      netMovementCents: -17_345,
      validationStatus: 'imported',
      status: 'review',
    },
  ])
  await db.insert(schema.stagedTransactions).values([
    {
      id: 'staged-open-csv',
      importId: 'import-open-csv',
      fingerprint: 'csv-description-fingerprint',
      postedAt: '2026-08-03',
      description: 'COMPRA CARTAO 03/08',
      normalizedDescription: 'COMPRA CARTAO 03 08',
      amountCents: -12_345,
      currency: 'BRL',
      suggestedCategoryId: 'uncategorized',
    },
    {
      id: 'staged-final-pdf',
      importId: 'import-final-pdf',
      fingerprint: 'pdf-description-fingerprint',
      postedAt: '2026-08-03',
      description: 'Mercado Exemplo',
      normalizedDescription: 'MERCADO EXEMPLO',
      amountCents: -12_345,
      currency: 'BRL',
      suggestedCategoryId: 'uncategorized',
    },
    {
      id: 'staged-final-pdf-new-purchase',
      importId: 'import-final-pdf',
      fingerprint: 'pdf-new-purchase-fingerprint',
      postedAt: '2026-08-25',
      description: 'Compra após o último CSV',
      normalizedDescription: 'COMPRA APOS O ULTIMO CSV',
      amountCents: -5_000,
      currency: 'BRL',
      suggestedCategoryId: 'uncategorized',
    },
  ])
  await db.insert(schema.transactions).values({
    id: 'canonical-open-csv',
    importId: 'import-open-csv',
    creditCardId: 'card-integration',
    categoryId: 'uncategorized',
    sourceKey: 'card:integration:csv:1',
    fingerprint: 'csv-description-fingerprint',
    postedAt: '2026-08-03',
    description: 'COMPRA CARTAO 03/08',
    normalizedDescription: 'COMPRA CARTAO 03 08',
    amountCents: -12_345,
    currency: 'BRL',
    baseAmountCents: -12_345,
    exchangeRateMicros: 1_000_000,
    status: 'pending',
  })
  await db.insert(schema.transactionEvidence).values({
    id: 'evidence-open-csv',
    stagedTransactionId: 'staged-open-csv',
    transactionId: 'canonical-open-csv',
    matchKind: 'created',
  })

  await reconcileCsvWithPdfControl({
    importIds: ['import-final-pdf'],
    targetType: 'card',
    targetId: 'card-integration',
  })

  const [transactionsAfterClosing, evidenceAfterClosing] = await Promise.all([
    db.select().from(schema.transactions),
    db.select().from(schema.transactionEvidence),
  ])
  assert.equal(transactionsAfterClosing.length, 1)
  assert.ok(
    transactionsAfterClosing.every(
      (transaction) => transaction.status === 'pending',
    ),
  )
  assert.equal(evidenceAfterClosing.length, 1)

  const commitResult = await commitImport('import-final-pdf')
  assert.equal(commitResult.committed, 1)

  const [transactionsAfterReview, evidenceAfterReview] = await Promise.all([
    db.select().from(schema.transactions),
    db.select().from(schema.transactionEvidence),
  ])
  assert.equal(transactionsAfterReview.length, 2)
  assert.ok(
    transactionsAfterReview.every(
      (transaction) => transaction.status === 'confirmed',
    ),
  )
  assert.equal(evidenceAfterReview.length, 3)

  await db.insert(schema.imports).values({
    id: 'import-repeat-pdf',
    sourceFileId: 'source-repeat-pdf',
    batchId: 'batch-repeat-pdf',
    creditCardId: 'card-integration',
    parser: 'pdf_inspector',
    documentKind: 'card_statement',
    closingBalanceCents: 17_345,
    balanceAsOf: '2026-09-02',
    parsedTransactionCount: 2,
    activityStart: '2026-08-03',
    activityEnd: '2026-08-25',
    periodStart: '2026-08-03',
    periodEnd: '2026-09-02',
    periodSource: 'metadata',
    coverageConfidence: 'high',
    totalDebitsCents: 17_345,
    netMovementCents: -17_345,
    validationStatus: 'imported',
    status: 'review',
  })
  await db.insert(schema.stagedTransactions).values([
    {
      id: 'staged-repeat-pdf',
      importId: 'import-repeat-pdf',
      fingerprint: 'repeat-pdf-description-fingerprint',
      postedAt: '2026-08-03',
      description: 'Mercado Exemplo — segunda via',
      normalizedDescription: 'MERCADO EXEMPLO SEGUNDA VIA',
      amountCents: -12_345,
      currency: 'BRL',
      suggestedCategoryId: 'uncategorized',
    },
    {
      id: 'staged-repeat-pdf-new-purchase',
      importId: 'import-repeat-pdf',
      fingerprint: 'repeat-pdf-new-purchase-fingerprint',
      postedAt: '2026-08-25',
      description: 'Compra posterior — segunda via',
      normalizedDescription: 'COMPRA POSTERIOR SEGUNDA VIA',
      amountCents: -5_000,
      currency: 'BRL',
      suggestedCategoryId: 'uncategorized',
    },
  ])
  await reconcileCsvWithPdfControl({
    importIds: ['import-repeat-pdf'],
    targetType: 'card',
    targetId: 'card-integration',
  })
  await commitImport('import-repeat-pdf')

  const [
    transactions,
    evidence,
    finalImport,
    repeatImport,
    cycles,
    checkpoints,
    openCsvImport,
    finalBatch,
  ] = await Promise.all([
    db.select().from(schema.transactions),
    db.select().from(schema.transactionEvidence),
    db
      .select()
      .from(schema.imports)
      .where(eq(schema.imports.id, 'import-final-pdf')),
    db
      .select()
      .from(schema.imports)
      .where(eq(schema.imports.id, 'import-repeat-pdf')),
    db.select().from(schema.cardStatementCycles),
    db.select().from(schema.balanceCheckpoints),
    db
      .select()
      .from(schema.imports)
      .where(eq(schema.imports.id, 'import-open-csv')),
    db
      .select()
      .from(schema.importBatches)
      .where(eq(schema.importBatches.id, 'batch-final-pdf')),
  ])

  assert.equal(transactions.length, 2)
  assert.ok(
    transactions.every((transaction) => transaction.status === 'confirmed'),
  )
  assert.equal(evidence.length, 5)
  assert.equal(
    evidence.find((item) => item.stagedTransactionId === 'staged-final-pdf')
      ?.matchKind,
    'statement_control',
  )
  assert.equal(finalImport[0].status, 'committed')
  assert.equal(finalImport[0].validationStatus, 'reconciled')
  assert.equal(repeatImport[0].status, 'evidence')
  assert.equal(
    evidence.find((item) => item.stagedTransactionId === 'staged-repeat-pdf')
      ?.matchKind,
    'statement_control',
  )
  assert.equal(cycles.length, 1)
  assert.equal(cycles[0].periodStart, '2026-08-03')
  assert.equal(cycles[0].periodEnd, '2026-09-02')
  assert.equal(cycles[0].status, 'reconciled')
  assert.equal(checkpoints.length, 1)
  assert.equal(openCsvImport[0].periodStart, '2026-08-01')
  assert.equal(openCsvImport[0].periodEnd, '2026-08-31')
  assert.equal(finalBatch[0].status, 'committed')

  await db.insert(schema.creditCards).values({
    id: 'card-same-batch-partial',
    ownershipScopeId: scope.id,
    name: 'Cartão com CSV parcial no mesmo lote',
    lastFour: '2468',
    closingDay: 31,
  })
  await db.insert(schema.importBatches).values({
    id: 'batch-same-batch-partial',
    creditCardId: 'card-same-batch-partial',
    status: 'review',
  })
  await db.insert(schema.imports).values([
    {
      id: 'import-same-batch-csv',
      sourceFileId: 'source-open-csv',
      batchId: 'batch-same-batch-partial',
      creditCardId: 'card-same-batch-partial',
      parser: 'csv',
      documentKind: 'card_statement',
      sourceTransactionCount: 1,
      parsedTransactionCount: 1,
      activityStart: '2026-08-03',
      activityEnd: '2026-08-03',
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      periodSource: 'user',
      coverageConfidence: 'high',
      totalDebitsCents: 10_000,
      netMovementCents: -10_000,
      validationStatus: 'imported',
      status: 'review',
    },
    {
      id: 'import-same-batch-pdf',
      sourceFileId: 'source-final-pdf',
      batchId: 'batch-same-batch-partial',
      creditCardId: 'card-same-batch-partial',
      parser: 'pdf_inspector',
      documentKind: 'card_statement',
      closingBalanceCents: 15_000,
      balanceAsOf: '2026-08-31',
      parsedTransactionCount: 2,
      activityStart: '2026-08-03',
      activityEnd: '2026-08-20',
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      periodSource: 'metadata',
      coverageConfidence: 'high',
      totalDebitsCents: 15_000,
      netMovementCents: -15_000,
      validationStatus: 'imported',
      status: 'review',
    },
  ])
  await db.insert(schema.stagedTransactions).values([
    {
      id: 'staged-same-batch-csv-a',
      importId: 'import-same-batch-csv',
      externalId: 'SAME-BATCH-E1',
      fingerprint: 'same-batch-csv-fingerprint-a',
      postedAt: '2026-08-03',
      description: 'COMPRA 03/08',
      normalizedDescription: 'COMPRA 03 08',
      amountCents: -10_000,
      currency: 'BRL',
      suggestedCategoryId: 'uncategorized',
    },
    {
      id: 'staged-same-batch-pdf-a',
      importId: 'import-same-batch-pdf',
      fingerprint: 'same-batch-pdf-fingerprint-a',
      postedAt: '2026-08-03',
      description: 'Mercado',
      normalizedDescription: 'MERCADO',
      amountCents: -10_000,
      currency: 'BRL',
      suggestedCategoryId: 'uncategorized',
    },
    {
      id: 'staged-same-batch-pdf-b',
      importId: 'import-same-batch-pdf',
      fingerprint: 'same-batch-pdf-fingerprint-b',
      postedAt: '2026-08-20',
      description: 'Compra posterior',
      normalizedDescription: 'COMPRA POSTERIOR',
      amountCents: -5_000,
      currency: 'BRL',
      suggestedCategoryId: 'uncategorized',
    },
  ])
  await reconcileCsvWithPdfControl({
    importIds: ['import-same-batch-csv', 'import-same-batch-pdf'],
    targetType: 'card',
    targetId: 'card-same-batch-partial',
  })
  const controlledPartialCsv = await db
    .select()
    .from(schema.imports)
    .where(eq(schema.imports.id, 'import-same-batch-csv'))
  assert.equal(controlledPartialCsv[0].status, 'review')
  assert.equal(
    controlledPartialCsv[0].dependsOnImportId,
    'import-same-batch-pdf',
  )
  await commitImport('import-same-batch-pdf')

  const [sameBatchTransactions, sameBatchEvidence, sameBatchImports] =
    await Promise.all([
      db
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.creditCardId, 'card-same-batch-partial')),
      db
        .select({ evidence: schema.transactionEvidence })
        .from(schema.transactionEvidence)
        .innerJoin(
          schema.stagedTransactions,
          eq(
            schema.stagedTransactions.id,
            schema.transactionEvidence.stagedTransactionId,
          ),
        )
        .where(eq(schema.stagedTransactions.importId, 'import-same-batch-csv')),
      db
        .select()
        .from(schema.imports)
        .where(eq(schema.imports.batchId, 'batch-same-batch-partial')),
    ])
  assert.equal(sameBatchTransactions.length, 2)
  assert.equal(sameBatchEvidence.length, 1)
  assert.equal(sameBatchEvidence[0].evidence.matchKind, 'statement_control')
  assert.equal(
    sameBatchTransactions.find(
      (transaction) => transaction.postedAt === '2026-08-03',
    )?.externalId,
    'SAME-BATCH-E1',
  )
  assert.ok(
    sameBatchImports.every(
      (item) => item.status === 'committed' || item.status === 'evidence',
    ),
  )
  const sameBatchStaged = await db
    .select({
      stagedId: schema.stagedTransactions.id,
      evidenceId: schema.transactionEvidence.id,
    })
    .from(schema.stagedTransactions)
    .leftJoin(
      schema.transactionEvidence,
      eq(
        schema.transactionEvidence.stagedTransactionId,
        schema.stagedTransactions.id,
      ),
    )
    .where(
      inArray(schema.stagedTransactions.importId, [
        'import-same-batch-csv',
        'import-same-batch-pdf',
      ]),
    )

  assert.equal(sameBatchStaged.length, 3)
  assert.ok(sameBatchStaged.every((row) => row.evidenceId))

  await db.insert(schema.importBatches).values({
    id: 'batch-reimport-same-batch-e1',
    creditCardId: 'card-same-batch-partial',
    status: 'review',
  })
  await db.insert(schema.imports).values({
    id: 'import-reimport-same-batch-e1',
    sourceFileId: 'source-open-csv',
    batchId: 'batch-reimport-same-batch-e1',
    creditCardId: 'card-same-batch-partial',
    parser: 'pdf_local',
    documentKind: 'card_statement',
    sourceTransactionCount: 1,
    parsedTransactionCount: 1,
    activityStart: '2026-08-03',
    activityEnd: '2026-08-03',
    periodStart: '2026-08-01',
    periodEnd: '2026-08-31',
    periodSource: 'user',
    coverageConfidence: 'high',
    totalDebitsCents: 10_000,
    netMovementCents: -10_000,
    validationStatus: 'warning',
    status: 'review',
  })
  await db.insert(schema.stagedTransactions).values({
    id: 'staged-reimport-same-batch-e1',
    importId: 'import-reimport-same-batch-e1',
    externalId: 'SAME-BATCH-E1',
    fingerprint: 'same-batch-csv-fingerprint-a',
    postedAt: '2026-08-03',
    description: 'COMPRA 03/08',
    normalizedDescription: 'COMPRA 03 08',
    amountCents: -10_000,
    currency: 'BRL',
    suggestedCategoryId: 'uncategorized',
  })
  const sameBatchReimport = await commitImport(
    'import-reimport-same-batch-e1',
    true,
  )
  assert.equal(sameBatchReimport.committed, 0)
  const sameBatchTransactionsAfterReimport = await db
    .select()
    .from(schema.transactions)
    .where(eq(schema.transactions.creditCardId, 'card-same-batch-partial'))
  assert.equal(sameBatchTransactionsAfterReimport.length, 2)
  const sameBatchReimportEvidence = await db
    .select()
    .from(schema.transactionEvidence)
    .where(
      eq(
        schema.transactionEvidence.stagedTransactionId,
        'staged-reimport-same-batch-e1',
      ),
    )
  assert.equal(sameBatchReimportEvidence[0].matchKind, 'external_id')

  await db.insert(schema.sourceFiles).values({
    id: 'source-pdf-first-csv',
    sha256: 'pdf-first-csv-sha',
    originalName: 'card-cycle-overlap.csv',
    mediaType: 'text/csv',
    sizeBytes: 100,
    storagePath: fileURLToPath(
      new URL('./fixtures/card-cycle-overlap.csv', import.meta.url),
    ),
  })
  await db.insert(schema.creditCards).values({
    id: 'card-pdf-first',
    ownershipScopeId: scope.id,
    name: 'Cartão com PDF importado primeiro',
    lastFour: '1357',
    closingDay: 31,
  })
  await db.insert(schema.importBatches).values({
    id: 'batch-pdf-first',
    creditCardId: 'card-pdf-first',
    status: 'review',
  })
  await db.insert(schema.imports).values({
    id: 'import-pdf-first',
    sourceFileId: 'source-final-pdf',
    batchId: 'batch-pdf-first',
    creditCardId: 'card-pdf-first',
    parser: 'pdf_inspector',
    documentKind: 'card_statement',
    closingBalanceCents: 10_000,
    balanceAsOf: '2026-08-31',
    parsedTransactionCount: 1,
    activityStart: '2026-08-03',
    activityEnd: '2026-08-03',
    periodStart: '2026-08-01',
    periodEnd: '2026-08-31',
    periodSource: 'metadata',
    coverageConfidence: 'high',
    totalDebitsCents: 10_000,
    netMovementCents: -10_000,
    validationStatus: 'reconciled',
    status: 'review',
  })
  await db.insert(schema.stagedTransactions).values({
    id: 'staged-pdf-first',
    importId: 'import-pdf-first',
    fingerprint: 'pdf-first-pdf-fingerprint',
    postedAt: '2026-08-03',
    description: 'Descrição canônica do PDF',
    normalizedDescription: 'DESCRICAO CANONICA DO PDF',
    amountCents: -10_000,
    currency: 'BRL',
    suggestedCategoryId: 'uncategorized',
  })
  await commitImport('import-pdf-first')

  await db.insert(schema.importBatches).values({
    id: 'batch-csv-after-pdf',
    creditCardId: 'card-pdf-first',
    status: 'review',
  })
  await db.insert(schema.imports).values({
    id: 'import-csv-after-pdf',
    sourceFileId: 'source-pdf-first-csv',
    batchId: 'batch-csv-after-pdf',
    creditCardId: 'card-pdf-first',
    parser: 'csv',
    documentKind: 'card_statement',
    sourceTransactionCount: 1,
    parsedTransactionCount: 1,
    activityStart: '2026-08-03',
    activityEnd: '2026-08-03',
    periodStart: '2026-08-01',
    periodEnd: '2026-08-31',
    periodSource: 'user',
    coverageConfidence: 'high',
    totalDebitsCents: 10_000,
    netMovementCents: -10_000,
    validationStatus: 'warning',
    status: 'review',
  })
  await db.insert(schema.stagedTransactions).values({
    id: 'staged-csv-after-pdf',
    importId: 'import-csv-after-pdf',
    externalId: 'PDF-FIRST-E1',
    fingerprint: 'pdf-first-csv-fingerprint',
    postedAt: '2026-08-03',
    description: 'Descrição diferente no CSV',
    normalizedDescription: 'DESCRICAO DIFERENTE NO CSV',
    amountCents: -10_000,
    currency: 'BRL',
    suggestedCategoryId: 'uncategorized',
  })
  const csvAfterPdfCommit = await commitImport('import-csv-after-pdf', true)
  assert.equal(csvAfterPdfCommit.committed, 0)
  const [pdfFirstTransactions, pdfFirstEvidence] = await Promise.all([
    db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.creditCardId, 'card-pdf-first')),
    db
      .select({ evidence: schema.transactionEvidence })
      .from(schema.transactionEvidence)
      .innerJoin(
        schema.stagedTransactions,
        eq(
          schema.stagedTransactions.id,
          schema.transactionEvidence.stagedTransactionId,
        ),
      )
      .where(
        inArray(schema.stagedTransactions.importId, [
          'import-pdf-first',
          'import-csv-after-pdf',
        ]),
      ),
  ])
  assert.equal(pdfFirstTransactions.length, 1)
  assert.equal(pdfFirstTransactions[0].externalId, 'PDF-FIRST-E1')
  assert.equal(pdfFirstEvidence.length, 2)
  assert.equal(
    pdfFirstEvidence.find(
      (row) => row.evidence.stagedTransactionId === 'staged-csv-after-pdf',
    )?.evidence.matchKind,
    'statement_control',
  )

  await db.insert(schema.importBatches).values({
    id: 'batch-reimport-csv-after-pdf',
    creditCardId: 'card-pdf-first',
    status: 'review',
  })
  await db.insert(schema.imports).values({
    id: 'import-reimport-csv-after-pdf',
    sourceFileId: 'source-pdf-first-csv',
    batchId: 'batch-reimport-csv-after-pdf',
    creditCardId: 'card-pdf-first',
    parser: 'csv',
    documentKind: 'card_statement',
    sourceTransactionCount: 1,
    parsedTransactionCount: 1,
    activityStart: '2026-08-03',
    activityEnd: '2026-08-03',
    periodStart: '2026-08-01',
    periodEnd: '2026-08-31',
    periodSource: 'user',
    coverageConfidence: 'high',
    totalDebitsCents: 10_000,
    netMovementCents: -10_000,
    validationStatus: 'warning',
    status: 'review',
  })
  await db.insert(schema.stagedTransactions).values({
    id: 'staged-reimport-csv-after-pdf',
    importId: 'import-reimport-csv-after-pdf',
    externalId: 'PDF-FIRST-E1',
    fingerprint: 'pdf-first-csv-fingerprint',
    postedAt: '2026-08-03',
    description: 'Descrição diferente no CSV',
    normalizedDescription: 'DESCRICAO DIFERENTE NO CSV',
    amountCents: -10_000,
    currency: 'BRL',
    suggestedCategoryId: 'uncategorized',
  })
  const csvAfterPdfReimport = await commitImport(
    'import-reimport-csv-after-pdf',
    true,
  )
  assert.equal(csvAfterPdfReimport.committed, 0)
  const pdfFirstTransactionsAfterReimport = await db
    .select()
    .from(schema.transactions)
    .where(eq(schema.transactions.creditCardId, 'card-pdf-first'))
  assert.equal(pdfFirstTransactionsAfterReimport.length, 1)

  await db.insert(schema.sourceFiles).values({
    id: 'source-pdf-first-csv-no-id',
    sha256: 'pdf-first-csv-no-id-sha',
    originalName: 'card-cycle-overlap-no-id.csv',
    mediaType: 'text/csv',
    sizeBytes: 100,
    storagePath: fileURLToPath(
      new URL('./fixtures/card-cycle-overlap-no-id.csv', import.meta.url),
    ),
  })
  await db.insert(schema.creditCards).values({
    id: 'card-pdf-first-no-id',
    ownershipScopeId: scope.id,
    name: 'Cartão com CSV posterior sem identificador',
    lastFour: '9753',
    closingDay: 31,
  })
  await db.insert(schema.importBatches).values({
    id: 'batch-pdf-first-no-id',
    creditCardId: 'card-pdf-first-no-id',
    status: 'review',
  })
  await db.insert(schema.imports).values({
    id: 'import-pdf-first-no-id',
    sourceFileId: 'source-final-pdf',
    batchId: 'batch-pdf-first-no-id',
    creditCardId: 'card-pdf-first-no-id',
    parser: 'pdf_inspector',
    documentKind: 'card_statement',
    closingBalanceCents: 10_000,
    balanceAsOf: '2026-08-31',
    parsedTransactionCount: 1,
    activityStart: '2026-08-03',
    activityEnd: '2026-08-03',
    periodStart: '2026-08-01',
    periodEnd: '2026-08-31',
    periodSource: 'metadata',
    coverageConfidence: 'high',
    totalDebitsCents: 10_000,
    netMovementCents: -10_000,
    validationStatus: 'reconciled',
    status: 'review',
  })
  await db.insert(schema.stagedTransactions).values({
    id: 'staged-pdf-first-no-id',
    importId: 'import-pdf-first-no-id',
    fingerprint: 'pdf-first-no-id-pdf-fingerprint',
    postedAt: '2026-08-03',
    description: 'Descrição canônica sem ID',
    normalizedDescription: 'DESCRICAO CANONICA SEM ID',
    amountCents: -10_000,
    currency: 'BRL',
    suggestedCategoryId: 'uncategorized',
  })
  await commitImport('import-pdf-first-no-id')

  for (const suffix of ['first', 'repeat']) {
    const batchId = `batch-csv-no-id-${suffix}`
    const importId = `import-csv-no-id-${suffix}`
    const stagedId = `staged-csv-no-id-${suffix}`
    await db.insert(schema.importBatches).values({
      id: batchId,
      creditCardId: 'card-pdf-first-no-id',
      status: 'review',
    })
    await db.insert(schema.imports).values({
      id: importId,
      sourceFileId: 'source-pdf-first-csv-no-id',
      batchId,
      creditCardId: 'card-pdf-first-no-id',
      parser: 'csv',
      documentKind: 'card_statement',
      sourceTransactionCount: 1,
      parsedTransactionCount: 1,
      activityStart: '2026-08-03',
      activityEnd: '2026-08-03',
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      periodSource: 'user',
      coverageConfidence: 'high',
      totalDebitsCents: 10_000,
      netMovementCents: -10_000,
      validationStatus: 'warning',
      status: 'review',
    })
    await db.insert(schema.stagedTransactions).values({
      id: stagedId,
      importId,
      fingerprint: 'pdf-first-no-id-csv-fingerprint',
      postedAt: '2026-08-03',
      description: 'Outra descrição sem identificador',
      normalizedDescription: 'OUTRA DESCRICAO SEM IDENTIFICADOR',
      amountCents: -10_000,
      currency: 'BRL',
      suggestedCategoryId: 'uncategorized',
    })
    const result = await commitImport(importId, true)
    assert.equal(result.committed, 0)
  }
  const [pdfFirstNoIdTransactions, pdfFirstNoIdEvidence] = await Promise.all([
    db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.creditCardId, 'card-pdf-first-no-id')),
    db
      .select({ evidence: schema.transactionEvidence })
      .from(schema.transactionEvidence)
      .innerJoin(
        schema.stagedTransactions,
        eq(
          schema.stagedTransactions.id,
          schema.transactionEvidence.stagedTransactionId,
        ),
      )
      .where(
        inArray(schema.stagedTransactions.importId, [
          'import-pdf-first-no-id',
          'import-csv-no-id-first',
          'import-csv-no-id-repeat',
        ]),
      ),
  ])
  assert.equal(pdfFirstNoIdTransactions.length, 1)
  assert.equal(pdfFirstNoIdEvidence.length, 3)
  assert.ok(
    pdfFirstNoIdEvidence
      .filter(
        (row) => row.evidence.stagedTransactionId !== 'staged-pdf-first-no-id',
      )
      .every((row) => row.evidence.matchKind === 'statement_control'),
  )

  await db.insert(schema.accounts).values({
    id: 'account-csv-first-control',
    ownershipScopeId: scope.id,
    name: 'Conta com CSV antes do PDF',
    statementBalanceCents: 100_000,
    statementBalanceAt: '2026-07-31',
    coverageStart: '2026-07-31',
  })
  await db.insert(schema.importBatches).values([
    {
      id: 'batch-account-csv-first',
      accountId: 'account-csv-first-control',
      status: 'committed',
    },
    {
      id: 'batch-account-pdf-after-csv',
      accountId: 'account-csv-first-control',
      status: 'review',
    },
  ])
  await db.insert(schema.imports).values([
    {
      id: 'import-account-csv-first',
      sourceFileId: 'source-open-csv',
      batchId: 'batch-account-csv-first',
      accountId: 'account-csv-first-control',
      parser: 'csv',
      documentKind: 'bank_statement',
      sourceTransactionCount: 1,
      parsedTransactionCount: 1,
      activityStart: '2026-08-03',
      activityEnd: '2026-08-03',
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      periodSource: 'user',
      coverageConfidence: 'high',
      totalDebitsCents: 10_000,
      netMovementCents: -10_000,
      validationStatus: 'imported',
      status: 'committed',
    },
    {
      id: 'import-account-pdf-after-csv',
      sourceFileId: 'source-final-pdf',
      batchId: 'batch-account-pdf-after-csv',
      accountId: 'account-csv-first-control',
      parser: 'pdf_inspector',
      documentKind: 'bank_statement',
      sourceTransactionCount: 1,
      parsedTransactionCount: 1,
      closingBalanceCents: 90_000,
      balanceAsOf: '2026-08-31',
      activityStart: '2026-08-03',
      activityEnd: '2026-08-03',
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      periodSource: 'metadata',
      coverageConfidence: 'high',
      totalDebitsCents: 10_000,
      netMovementCents: -10_000,
      validationStatus: 'reconciled',
      status: 'review',
    },
  ])
  await db.insert(schema.stagedTransactions).values([
    {
      id: 'staged-account-csv-first',
      importId: 'import-account-csv-first',
      externalId: 'ACCOUNT-CSV-E1',
      fingerprint: 'account-csv-first-fingerprint',
      postedAt: '2026-08-03',
      description: 'Descrição no CSV da conta',
      normalizedDescription: 'DESCRICAO NO CSV DA CONTA',
      amountCents: -10_000,
      currency: 'BRL',
      suggestedCategoryId: 'uncategorized',
    },
    {
      id: 'staged-account-pdf-after-csv',
      importId: 'import-account-pdf-after-csv',
      fingerprint: 'account-pdf-after-csv-fingerprint',
      postedAt: '2026-08-03',
      description: 'Descrição diferente no PDF da conta',
      normalizedDescription: 'DESCRICAO DIFERENTE NO PDF DA CONTA',
      amountCents: -10_000,
      currency: 'BRL',
      suggestedCategoryId: 'uncategorized',
    },
  ])
  await db.insert(schema.transactions).values({
    id: 'canonical-account-csv-first',
    importId: 'import-account-csv-first',
    accountId: 'account-csv-first-control',
    categoryId: 'uncategorized',
    externalId: 'ACCOUNT-CSV-E1',
    sourceKey: 'account:csv:first:1',
    fingerprint: 'account-csv-first-fingerprint',
    postedAt: '2026-08-03',
    description: 'Descrição no CSV da conta',
    normalizedDescription: 'DESCRICAO NO CSV DA CONTA',
    amountCents: -10_000,
    currency: 'BRL',
    baseAmountCents: -10_000,
    exchangeRateMicros: 1_000_000,
    status: 'confirmed',
  })
  await db.insert(schema.transactionEvidence).values({
    id: 'evidence-account-csv-first',
    stagedTransactionId: 'staged-account-csv-first',
    transactionId: 'canonical-account-csv-first',
    matchKind: 'created',
  })
  await reconcileCsvWithPdfControl({
    importIds: ['import-account-pdf-after-csv'],
    targetType: 'account',
    targetId: 'account-csv-first-control',
  })
  await commitImport('import-account-pdf-after-csv')
  const [
    accountCsvFirstTransactions,
    accountCsvFirstEvidence,
    accountPdfImport,
  ] = await Promise.all([
    db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.accountId, 'account-csv-first-control')),
    db
      .select()
      .from(schema.transactionEvidence)
      .where(
        eq(
          schema.transactionEvidence.stagedTransactionId,
          'staged-account-pdf-after-csv',
        ),
      ),
    db
      .select()
      .from(schema.imports)
      .where(eq(schema.imports.id, 'import-account-pdf-after-csv')),
  ])
  assert.equal(accountCsvFirstTransactions.length, 1)
  assert.equal(accountCsvFirstEvidence[0].matchKind, 'statement_control')
  assert.equal(accountPdfImport[0].status, 'evidence')
  assert.equal(accountPdfImport[0].validationStatus, 'reconciled')

  await db.insert(schema.importBatches).values({
    id: 'batch-account-structured-after-control',
    accountId: 'account-csv-first-control',
    status: 'review',
  })
  await db.insert(schema.imports).values({
    id: 'import-account-structured-after-control',
    sourceFileId: 'source-open-csv',
    batchId: 'batch-account-structured-after-control',
    accountId: 'account-csv-first-control',
    parser: 'ofx',
    documentKind: 'bank_statement',
    sourceTransactionCount: 1,
    parsedTransactionCount: 1,
    activityStart: '2026-08-03',
    activityEnd: '2026-08-03',
    periodStart: '2026-08-01',
    periodEnd: '2026-08-31',
    periodSource: 'user',
    coverageConfidence: 'high',
    totalDebitsCents: 10_000,
    netMovementCents: -10_000,
    validationStatus: 'imported',
    status: 'review',
  })
  await db.insert(schema.stagedTransactions).values({
    id: 'staged-account-structured-after-control',
    importId: 'import-account-structured-after-control',
    fingerprint: 'account-third-format-fingerprint',
    postedAt: '2026-08-03',
    description: 'Terceira descrição para o mesmo lançamento',
    normalizedDescription: 'TERCEIRA DESCRICAO PARA O MESMO LANCAMENTO',
    amountCents: -10_000,
    currency: 'BRL',
    suggestedCategoryId: 'uncategorized',
  })
  const accountControlledRepeat = await commitImport(
    'import-account-structured-after-control',
  )
  assert.equal(accountControlledRepeat.committed, 0)
  const accountControlledRepeatEvidence = await db
    .select()
    .from(schema.transactionEvidence)
    .where(
      eq(
        schema.transactionEvidence.stagedTransactionId,
        'staged-account-structured-after-control',
      ),
    )
  assert.equal(accountControlledRepeatEvidence.length, 1)
  assert.equal(
    accountControlledRepeatEvidence[0].transactionId,
    'canonical-account-csv-first',
  )
  assert.equal(
    accountControlledRepeatEvidence[0].matchKind,
    'statement_control',
  )

  await db.insert(schema.importBatches).values({
    id: 'batch-account-pdf-mismatch',
    accountId: 'account-csv-first-control',
    status: 'review',
  })
  await db.insert(schema.imports).values({
    id: 'import-account-pdf-mismatch',
    sourceFileId: 'source-repeat-pdf',
    batchId: 'batch-account-pdf-mismatch',
    accountId: 'account-csv-first-control',
    parser: 'pdf_inspector',
    documentKind: 'bank_statement',
    sourceTransactionCount: 1,
    parsedTransactionCount: 1,
    closingBalanceCents: 89_000,
    balanceAsOf: '2026-08-31',
    periodStart: '2026-08-01',
    periodEnd: '2026-08-31',
    periodSource: 'metadata',
    coverageConfidence: 'high',
    totalDebitsCents: 11_000,
    netMovementCents: -11_000,
    validationStatus: 'reconciled',
    status: 'review',
  })
  await db.insert(schema.stagedTransactions).values({
    id: 'staged-account-pdf-mismatch',
    importId: 'import-account-pdf-mismatch',
    fingerprint: 'account-pdf-mismatch-fingerprint',
    postedAt: '2026-08-03',
    description: 'Valor divergente no PDF',
    normalizedDescription: 'VALOR DIVERGENTE NO PDF',
    amountCents: -11_000,
    currency: 'BRL',
    suggestedCategoryId: 'uncategorized',
  })
  await reconcileCsvWithPdfControl({
    importIds: ['import-account-pdf-mismatch'],
    targetType: 'account',
    targetId: 'account-csv-first-control',
  })
  const accountPdfMismatch = await db
    .select()
    .from(schema.imports)
    .where(eq(schema.imports.id, 'import-account-pdf-mismatch'))
  assert.equal(accountPdfMismatch[0].validationStatus, 'divergent')

  await db.insert(schema.accounts).values({
    id: 'account-csv-first-superset',
    ownershipScopeId: scope.id,
    name: 'Conta com PDF mensal após CSV parcial',
    statementBalanceCents: 100_000,
    statementBalanceAt: '2026-07-31',
    coverageStart: '2026-07-31',
  })
  await db.insert(schema.importBatches).values([
    {
      id: 'batch-account-csv-first-superset',
      accountId: 'account-csv-first-superset',
      status: 'committed',
    },
    {
      id: 'batch-account-pdf-superset',
      accountId: 'account-csv-first-superset',
      status: 'review',
    },
  ])
  await db.insert(schema.imports).values([
    {
      id: 'import-account-csv-first-superset',
      sourceFileId: 'source-open-csv',
      batchId: 'batch-account-csv-first-superset',
      accountId: 'account-csv-first-superset',
      parser: 'csv',
      documentKind: 'bank_statement',
      sourceTransactionCount: 1,
      parsedTransactionCount: 1,
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      periodSource: 'user',
      coverageConfidence: 'high',
      totalDebitsCents: 10_000,
      netMovementCents: -10_000,
      validationStatus: 'imported',
      status: 'committed',
    },
    {
      id: 'import-account-pdf-superset',
      sourceFileId: 'source-final-pdf',
      batchId: 'batch-account-pdf-superset',
      accountId: 'account-csv-first-superset',
      parser: 'pdf_inspector',
      documentKind: 'bank_statement',
      sourceTransactionCount: 2,
      parsedTransactionCount: 2,
      closingBalanceCents: 85_000,
      balanceAsOf: '2026-08-31',
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      periodSource: 'metadata',
      coverageConfidence: 'high',
      totalDebitsCents: 15_000,
      netMovementCents: -15_000,
      validationStatus: 'reconciled',
      status: 'review',
    },
  ])
  await db.insert(schema.stagedTransactions).values([
    {
      id: 'staged-account-csv-first-superset',
      importId: 'import-account-csv-first-superset',
      fingerprint: 'account-csv-first-superset-fingerprint',
      postedAt: '2026-08-03',
      description: 'Linha A no CSV parcial',
      normalizedDescription: 'LINHA A NO CSV PARCIAL',
      amountCents: -10_000,
      currency: 'BRL',
      suggestedCategoryId: 'uncategorized',
    },
    {
      id: 'staged-account-pdf-superset-existing',
      importId: 'import-account-pdf-superset',
      fingerprint: 'account-pdf-superset-existing-fingerprint',
      postedAt: '2026-08-03',
      description: 'Linha A com outra descrição no PDF',
      normalizedDescription: 'LINHA A COM OUTRA DESCRICAO NO PDF',
      amountCents: -10_000,
      currency: 'BRL',
      suggestedCategoryId: 'uncategorized',
    },
    {
      id: 'staged-account-pdf-superset-new',
      importId: 'import-account-pdf-superset',
      fingerprint: 'account-pdf-superset-new-fingerprint',
      postedAt: '2026-08-20',
      description: 'Linha B presente apenas no PDF mensal',
      normalizedDescription: 'LINHA B PRESENTE APENAS NO PDF MENSAL',
      amountCents: -5_000,
      currency: 'BRL',
      suggestedCategoryId: 'uncategorized',
    },
  ])
  await db.insert(schema.transactions).values({
    id: 'canonical-account-csv-first-superset',
    importId: 'import-account-csv-first-superset',
    accountId: 'account-csv-first-superset',
    categoryId: 'uncategorized',
    sourceKey: 'account:csv:first:superset:1',
    fingerprint: 'account-csv-first-superset-fingerprint',
    postedAt: '2026-08-03',
    description: 'Linha A no CSV parcial',
    normalizedDescription: 'LINHA A NO CSV PARCIAL',
    amountCents: -10_000,
    currency: 'BRL',
    baseAmountCents: -10_000,
    exchangeRateMicros: 1_000_000,
    status: 'confirmed',
  })
  await db.insert(schema.transactionEvidence).values({
    id: 'evidence-account-csv-first-superset',
    stagedTransactionId: 'staged-account-csv-first-superset',
    transactionId: 'canonical-account-csv-first-superset',
    matchKind: 'created',
  })
  await reconcileCsvWithPdfControl({
    importIds: ['import-account-pdf-superset'],
    targetType: 'account',
    targetId: 'account-csv-first-superset',
  })
  const [accountSupersetPreview, accountSupersetStaged] = await Promise.all([
    db
      .select()
      .from(schema.imports)
      .where(eq(schema.imports.id, 'import-account-pdf-superset')),
    db
      .select()
      .from(schema.stagedTransactions)
      .where(
        eq(schema.stagedTransactions.importId, 'import-account-pdf-superset'),
      ),
  ])
  assert.equal(accountSupersetPreview[0].status, 'review')
  assert.equal(accountSupersetPreview[0].validationStatus, 'reconciled')
  assert.equal(
    accountSupersetStaged.find(
      (row) => row.id === 'staged-account-pdf-superset-existing',
    )?.duplicate,
    true,
  )
  assert.equal(
    accountSupersetStaged.find(
      (row) => row.id === 'staged-account-pdf-superset-new',
    )?.duplicate,
    false,
  )
  const accountSupersetCommit = await commitImport(
    'import-account-pdf-superset',
  )
  assert.equal(accountSupersetCommit.committed, 1)
  const [
    accountSupersetTransactions,
    accountSupersetEvidence,
    accountCheckpoint,
  ] = await Promise.all([
    db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.accountId, 'account-csv-first-superset')),
    db
      .select({ evidence: schema.transactionEvidence })
      .from(schema.transactionEvidence)
      .innerJoin(
        schema.stagedTransactions,
        eq(
          schema.stagedTransactions.id,
          schema.transactionEvidence.stagedTransactionId,
        ),
      )
      .where(
        inArray(schema.stagedTransactions.importId, [
          'import-account-csv-first-superset',
          'import-account-pdf-superset',
        ]),
      ),
    db
      .select()
      .from(schema.balanceCheckpoints)
      .where(
        eq(schema.balanceCheckpoints.accountId, 'account-csv-first-superset'),
      ),
  ])
  assert.equal(accountSupersetTransactions.length, 2)
  assert.equal(accountSupersetEvidence.length, 3)
  assert.equal(accountCheckpoint.length, 1)
  assert.equal(accountCheckpoint[0].balanceCents, 85_000)
  assert.equal(accountCheckpoint[0].reviewState, 'verified')

  await db.insert(schema.accounts).values({
    id: 'account-same-batch-superset',
    ownershipScopeId: scope.id,
    name: 'Conta com CSV e PDF no mesmo lote',
  })
  await db.insert(schema.importBatches).values({
    id: 'batch-account-same-batch-superset',
    accountId: 'account-same-batch-superset',
    status: 'review',
  })
  await db.insert(schema.imports).values([
    {
      id: 'import-account-same-batch-csv',
      sourceFileId: 'source-open-csv',
      batchId: 'batch-account-same-batch-superset',
      accountId: 'account-same-batch-superset',
      parser: 'csv',
      documentKind: 'bank_statement',
      sourceTransactionCount: 1,
      parsedTransactionCount: 1,
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      periodSource: 'user',
      coverageConfidence: 'high',
      totalDebitsCents: 10_000,
      netMovementCents: -10_000,
      validationStatus: 'imported',
      status: 'review',
    },
    {
      id: 'import-account-same-batch-pdf',
      sourceFileId: 'source-final-pdf',
      batchId: 'batch-account-same-batch-superset',
      accountId: 'account-same-batch-superset',
      parser: 'pdf_inspector',
      documentKind: 'bank_statement',
      sourceTransactionCount: 2,
      parsedTransactionCount: 2,
      openingBalanceCents: 100_000,
      openingBalanceAt: '2026-07-31',
      closingBalanceCents: 85_000,
      balanceAsOf: '2026-08-31',
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      periodSource: 'metadata',
      coverageConfidence: 'high',
      totalDebitsCents: 15_000,
      netMovementCents: -15_000,
      validationStatus: 'imported',
      status: 'review',
    },
  ])
  await db.insert(schema.stagedTransactions).values([
    {
      id: 'staged-account-same-batch-csv',
      importId: 'import-account-same-batch-csv',
      fingerprint: 'account-same-batch-csv-fingerprint',
      postedAt: '2026-08-03',
      description: 'Linha A no CSV semanal',
      normalizedDescription: 'LINHA A NO CSV SEMANAL',
      amountCents: -10_000,
      currency: 'BRL',
      suggestedCategoryId: 'uncategorized',
    },
    {
      id: 'staged-account-same-batch-pdf-existing',
      importId: 'import-account-same-batch-pdf',
      fingerprint: 'account-same-batch-pdf-existing-fingerprint',
      postedAt: '2026-08-03',
      description: 'Linha A no PDF mensal',
      normalizedDescription: 'LINHA A NO PDF MENSAL',
      amountCents: -10_000,
      currency: 'BRL',
      suggestedCategoryId: 'uncategorized',
    },
    {
      id: 'staged-account-same-batch-pdf-new',
      importId: 'import-account-same-batch-pdf',
      fingerprint: 'account-same-batch-pdf-new-fingerprint',
      postedAt: '2026-08-20',
      description: 'Linha B posterior ao CSV semanal',
      normalizedDescription: 'LINHA B POSTERIOR AO CSV SEMANAL',
      amountCents: -5_000,
      currency: 'BRL',
      suggestedCategoryId: 'uncategorized',
    },
  ])
  await reconcileCsvWithPdfControl({
    importIds: [
      'import-account-same-batch-csv',
      'import-account-same-batch-pdf',
    ],
    targetType: 'account',
    targetId: 'account-same-batch-superset',
  })
  const accountSameBatchCsv = await db
    .select()
    .from(schema.imports)
    .where(eq(schema.imports.id, 'import-account-same-batch-csv'))
  assert.equal(accountSameBatchCsv[0].status, 'review')
  assert.equal(
    accountSameBatchCsv[0].dependsOnImportId,
    'import-account-same-batch-pdf',
  )
  await commitImport('import-account-same-batch-pdf')
  const [accountSameBatchTransactions, accountSameBatchEvidence] =
    await Promise.all([
      db
        .select()
        .from(schema.transactions)
        .where(
          eq(schema.transactions.accountId, 'account-same-batch-superset'),
        ),
      db
        .select({ evidence: schema.transactionEvidence })
        .from(schema.transactionEvidence)
        .innerJoin(
          schema.stagedTransactions,
          eq(
            schema.stagedTransactions.id,
            schema.transactionEvidence.stagedTransactionId,
          ),
        )
        .where(
          inArray(schema.stagedTransactions.importId, [
            'import-account-same-batch-csv',
            'import-account-same-batch-pdf',
          ]),
        ),
    ])
  assert.equal(accountSameBatchTransactions.length, 2)
  assert.equal(accountSameBatchEvidence.length, 3)

  await db.insert(schema.sourceFiles).values({
    id: 'source-account-pdf-first-csv',
    sha256: 'account-pdf-first-csv-sha',
    originalName: 'account-cycle-overlap.csv',
    mediaType: 'text/csv',
    sizeBytes: 100,
    storagePath: fileURLToPath(
      new URL('./fixtures/account-cycle-overlap.csv', import.meta.url),
    ),
  })
  await db.insert(schema.accounts).values({
    id: 'account-pdf-first-control',
    ownershipScopeId: scope.id,
    name: 'Conta com PDF antes do CSV',
  })
  await db.insert(schema.importBatches).values({
    id: 'batch-account-pdf-first',
    accountId: 'account-pdf-first-control',
    status: 'review',
  })
  await db.insert(schema.imports).values({
    id: 'import-account-pdf-first',
    sourceFileId: 'source-final-pdf',
    batchId: 'batch-account-pdf-first',
    accountId: 'account-pdf-first-control',
    parser: 'pdf_inspector',
    documentKind: 'bank_statement',
    sourceTransactionCount: 1,
    parsedTransactionCount: 1,
    openingBalanceCents: 100_000,
    openingBalanceAt: '2026-07-31',
    closingBalanceCents: 90_000,
    balanceAsOf: '2026-08-31',
    activityStart: '2026-08-03',
    activityEnd: '2026-08-03',
    periodStart: '2026-08-01',
    periodEnd: '2026-08-31',
    periodSource: 'metadata',
    coverageConfidence: 'high',
    totalDebitsCents: 10_000,
    netMovementCents: -10_000,
    validationStatus: 'reconciled',
    status: 'review',
  })
  await db.insert(schema.stagedTransactions).values({
    id: 'staged-account-pdf-first',
    importId: 'import-account-pdf-first',
    fingerprint: 'account-pdf-first-fingerprint',
    postedAt: '2026-08-03',
    description: 'Descrição canônica do PDF bancário',
    normalizedDescription: 'DESCRICAO CANONICA DO PDF BANCARIO',
    amountCents: -10_000,
    currency: 'BRL',
    suggestedCategoryId: 'uncategorized',
  })
  await commitImport('import-account-pdf-first')

  for (const suffix of ['first', 'repeat']) {
    const batchId = `batch-account-csv-after-pdf-${suffix}`
    const importId = `import-account-csv-after-pdf-${suffix}`
    const stagedId = `staged-account-csv-after-pdf-${suffix}`
    await db.insert(schema.importBatches).values({
      id: batchId,
      accountId: 'account-pdf-first-control',
      status: 'review',
    })
    await db.insert(schema.imports).values({
      id: importId,
      sourceFileId: 'source-account-pdf-first-csv',
      batchId,
      accountId: 'account-pdf-first-control',
      parser: 'csv',
      documentKind: 'bank_statement',
      sourceTransactionCount: 1,
      parsedTransactionCount: 1,
      activityStart: '2026-08-03',
      activityEnd: '2026-08-03',
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      periodSource: 'user',
      coverageConfidence: 'high',
      totalDebitsCents: 10_000,
      netMovementCents: -10_000,
      validationStatus: 'imported',
      status: 'review',
    })
    await db.insert(schema.stagedTransactions).values({
      id: stagedId,
      importId,
      externalId: 'ACCOUNT-PDF-E1',
      fingerprint: 'account-pdf-first-csv-fingerprint',
      postedAt: '2026-08-03',
      description: 'Descrição estruturada da conta',
      normalizedDescription: 'DESCRICAO ESTRUTURADA DA CONTA',
      amountCents: -10_000,
      currency: 'BRL',
      suggestedCategoryId: 'uncategorized',
    })
    const result = await commitImport(importId)
    assert.equal(result.committed, 0)
  }
  const [accountPdfFirstTransactions, accountPdfFirstEvidence] =
    await Promise.all([
      db
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.accountId, 'account-pdf-first-control')),
      db
        .select({ evidence: schema.transactionEvidence })
        .from(schema.transactionEvidence)
        .innerJoin(
          schema.stagedTransactions,
          eq(
            schema.stagedTransactions.id,
            schema.transactionEvidence.stagedTransactionId,
          ),
        )
        .where(
          inArray(schema.stagedTransactions.importId, [
            'import-account-pdf-first',
            'import-account-csv-after-pdf-first',
            'import-account-csv-after-pdf-repeat',
          ]),
        ),
    ])
  assert.equal(accountPdfFirstTransactions.length, 1)
  assert.equal(accountPdfFirstTransactions[0].externalId, 'ACCOUNT-PDF-E1')
  assert.equal(accountPdfFirstEvidence.length, 3)

  await db.insert(schema.creditCards).values({
    id: 'card-manual-link',
    ownershipScopeId: scope.id,
    name: 'Cartão com ajuste de postagem',
    lastFour: '9876',
    closingDay: 31,
  })
  await db.insert(schema.sourceFiles).values([
    {
      id: 'source-manual-csv',
      sha256: 'manual-csv-sha',
      originalName: 'atividade-aberta.csv',
      mediaType: 'text/csv',
      sizeBytes: 10,
      storagePath: '/tmp/atividade-aberta.csv',
    },
    {
      id: 'source-manual-pdf',
      sha256: 'manual-pdf-sha',
      originalName: 'fatura-com-data-ajustada.pdf',
      mediaType: 'application/pdf',
      sizeBytes: 10,
      storagePath: '/tmp/fatura-com-data-ajustada.pdf',
    },
  ])
  await db.insert(schema.importBatches).values([
    {
      id: 'batch-manual-csv',
      creditCardId: 'card-manual-link',
      status: 'committed',
    },
    {
      id: 'batch-manual-pdf',
      creditCardId: 'card-manual-link',
      status: 'review',
    },
  ])
  await db.insert(schema.imports).values([
    {
      id: 'import-manual-csv',
      sourceFileId: 'source-manual-csv',
      batchId: 'batch-manual-csv',
      creditCardId: 'card-manual-link',
      parser: 'csv',
      documentKind: 'card_statement',
      parsedTransactionCount: 2,
      activityStart: '2026-08-03',
      activityEnd: '2026-08-03',
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      periodSource: 'user',
      coverageConfidence: 'high',
      totalDebitsCents: 30_000,
      netMovementCents: -30_000,
      validationStatus: 'imported',
      status: 'committed',
    },
    {
      id: 'import-manual-pdf',
      sourceFileId: 'source-manual-pdf',
      batchId: 'batch-manual-pdf',
      creditCardId: 'card-manual-link',
      parser: 'pdf_inspector',
      documentKind: 'card_statement',
      closingBalanceCents: 30_000,
      balanceAsOf: '2026-08-31',
      parsedTransactionCount: 2,
      activityStart: '2026-08-04',
      activityEnd: '2026-08-04',
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      periodSource: 'metadata',
      coverageConfidence: 'high',
      totalDebitsCents: 30_000,
      netMovementCents: -30_000,
      validationStatus: 'imported',
      status: 'review',
    },
  ])
  await db.insert(schema.stagedTransactions).values([
    {
      id: 'staged-manual-csv',
      importId: 'import-manual-csv',
      externalId: 'E1',
      fingerprint: 'manual-csv-fingerprint',
      postedAt: '2026-08-03',
      description: 'Compra pendente',
      normalizedDescription: 'COMPRA PENDENTE',
      amountCents: -10_000,
      currency: 'BRL',
      suggestedCategoryId: 'uncategorized',
    },
    {
      id: 'staged-manual-pdf',
      importId: 'import-manual-pdf',
      fingerprint: 'manual-pdf-fingerprint',
      postedAt: '2026-08-04',
      description: 'Compra lançada pelo banco',
      normalizedDescription: 'COMPRA LANCADA PELO BANCO',
      amountCents: -10_000,
      currency: 'BRL',
      suggestedCategoryId: 'uncategorized',
    },
    {
      id: 'staged-manual-csv-second',
      importId: 'import-manual-csv',
      externalId: 'E2',
      fingerprint: 'manual-csv-second-fingerprint',
      postedAt: '2026-08-06',
      description: 'Segunda compra pendente',
      normalizedDescription: 'SEGUNDA COMPRA PENDENTE',
      amountCents: -20_000,
      currency: 'BRL',
      suggestedCategoryId: 'uncategorized',
    },
    {
      id: 'staged-manual-pdf-second',
      importId: 'import-manual-pdf',
      fingerprint: 'manual-pdf-second-fingerprint',
      postedAt: '2026-08-07',
      description: 'Segunda compra lançada pelo banco',
      normalizedDescription: 'SEGUNDA COMPRA LANCADA PELO BANCO',
      amountCents: -20_000,
      currency: 'BRL',
      suggestedCategoryId: 'uncategorized',
    },
  ])
  await db.insert(schema.transactions).values([
    {
      id: 'canonical-manual-csv',
      importId: 'import-manual-csv',
      creditCardId: 'card-manual-link',
      categoryId: 'uncategorized',
      externalId: 'E1',
      sourceKey: 'card:manual:csv:1',
      fingerprint: 'manual-csv-fingerprint',
      postedAt: '2026-08-03',
      description: 'Compra pendente',
      normalizedDescription: 'COMPRA PENDENTE',
      amountCents: -10_000,
      currency: 'BRL',
      baseAmountCents: -10_000,
      exchangeRateMicros: 1_000_000,
      status: 'pending',
    },
    {
      id: 'canonical-manual-csv-second',
      importId: 'import-manual-csv',
      creditCardId: 'card-manual-link',
      categoryId: 'uncategorized',
      externalId: 'E2',
      sourceKey: 'card:manual:csv:2',
      fingerprint: 'manual-csv-second-fingerprint',
      postedAt: '2026-08-06',
      description: 'Segunda compra pendente',
      normalizedDescription: 'SEGUNDA COMPRA PENDENTE',
      amountCents: -20_000,
      currency: 'BRL',
      baseAmountCents: -20_000,
      exchangeRateMicros: 1_000_000,
      status: 'pending',
    },
  ])
  await db.insert(schema.transactionEvidence).values([
    {
      id: 'evidence-manual-csv',
      stagedTransactionId: 'staged-manual-csv',
      transactionId: 'canonical-manual-csv',
      matchKind: 'created',
    },
    {
      id: 'evidence-manual-csv-second',
      stagedTransactionId: 'staged-manual-csv-second',
      transactionId: 'canonical-manual-csv-second',
      matchKind: 'created',
    },
  ])

  await reconcileCsvWithPdfControl({
    importIds: ['import-manual-pdf'],
    targetType: 'card',
    targetId: 'card-manual-link',
  })
  const blockedManualImport = await db
    .select()
    .from(schema.imports)
    .where(eq(schema.imports.id, 'import-manual-pdf'))
  assert.equal(blockedManualImport[0].validationStatus, 'divergent')

  await db.insert(schema.transactions).values({
    id: 'canonical-manual-outside-cycle',
    importId: 'import-manual-csv',
    creditCardId: 'card-manual-link',
    categoryId: 'uncategorized',
    sourceKey: 'card:manual:outside',
    fingerprint: 'outside-cycle',
    postedAt: '2026-07-31',
    description: 'Fora do ciclo',
    normalizedDescription: 'FORA DO CICLO',
    amountCents: -10_000,
    currency: 'BRL',
    baseAmountCents: -10_000,
    exchangeRateMicros: 1_000_000,
    status: 'pending',
  })
  await assert.rejects(
    linkStatementObservation({
      stagedTransactionId: 'staged-manual-pdf',
      transactionId: 'canonical-manual-outside-cycle',
    }),
    /fora do período/,
  )
  await db
    .delete(schema.transactions)
    .where(eq(schema.transactions.id, 'canonical-manual-outside-cycle'))

  await linkStatementObservation({
    stagedTransactionId: 'staged-manual-pdf',
    transactionId: 'canonical-manual-csv',
  })
  const partiallyResolvedManualImport = await db
    .select()
    .from(schema.imports)
    .where(eq(schema.imports.id, 'import-manual-pdf'))
  assert.equal(partiallyResolvedManualImport[0].validationStatus, 'divergent')
  await assert.rejects(
    commitImport('import-manual-pdf'),
    /ainda não correspondem/,
  )
  await assert.rejects(
    linkStatementObservation({
      stagedTransactionId: 'staged-manual-pdf-second',
      transactionId: 'canonical-manual-csv',
    }),
    /já foi vinculado/,
  )
  await linkStatementObservation({
    stagedTransactionId: 'staged-manual-pdf-second',
    transactionId: 'canonical-manual-csv-second',
  })
  const fullyResolvedManualImport = await db
    .select()
    .from(schema.imports)
    .where(eq(schema.imports.id, 'import-manual-pdf'))
  assert.equal(fullyResolvedManualImport[0].validationStatus, 'reconciled')
  const manualCommit = await commitImport('import-manual-pdf')
  assert.equal(manualCommit.committed, 0)

  const [manualTransactions, manualEvidence, manualCorrections, manualBatch] =
    await Promise.all([
      db
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.creditCardId, 'card-manual-link')),
      db
        .select({ evidence: schema.transactionEvidence })
        .from(schema.transactionEvidence)
        .innerJoin(
          schema.stagedTransactions,
          eq(
            schema.stagedTransactions.id,
            schema.transactionEvidence.stagedTransactionId,
          ),
        )
        .where(eq(schema.stagedTransactions.importId, 'import-manual-pdf')),
      db
        .select()
        .from(schema.transactionCorrections)
        .where(
          eq(
            schema.transactionCorrections.stagedTransactionId,
            'staged-manual-pdf',
          ),
        ),
      db
        .select()
        .from(schema.importBatches)
        .where(eq(schema.importBatches.id, 'batch-manual-pdf')),
    ])
  assert.equal(manualTransactions.length, 2)
  const correctedManualTransaction = manualTransactions.find(
    (item) => item.id === 'canonical-manual-csv',
  )!
  assert.equal(correctedManualTransaction.postedAt, '2026-08-04')
  assert.equal(correctedManualTransaction.status, 'confirmed')
  assert.equal(correctedManualTransaction.externalId, 'E1')
  assert.deepEqual(
    identifyDuplicateReasons(
      [{ externalId: 'E1', fingerprint: 'original-csv-fingerprint' }],
      [correctedManualTransaction],
    ),
    ['external_id'],
  )
  assert.equal(manualEvidence.length, 2)
  assert.equal(manualCorrections[0].status, 'accepted')
  assert.equal(manualBatch[0].status, 'committed')

  await db.insert(schema.importBatches).values({
    id: 'batch-reimport-known-version',
    creditCardId: 'card-manual-link',
    status: 'review',
  })
  await db.insert(schema.imports).values({
    id: 'import-reimport-known-version',
    sourceFileId: 'source-manual-csv',
    batchId: 'batch-reimport-known-version',
    creditCardId: 'card-manual-link',
    parser: 'pdf_local',
    documentKind: 'card_statement',
    sourceTransactionCount: 1,
    parsedTransactionCount: 1,
    activityStart: '2026-08-03',
    activityEnd: '2026-08-03',
    periodStart: '2026-08-01',
    periodEnd: '2026-08-31',
    periodSource: 'user',
    coverageConfidence: 'high',
    totalDebitsCents: 10_000,
    netMovementCents: -10_000,
    validationStatus: 'warning',
    status: 'review',
  })
  await db.insert(schema.stagedTransactions).values({
    id: 'staged-reimport-known-version',
    importId: 'import-reimport-known-version',
    externalId: 'E1',
    fingerprint: 'manual-csv-fingerprint',
    postedAt: '2026-08-03',
    description: 'Compra pendente',
    normalizedDescription: 'COMPRA PENDENTE',
    amountCents: -10_000,
    currency: 'BRL',
    suggestedCategoryId: 'uncategorized',
  })
  const knownVersionCommit = await commitImport(
    'import-reimport-known-version',
    true,
  )
  assert.equal(knownVersionCommit.committed, 0)
  const [knownVersionTransactions, knownVersionEvidence] = await Promise.all([
    db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.creditCardId, 'card-manual-link')),
    db
      .select({ evidence: schema.transactionEvidence })
      .from(schema.transactionEvidence)
      .innerJoin(
        schema.stagedTransactions,
        eq(
          schema.stagedTransactions.id,
          schema.transactionEvidence.stagedTransactionId,
        ),
      )
      .where(eq(schema.stagedTransactions.id, 'staged-reimport-known-version')),
  ])
  assert.equal(knownVersionTransactions.length, 2)
  assert.equal(knownVersionEvidence[0].evidence.matchKind, 'external_id')

  await db.insert(schema.importBatches).values([
    {
      id: 'batch-rejected-observation',
      creditCardId: 'card-manual-link',
      status: 'failed',
    },
    {
      id: 'batch-after-rejected-observation',
      creditCardId: 'card-manual-link',
      status: 'review',
    },
  ])
  await db.insert(schema.imports).values([
    {
      id: 'import-rejected-observation',
      sourceFileId: 'source-manual-pdf',
      batchId: 'batch-rejected-observation',
      creditCardId: 'card-manual-link',
      parser: 'pdf_inspector',
      documentKind: 'card_statement',
      parsedTransactionCount: 1,
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      periodSource: 'metadata',
      coverageConfidence: 'high',
      validationStatus: 'divergent',
      status: 'rejected',
    },
    {
      id: 'import-after-rejected-observation',
      sourceFileId: 'source-manual-csv',
      batchId: 'batch-after-rejected-observation',
      creditCardId: 'card-manual-link',
      parser: 'pdf_local',
      documentKind: 'card_statement',
      sourceTransactionCount: 1,
      parsedTransactionCount: 1,
      activityStart: '2026-08-08',
      activityEnd: '2026-08-08',
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      periodSource: 'user',
      coverageConfidence: 'high',
      totalDebitsCents: 10_000,
      netMovementCents: -10_000,
      validationStatus: 'warning',
      status: 'review',
    },
  ])
  await db.insert(schema.stagedTransactions).values([
    {
      id: 'staged-rejected-observation',
      importId: 'import-rejected-observation',
      externalId: 'E1',
      fingerprint: 'rejected-version-fingerprint',
      postedAt: '2026-08-08',
      description: 'Versão rejeitada',
      normalizedDescription: 'VERSAO REJEITADA',
      amountCents: -10_000,
      currency: 'BRL',
      suggestedCategoryId: 'uncategorized',
    },
    {
      id: 'staged-after-rejected-observation',
      importId: 'import-after-rejected-observation',
      externalId: 'E1',
      fingerprint: 'rejected-version-fingerprint',
      postedAt: '2026-08-08',
      description: 'Versão que precisa de correção real',
      normalizedDescription: 'VERSAO QUE PRECISA DE CORRECAO REAL',
      amountCents: -10_000,
      currency: 'BRL',
      suggestedCategoryId: 'uncategorized',
    },
  ])
  await db.insert(schema.transactionEvidence).values({
    id: 'evidence-rejected-observation',
    stagedTransactionId: 'staged-rejected-observation',
    transactionId: 'canonical-manual-csv',
    matchKind: 'statement_control',
  })
  await assert.rejects(
    commitImport('import-after-rejected-observation', true),
    /dados diferentes/,
  )
  const correctionsAfterRejectedEvidence = await db
    .select()
    .from(schema.transactionCorrections)
    .where(
      eq(
        schema.transactionCorrections.stagedTransactionId,
        'staged-after-rejected-observation',
      ),
    )
  assert.equal(correctionsAfterRejectedEvidence[0].status, 'pending')

  await db.insert(schema.creditCards).values({
    id: 'card-missing-authorization',
    ownershipScopeId: scope.id,
    name: 'Cartão com autorização expirada',
    lastFour: '4567',
    closingDay: 31,
  })
  await db.insert(schema.importBatches).values([
    {
      id: 'batch-missing-csv',
      creditCardId: 'card-missing-authorization',
      status: 'committed',
    },
    {
      id: 'batch-missing-pdf',
      creditCardId: 'card-missing-authorization',
      status: 'review',
    },
  ])
  await db.insert(schema.imports).values([
    {
      id: 'import-missing-csv',
      sourceFileId: 'source-manual-csv',
      batchId: 'batch-missing-csv',
      creditCardId: 'card-missing-authorization',
      parser: 'csv',
      documentKind: 'card_statement',
      parsedTransactionCount: 3,
      activityStart: '2026-08-03',
      activityEnd: '2026-08-05',
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      periodSource: 'user',
      coverageConfidence: 'high',
      totalDebitsCents: 18_000,
      netMovementCents: -18_000,
      validationStatus: 'imported',
      status: 'committed',
    },
    {
      id: 'import-missing-pdf',
      sourceFileId: 'source-manual-pdf',
      batchId: 'batch-missing-pdf',
      creditCardId: 'card-missing-authorization',
      parser: 'pdf_inspector',
      documentKind: 'card_statement',
      closingBalanceCents: 11_000,
      balanceAsOf: '2026-08-31',
      parsedTransactionCount: 1,
      activityStart: '2026-08-03',
      activityEnd: '2026-08-03',
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      periodSource: 'metadata',
      coverageConfidence: 'high',
      totalDebitsCents: 10_000,
      netMovementCents: -10_000,
      validationStatus: 'imported',
      status: 'review',
    },
  ])
  await db.insert(schema.stagedTransactions).values([
    {
      id: 'staged-missing-csv-a',
      importId: 'import-missing-csv',
      fingerprint: 'missing-a',
      postedAt: '2026-08-03',
      description: 'Compra confirmada A',
      normalizedDescription: 'COMPRA CONFIRMADA A',
      amountCents: -10_000,
      currency: 'BRL',
      suggestedCategoryId: 'uncategorized',
    },
    {
      id: 'staged-missing-csv-b',
      importId: 'import-missing-csv',
      fingerprint: 'missing-b',
      postedAt: '2026-08-05',
      description: 'Autorização expirada B',
      normalizedDescription: 'AUTORIZACAO EXPIRADA B',
      amountCents: -5_000,
      currency: 'BRL',
      suggestedCategoryId: 'uncategorized',
    },
    {
      id: 'staged-missing-pdf-a',
      importId: 'import-missing-pdf',
      fingerprint: 'missing-pdf-a',
      postedAt: '2026-08-03',
      description: 'Compra final A',
      normalizedDescription: 'COMPRA FINAL A',
      amountCents: -10_000,
      currency: 'BRL',
      suggestedCategoryId: 'uncategorized',
    },
    {
      id: 'staged-missing-csv-c',
      importId: 'import-missing-csv',
      fingerprint: 'missing-c',
      postedAt: '2026-08-06',
      description: 'Autorização expirada C',
      normalizedDescription: 'AUTORIZACAO EXPIRADA C',
      amountCents: -3_000,
      currency: 'BRL',
      suggestedCategoryId: 'uncategorized',
    },
  ])
  await db.insert(schema.transactions).values([
    {
      id: 'canonical-missing-a',
      importId: 'import-missing-csv',
      creditCardId: 'card-missing-authorization',
      categoryId: 'uncategorized',
      sourceKey: 'card:missing:a',
      fingerprint: 'missing-a',
      postedAt: '2026-08-03',
      description: 'Compra confirmada A',
      normalizedDescription: 'COMPRA CONFIRMADA A',
      amountCents: -10_000,
      currency: 'BRL',
      baseAmountCents: -10_000,
      exchangeRateMicros: 1_000_000,
      status: 'pending',
    },
    {
      id: 'canonical-missing-b',
      importId: 'import-missing-csv',
      creditCardId: 'card-missing-authorization',
      categoryId: 'uncategorized',
      sourceKey: 'card:missing:b',
      fingerprint: 'missing-b',
      postedAt: '2026-08-05',
      description: 'Autorização expirada B',
      normalizedDescription: 'AUTORIZACAO EXPIRADA B',
      amountCents: -5_000,
      currency: 'BRL',
      baseAmountCents: -5_000,
      exchangeRateMicros: 1_000_000,
      status: 'pending',
    },
    {
      id: 'canonical-missing-c',
      importId: 'import-missing-csv',
      creditCardId: 'card-missing-authorization',
      categoryId: 'uncategorized',
      sourceKey: 'card:missing:c',
      fingerprint: 'missing-c',
      postedAt: '2026-08-06',
      description: 'Autorização expirada C',
      normalizedDescription: 'AUTORIZACAO EXPIRADA C',
      amountCents: -3_000,
      currency: 'BRL',
      baseAmountCents: -3_000,
      exchangeRateMicros: 1_000_000,
      status: 'pending',
    },
  ])
  await db.insert(schema.transactionEvidence).values([
    {
      id: 'evidence-missing-a',
      stagedTransactionId: 'staged-missing-csv-a',
      transactionId: 'canonical-missing-a',
      matchKind: 'created',
    },
    {
      id: 'evidence-missing-b',
      stagedTransactionId: 'staged-missing-csv-b',
      transactionId: 'canonical-missing-b',
      matchKind: 'created',
    },
    {
      id: 'evidence-missing-c',
      stagedTransactionId: 'staged-missing-csv-c',
      transactionId: 'canonical-missing-c',
      matchKind: 'created',
    },
  ])

  await reconcileCsvWithPdfControl({
    importIds: ['import-missing-pdf'],
    targetType: 'card',
    targetId: 'card-missing-authorization',
  })
  const blockedMissingImport = await db
    .select()
    .from(schema.imports)
    .where(eq(schema.imports.id, 'import-missing-pdf'))
  assert.equal(blockedMissingImport[0].validationStatus, 'divergent')

  await resolveStatementExclusion({
    importId: 'import-missing-pdf',
    transactionId: 'canonical-missing-b',
    action: 'exclude',
  })
  const partiallyResolvedMissingImport = await db
    .select()
    .from(schema.imports)
    .where(eq(schema.imports.id, 'import-missing-pdf'))
  assert.equal(partiallyResolvedMissingImport[0].validationStatus, 'divergent')
  await assert.rejects(
    commitImport('import-missing-pdf'),
    /ainda não correspondem/,
  )
  await resolveStatementExclusion({
    importId: 'import-missing-pdf',
    transactionId: 'canonical-missing-c',
    action: 'exclude',
  })
  const totalMismatchImport = await db
    .select()
    .from(schema.imports)
    .where(eq(schema.imports.id, 'import-missing-pdf'))
  assert.equal(totalMismatchImport[0].validationStatus, 'divergent')
  assert.match(
    totalMismatchImport[0].validationMessage ?? '',
    /total da fatura/,
  )
  await assert.rejects(commitImport('import-missing-pdf'), /total da fatura/)
  await db
    .update(schema.imports)
    .set({ closingBalanceCents: 10_000 })
    .where(eq(schema.imports.id, 'import-missing-pdf'))
  await resolveStatementExclusion({
    importId: 'import-missing-pdf',
    transactionId: 'canonical-missing-c',
    action: 'restore',
  })
  await resolveStatementExclusion({
    importId: 'import-missing-pdf',
    transactionId: 'canonical-missing-c',
    action: 'exclude',
  })
  const fullyResolvedMissingImport = await db
    .select()
    .from(schema.imports)
    .where(eq(schema.imports.id, 'import-missing-pdf'))
  assert.equal(fullyResolvedMissingImport[0].validationStatus, 'reconciled')
  await commitImport('import-missing-pdf')
  const [missingTransactions, activeExclusions, missingCycle] =
    await Promise.all([
      db
        .select()
        .from(schema.transactions)
        .where(
          eq(schema.transactions.creditCardId, 'card-missing-authorization'),
        ),
      db
        .select()
        .from(schema.statementExclusions)
        .where(eq(schema.statementExclusions.importId, 'import-missing-pdf')),
      db
        .select()
        .from(schema.cardStatementCycles)
        .where(
          eq(
            schema.cardStatementCycles.creditCardId,
            'card-missing-authorization',
          ),
        ),
    ])
  assert.equal(missingTransactions.length, 3)
  assert.equal(
    missingTransactions.find((item) => item.id === 'canonical-missing-a')
      ?.status,
    'confirmed',
  )
  assert.equal(
    missingTransactions.find((item) => item.id === 'canonical-missing-b')
      ?.status,
    'excluded',
  )
  assert.equal(
    missingTransactions.find((item) => item.id === 'canonical-missing-c')
      ?.status,
    'excluded',
  )
  assert.equal(activeExclusions.length, 2)
  assert.ok(activeExclusions.every((item) => item.reversedAt === null))
  assert.equal(missingCycle[0].status, 'reconciled')

  await db
    .update(schema.transactions)
    .set({ externalId: 'MISSING-AUTH-B' })
    .where(eq(schema.transactions.id, 'canonical-missing-b'))
  await db.insert(schema.importBatches).values({
    id: 'batch-missing-auth-returned',
    creditCardId: 'card-missing-authorization',
    status: 'review',
  })
  await db.insert(schema.imports).values({
    id: 'import-missing-auth-returned',
    sourceFileId: 'source-pdf-first-csv',
    batchId: 'batch-missing-auth-returned',
    creditCardId: 'card-missing-authorization',
    parser: 'csv',
    documentKind: 'card_statement',
    sourceTransactionCount: 1,
    parsedTransactionCount: 1,
    periodStart: '2026-08-01',
    periodEnd: '2026-08-31',
    periodSource: 'user',
    coverageConfidence: 'high',
    totalDebitsCents: 5_000,
    netMovementCents: -5_000,
    validationStatus: 'imported',
    status: 'review',
  })
  await db.insert(schema.stagedTransactions).values({
    id: 'staged-missing-auth-returned',
    importId: 'import-missing-auth-returned',
    externalId: 'MISSING-AUTH-B',
    fingerprint: 'missing-b',
    postedAt: '2026-08-05',
    description: 'Autorização B confirmada posteriormente',
    normalizedDescription: 'AUTORIZACAO B CONFIRMADA POSTERIORMENTE',
    amountCents: -5_000,
    currency: 'BRL',
    suggestedCategoryId: 'uncategorized',
  })
  const returnedAuthorization = await commitImport(
    'import-missing-auth-returned',
    true,
  )
  assert.equal(returnedAuthorization.committed, 0)
  const [
    transactionsAfterReturn,
    exclusionsAfterReturn,
    cyclesAfterReturn,
    checkpointsAfterReturn,
    returnedImport,
    priorStatementAfterReturn,
  ] = await Promise.all([
    db
      .select()
      .from(schema.transactions)
      .where(
        eq(schema.transactions.creditCardId, 'card-missing-authorization'),
      ),
    db
      .select()
      .from(schema.statementExclusions)
      .where(
        eq(schema.statementExclusions.transactionId, 'canonical-missing-b'),
      ),
    db
      .select()
      .from(schema.cardStatementCycles)
      .where(
        eq(
          schema.cardStatementCycles.creditCardId,
          'card-missing-authorization',
        ),
      ),
    db
      .select()
      .from(schema.balanceCheckpoints)
      .where(
        eq(
          schema.balanceCheckpoints.creditCardId,
          'card-missing-authorization',
        ),
      ),
    db
      .select()
      .from(schema.imports)
      .where(eq(schema.imports.id, 'import-missing-auth-returned')),
    db
      .select()
      .from(schema.imports)
      .where(eq(schema.imports.id, 'import-missing-pdf')),
  ])
  assert.equal(transactionsAfterReturn.length, 3)
  assert.equal(
    transactionsAfterReturn.find((item) => item.id === 'canonical-missing-b')
      ?.status,
    'pending',
  )
  assert.ok(exclusionsAfterReturn[0].reversedAt)
  assert.match(exclusionsAfterReturn[0].reason, /importação posterior/)
  assert.ok(cyclesAfterReturn.every((item) => item.status === 'closed'))
  assert.ok(
    checkpointsAfterReturn.every(
      (item) => item.reviewState === 'invalidated' && !item.verified,
    ),
  )
  assert.equal(returnedImport[0].status, 'evidence')
  assert.equal(priorStatementAfterReturn[0].validationStatus, 'divergent')
  assert.equal(
    priorStatementAfterReturn[0].validationReason,
    'missing_statement_transactions',
  )

  await db.insert(schema.importBatches).values({
    id: 'batch-missing-auth-returned-pdf',
    creditCardId: 'card-missing-authorization',
    status: 'review',
  })
  await db.insert(schema.imports).values({
    id: 'import-missing-auth-returned-pdf',
    sourceFileId: 'source-final-pdf',
    batchId: 'batch-missing-auth-returned-pdf',
    creditCardId: 'card-missing-authorization',
    parser: 'pdf_inspector',
    documentKind: 'card_statement',
    sourceTransactionCount: 3,
    parsedTransactionCount: 3,
    closingBalanceCents: 18_000,
    closingBalanceType: 'card_statement',
    balanceAsOf: '2026-09-01',
    periodStart: '2026-08-01',
    periodEnd: '2026-08-31',
    periodSource: 'metadata',
    coverageConfidence: 'high',
    totalDebitsCents: 18_000,
    netMovementCents: -18_000,
    validationStatus: 'imported',
    status: 'review',
  })
  await db.insert(schema.stagedTransactions).values([
    {
      id: 'staged-missing-returned-pdf-a',
      importId: 'import-missing-auth-returned-pdf',
      fingerprint: 'missing-returned-pdf-a',
      postedAt: '2026-08-03',
      description: 'Compra A na fatura posterior',
      normalizedDescription: 'COMPRA A NA FATURA POSTERIOR',
      amountCents: -10_000,
      currency: 'BRL',
      suggestedCategoryId: 'uncategorized',
    },
    {
      id: 'staged-missing-returned-pdf-b',
      importId: 'import-missing-auth-returned-pdf',
      externalId: 'MISSING-AUTH-B',
      fingerprint: 'missing-returned-pdf-b',
      postedAt: '2026-08-05',
      description: 'Compra B na fatura posterior',
      normalizedDescription: 'COMPRA B NA FATURA POSTERIOR',
      amountCents: -5_000,
      currency: 'BRL',
      suggestedCategoryId: 'uncategorized',
    },
    {
      id: 'staged-missing-returned-pdf-c',
      importId: 'import-missing-auth-returned-pdf',
      fingerprint: 'missing-returned-pdf-c',
      postedAt: '2026-08-06',
      description: 'Compra C na fatura posterior',
      normalizedDescription: 'COMPRA C NA FATURA POSTERIOR',
      amountCents: -3_000,
      currency: 'BRL',
      suggestedCategoryId: 'uncategorized',
    },
  ])
  await reconcileCsvWithPdfControl({
    importIds: ['import-missing-auth-returned-pdf'],
    targetType: 'card',
    targetId: 'card-missing-authorization',
  })
  const [
    transactionsAfterReturnedPdf,
    exclusionCAfterReturnedPdf,
    returnedPdfImport,
  ] = await Promise.all([
    db
      .select()
      .from(schema.transactions)
      .where(
        eq(schema.transactions.creditCardId, 'card-missing-authorization'),
      ),
    db
      .select()
      .from(schema.statementExclusions)
      .where(
        eq(schema.statementExclusions.transactionId, 'canonical-missing-c'),
      ),
    db
      .select()
      .from(schema.imports)
      .where(eq(schema.imports.id, 'import-missing-auth-returned-pdf')),
  ])
  assert.equal(transactionsAfterReturnedPdf.length, 3)
  assert.ok(
    transactionsAfterReturnedPdf.every((item) => item.status === 'confirmed'),
  )
  assert.ok(exclusionCAfterReturnedPdf[0].reversedAt)
  assert.match(exclusionCAfterReturnedPdf[0].reason, /fatura posterior/)
  assert.equal(returnedPdfImport[0].status, 'evidence')

  await db.insert(schema.accounts).values({
    id: 'account-exact-provenance',
    ownershipScopeId: scope.id,
    name: 'Conta com origem documental exata',
  })
  await db.insert(schema.sourceFiles).values({
    id: 'source-exact-provenance-csv',
    sha256: 'exact-provenance-csv-sha',
    originalName: 'account-cycle-overlap.csv',
    mediaType: 'text/csv',
    sizeBytes: 100,
    storagePath: fileURLToPath(
      new URL('./fixtures/account-cycle-overlap.csv', import.meta.url),
    ),
  })
  await db.insert(schema.importBatches).values({
    id: 'batch-account-exact-provenance',
    accountId: 'account-exact-provenance',
    status: 'review',
  })
  await db.insert(schema.imports).values([
    {
      id: 'import-account-exact-csv',
      sourceFileId: 'source-exact-provenance-csv',
      batchId: 'batch-account-exact-provenance',
      accountId: 'account-exact-provenance',
      parser: 'csv',
      documentKind: 'bank_statement',
      sourceTransactionCount: 1,
      parsedTransactionCount: 1,
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      periodSource: 'user',
      coverageConfidence: 'high',
      validationStatus: 'imported',
      status: 'review',
    },
    {
      id: 'import-account-exact-pdf',
      sourceFileId: 'source-final-pdf',
      batchId: 'batch-account-exact-provenance',
      accountId: 'account-exact-provenance',
      parser: 'pdf_inspector',
      documentKind: 'bank_statement',
      sourceTransactionCount: 1,
      parsedTransactionCount: 1,
      openingBalanceCents: 100_000,
      openingBalanceAt: '2026-08-01',
      closingBalanceCents: 90_000,
      closingBalanceType: 'posted',
      balanceAsOf: '2026-08-31',
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      periodSource: 'metadata',
      coverageConfidence: 'high',
      validationStatus: 'imported',
      status: 'review',
    },
  ])
  await db.insert(schema.stagedTransactions).values([
    {
      id: 'staged-account-exact-csv',
      importId: 'import-account-exact-csv',
      fingerprint: 'account-exact-csv-fingerprint',
      postedAt: '2026-08-03',
      description: 'Linha no CSV exato',
      normalizedDescription: 'LINHA NO CSV EXATO',
      amountCents: -10_000,
      currency: 'BRL',
      suggestedCategoryId: 'uncategorized',
    },
    {
      id: 'staged-account-exact-pdf',
      importId: 'import-account-exact-pdf',
      fingerprint: 'account-exact-pdf-fingerprint',
      postedAt: '2026-08-03',
      description: 'Linha no PDF exato',
      normalizedDescription: 'LINHA NO PDF EXATO',
      amountCents: -10_000,
      currency: 'BRL',
      suggestedCategoryId: 'uncategorized',
    },
  ])
  await reconcileCsvWithPdfControl({
    importIds: ['import-account-exact-csv', 'import-account-exact-pdf'],
    targetType: 'account',
    targetId: 'account-exact-provenance',
  })
  await commitImport('import-account-exact-csv')
  const accountExactCheckpoint = await db
    .select()
    .from(schema.balanceCheckpoints)
    .where(eq(schema.balanceCheckpoints.accountId, 'account-exact-provenance'))
  assert.equal(accountExactCheckpoint.length, 1)
  assert.equal(accountExactCheckpoint[0].importId, 'import-account-exact-pdf')
  assert.equal(accountExactCheckpoint[0].source, 'pdf')

  await db.insert(schema.creditCards).values({
    id: 'card-exact-provenance',
    ownershipScopeId: scope.id,
    name: 'Cartão com origem documental exata',
    lastFour: '4411',
    closingDay: 31,
  })
  await db.insert(schema.importBatches).values({
    id: 'batch-card-exact-provenance',
    creditCardId: 'card-exact-provenance',
    status: 'review',
  })
  await db.insert(schema.imports).values([
    {
      id: 'import-card-exact-csv',
      sourceFileId: 'source-exact-provenance-csv',
      batchId: 'batch-card-exact-provenance',
      creditCardId: 'card-exact-provenance',
      parser: 'csv',
      documentKind: 'card_statement',
      sourceTransactionCount: 1,
      parsedTransactionCount: 1,
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      periodSource: 'user',
      coverageConfidence: 'high',
      validationStatus: 'imported',
      status: 'review',
    },
    {
      id: 'import-card-exact-pdf',
      sourceFileId: 'source-final-pdf',
      batchId: 'batch-card-exact-provenance',
      creditCardId: 'card-exact-provenance',
      parser: 'pdf_inspector',
      documentKind: 'card_statement',
      sourceTransactionCount: 1,
      parsedTransactionCount: 1,
      closingBalanceCents: 10_000,
      closingBalanceType: 'card_statement',
      balanceAsOf: '2026-08-31',
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      periodSource: 'metadata',
      coverageConfidence: 'high',
      validationStatus: 'imported',
      status: 'review',
    },
  ])
  await db.insert(schema.stagedTransactions).values([
    {
      id: 'staged-card-exact-csv',
      importId: 'import-card-exact-csv',
      fingerprint: 'card-exact-csv-fingerprint',
      postedAt: '2026-08-03',
      description: 'Compra no CSV exato',
      normalizedDescription: 'COMPRA NO CSV EXATO',
      amountCents: -10_000,
      currency: 'BRL',
      suggestedCategoryId: 'uncategorized',
    },
    {
      id: 'staged-card-exact-pdf',
      importId: 'import-card-exact-pdf',
      fingerprint: 'card-exact-pdf-fingerprint',
      postedAt: '2026-08-03',
      description: 'Compra no PDF exato',
      normalizedDescription: 'COMPRA NO PDF EXATO',
      amountCents: -10_000,
      currency: 'BRL',
      suggestedCategoryId: 'uncategorized',
    },
  ])
  await reconcileCsvWithPdfControl({
    importIds: ['import-card-exact-csv', 'import-card-exact-pdf'],
    targetType: 'card',
    targetId: 'card-exact-provenance',
  })
  await commitImport('import-card-exact-csv')
  const [cardExactCheckpoint, cardExactCycle] = await Promise.all([
    db
      .select()
      .from(schema.balanceCheckpoints)
      .where(
        eq(schema.balanceCheckpoints.creditCardId, 'card-exact-provenance'),
      ),
    db
      .select()
      .from(schema.cardStatementCycles)
      .where(
        eq(schema.cardStatementCycles.creditCardId, 'card-exact-provenance'),
      ),
  ])
  assert.equal(cardExactCheckpoint.length, 1)
  assert.equal(cardExactCheckpoint[0].importId, 'import-card-exact-pdf')
  assert.equal(cardExactCheckpoint[0].source, 'pdf')
  assert.equal(cardExactCycle.length, 1)
  assert.equal(cardExactCycle[0].importId, 'import-card-exact-pdf')

  async function seedThreeFileDependencyGraph(
    suffix: string,
    insertionOrder: Array<'partial' | 'full' | 'pdf'>,
  ) {
    const cardId = `card-dependency-${suffix}`
    const batchId = `batch-dependency-${suffix}`
    const ids = {
      partial: `import-dependency-partial-${suffix}`,
      full: `import-dependency-full-${suffix}`,
      pdf: `import-dependency-pdf-${suffix}`,
    }
    await db.insert(schema.creditCards).values({
      id: cardId,
      ownershipScopeId: scope.id,
      name: `Cartão de dependências ${suffix}`,
      closingDay: 31,
    })
    await db.insert(schema.importBatches).values({
      id: batchId,
      creditCardId: cardId,
      status: 'review',
    })
    const definitions = {
      partial: {
        id: ids.partial,
        sourceFileId: 'source-account-pdf-first-csv',
        batchId,
        creditCardId: cardId,
        parser: 'csv' as const,
        documentKind: 'card_statement' as const,
        sourceTransactionCount: 1,
        parsedTransactionCount: 1,
        periodStart: '2026-08-01',
        periodEnd: '2026-08-15',
        periodSource: 'user' as const,
        coverageConfidence: 'high' as const,
        totalDebitsCents: 10_000,
        netMovementCents: -10_000,
        validationStatus: 'imported' as const,
        status: 'review' as const,
      },
      full: {
        id: ids.full,
        sourceFileId: 'source-account-pdf-first-csv',
        batchId,
        creditCardId: cardId,
        parser: 'csv' as const,
        documentKind: 'card_statement' as const,
        sourceTransactionCount: 2,
        parsedTransactionCount: 2,
        periodStart: '2026-08-01',
        periodEnd: '2026-08-31',
        periodSource: 'user' as const,
        coverageConfidence: 'high' as const,
        totalDebitsCents: 15_000,
        netMovementCents: -15_000,
        validationStatus: 'imported' as const,
        status: 'review' as const,
      },
      pdf: {
        id: ids.pdf,
        sourceFileId: 'source-final-pdf',
        batchId,
        creditCardId: cardId,
        parser: 'pdf_inspector' as const,
        documentKind: 'card_statement' as const,
        sourceTransactionCount: 2,
        parsedTransactionCount: 2,
        closingBalanceCents: 15_000,
        closingBalanceType: 'card_statement' as const,
        balanceAsOf: '2026-08-31',
        periodStart: '2026-08-01',
        periodEnd: '2026-08-31',
        periodSource: 'metadata' as const,
        coverageConfidence: 'high' as const,
        totalDebitsCents: 15_000,
        netMovementCents: -15_000,
        validationStatus: 'imported' as const,
        status: 'review' as const,
      },
    }
    await db
      .insert(schema.imports)
      .values(insertionOrder.map((kind) => definitions[kind]))
    await db.insert(schema.stagedTransactions).values([
      {
        id: `staged-dependency-partial-a-${suffix}`,
        importId: ids.partial,
        externalId: `DEPENDENCY-A-${suffix}`,
        fingerprint: `dependency-partial-a-${suffix}`,
        postedAt: '2026-08-03',
        description: 'Compra A parcial',
        normalizedDescription: 'COMPRA A PARCIAL',
        amountCents: -10_000,
        currency: 'BRL',
        suggestedCategoryId: 'uncategorized',
      },
      {
        id: `staged-dependency-full-a-${suffix}`,
        importId: ids.full,
        externalId: `DEPENDENCY-A-${suffix}`,
        fingerprint: `dependency-full-a-${suffix}`,
        postedAt: '2026-08-03',
        description: 'Compra A estruturada',
        normalizedDescription: 'COMPRA A ESTRUTURADA',
        amountCents: -10_000,
        currency: 'BRL',
        suggestedCategoryId: 'uncategorized',
      },
      {
        id: `staged-dependency-full-b-${suffix}`,
        importId: ids.full,
        externalId: `DEPENDENCY-B-${suffix}`,
        fingerprint: `dependency-full-b-${suffix}`,
        postedAt: '2026-08-20',
        description: 'Compra B estruturada',
        normalizedDescription: 'COMPRA B ESTRUTURADA',
        amountCents: -5_000,
        currency: 'BRL',
        suggestedCategoryId: 'uncategorized',
      },
      {
        id: `staged-dependency-pdf-a-${suffix}`,
        importId: ids.pdf,
        fingerprint: `dependency-pdf-a-${suffix}`,
        postedAt: '2026-08-03',
        description: 'Compra A no PDF',
        normalizedDescription: 'COMPRA A NO PDF',
        amountCents: -10_000,
        currency: 'BRL',
        suggestedCategoryId: 'uncategorized',
      },
      {
        id: `staged-dependency-pdf-b-${suffix}`,
        importId: ids.pdf,
        fingerprint: `dependency-pdf-b-${suffix}`,
        postedAt: '2026-08-20',
        description: 'Compra B no PDF',
        normalizedDescription: 'COMPRA B NO PDF',
        amountCents: -5_000,
        currency: 'BRL',
        suggestedCategoryId: 'uncategorized',
      },
    ])
    await reconcileCsvWithPdfControl({
      importIds: [ids.partial, ids.full, ids.pdf],
      targetType: 'card',
      targetId: cardId,
    })
    return { cardId, batchId, ids }
  }

  for (const [suffix, order] of [
    ['partial-first', ['partial', 'full', 'pdf']],
    ['full-first', ['full', 'pdf', 'partial']],
  ] as const) {
    const graph = await seedThreeFileDependencyGraph(suffix, [...order])
    const beforeCommit = await db
      .select()
      .from(schema.imports)
      .where(eq(schema.imports.batchId, graph.batchId))
    assert.equal(
      beforeCommit.find((item) => item.id === graph.ids.partial)
        ?.dependsOnImportId,
      graph.ids.full,
    )
    assert.equal(
      beforeCommit.find((item) => item.id === graph.ids.pdf)?.dependsOnImportId,
      graph.ids.full,
    )
    assert.equal(
      beforeCommit.find((item) => item.id === graph.ids.full)
        ?.dependsOnImportId,
      null,
    )
    await commitImport(graph.ids.full)
    const [afterCommit, graphTransactions, graphEvidence] = await Promise.all([
      db
        .select()
        .from(schema.imports)
        .where(eq(schema.imports.batchId, graph.batchId)),
      db
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.creditCardId, graph.cardId)),
      db
        .select({ evidence: schema.transactionEvidence })
        .from(schema.transactionEvidence)
        .innerJoin(
          schema.stagedTransactions,
          eq(
            schema.stagedTransactions.id,
            schema.transactionEvidence.stagedTransactionId,
          ),
        )
        .where(
          inArray(schema.stagedTransactions.importId, [
            graph.ids.partial,
            graph.ids.full,
            graph.ids.pdf,
          ]),
        ),
    ])
    assert.ok(afterCommit.every((item) => item.status !== 'review'))
    assert.equal(graphTransactions.length, 2)
    assert.equal(graphEvidence.length, 5)
  }

  const multiCardId = 'card-multi-pair-dependency'
  const multiBatchId = 'batch-multi-pair-dependency'
  await db.insert(schema.creditCards).values({
    id: multiCardId,
    ownershipScopeId: scope.id,
    name: 'Cartão com dois pares no lote',
    closingDay: 31,
  })
  await db.insert(schema.importBatches).values({
    id: multiBatchId,
    creditCardId: multiCardId,
    status: 'review',
  })
  await db.insert(schema.imports).values(
    [
      ['a-csv', 'csv', '2026-08-01', '2026-08-31', 10_000],
      ['a-pdf', 'pdf_inspector', '2026-08-01', '2026-08-31', 10_000],
      ['b-csv', 'csv', '2026-09-01', '2026-09-30', 20_000],
      ['b-pdf', 'pdf_inspector', '2026-09-01', '2026-09-30', 20_000],
    ].map(([suffix, parser, start, end, total]) => ({
      id: `import-multi-${suffix}`,
      sourceFileId:
        parser === 'csv' ? 'source-account-pdf-first-csv' : 'source-final-pdf',
      batchId: multiBatchId,
      creditCardId: multiCardId,
      parser: parser as 'csv' | 'pdf_inspector',
      documentKind: 'card_statement' as const,
      sourceTransactionCount: 1,
      parsedTransactionCount: 1,
      closingBalanceCents: parser === 'pdf_inspector' ? Number(total) : null,
      closingBalanceType:
        parser === 'pdf_inspector' ? ('card_statement' as const) : null,
      balanceAsOf: parser === 'pdf_inspector' ? String(end) : null,
      periodStart: String(start),
      periodEnd: String(end),
      periodSource:
        parser === 'csv' ? ('user' as const) : ('metadata' as const),
      coverageConfidence: 'high' as const,
      totalDebitsCents: Number(total),
      netMovementCents: -Number(total),
      validationStatus: 'imported' as const,
      status: 'review' as const,
    })),
  )
  await db.insert(schema.stagedTransactions).values(
    [
      ['a-csv', '2026-08-10', -10_000, 'MULTI-A'],
      ['a-pdf', '2026-08-10', -10_000, null],
      ['b-csv', '2026-09-10', -20_000, 'MULTI-B'],
      ['b-pdf', '2026-09-10', -20_000, null],
    ].map(([suffix, postedAt, amount, externalId]) => ({
      id: `staged-multi-${suffix}`,
      importId: `import-multi-${suffix}`,
      externalId: externalId ? String(externalId) : null,
      fingerprint: `fingerprint-multi-${suffix}`,
      postedAt: String(postedAt),
      description: `Compra ${suffix}`,
      normalizedDescription: `COMPRA ${String(suffix).toUpperCase()}`,
      amountCents: Number(amount),
      currency: 'BRL',
      suggestedCategoryId: 'uncategorized',
    })),
  )
  await reconcileCsvWithPdfControl({
    importIds: [
      'import-multi-a-csv',
      'import-multi-a-pdf',
      'import-multi-b-csv',
      'import-multi-b-pdf',
    ],
    targetType: 'card',
    targetId: multiCardId,
  })
  await commitImport('import-multi-a-csv')
  const multiAfterA = await db
    .select()
    .from(schema.imports)
    .where(eq(schema.imports.batchId, multiBatchId))
  assert.equal(
    multiAfterA.find((item) => item.id === 'import-multi-a-pdf')?.status,
    'evidence',
  )
  assert.equal(
    multiAfterA.find((item) => item.id === 'import-multi-b-csv')?.status,
    'review',
  )
  assert.equal(
    multiAfterA.find((item) => item.id === 'import-multi-b-pdf')
      ?.dependsOnImportId,
    'import-multi-b-csv',
  )
  await commitImport('import-multi-b-csv')
  assert.ok(
    (
      await db
        .select()
        .from(schema.imports)
        .where(eq(schema.imports.batchId, multiBatchId))
    ).every((item) => item.status !== 'review'),
  )

  const rejectedGraph = await seedThreeFileDependencyGraph('reject-main', [
    'partial',
    'full',
    'pdf',
  ])
  await rejectImport(rejectedGraph.ids.full)
  const releasedAfterReject = await db
    .select()
    .from(schema.imports)
    .where(eq(schema.imports.batchId, rejectedGraph.batchId))
  assert.equal(
    releasedAfterReject.find((item) => item.id === rejectedGraph.ids.full)
      ?.status,
    'rejected',
  )
  for (const releasedId of [rejectedGraph.ids.partial, rejectedGraph.ids.pdf]) {
    const released = releasedAfterReject.find((item) => item.id === releasedId)
    assert.equal(released?.status, 'review')
    assert.equal(released.dependsOnImportId, null)
    assert.equal(released.warning, null)
  }

  await db.insert(schema.creditCards).values({
    id: 'card-excluded-no-id',
    ownershipScopeId: scope.id,
    name: 'Cartão com autorização reaparecida sem ID',
    closingDay: 31,
  })
  await db.insert(schema.accounts).values({
    id: 'account-excluded-counterpart',
    ownershipScopeId: scope.id,
    name: 'Contraparte da conciliação reaberta',
  })
  await db.insert(schema.importBatches).values({
    id: 'batch-excluded-no-id',
    creditCardId: 'card-excluded-no-id',
    status: 'review',
  })
  await db.insert(schema.imports).values([
    {
      id: 'import-excluded-no-id-origin',
      sourceFileId: 'source-open-csv',
      creditCardId: 'card-excluded-no-id',
      parser: 'csv',
      documentKind: 'card_statement',
      parsedTransactionCount: 1,
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      periodSource: 'user',
      coverageConfidence: 'high',
      validationStatus: 'imported',
      status: 'committed',
    },
    {
      id: 'import-excluded-no-id-control',
      sourceFileId: 'source-final-pdf',
      creditCardId: 'card-excluded-no-id',
      parser: 'pdf_inspector',
      documentKind: 'card_statement',
      parsedTransactionCount: 0,
      closingBalanceCents: 0,
      closingBalanceType: 'card_statement',
      balanceAsOf: '2026-10-31',
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      periodSource: 'metadata',
      coverageConfidence: 'high',
      validationStatus: 'reconciled',
      status: 'committed',
    },
    {
      id: 'import-excluded-no-id-returned',
      sourceFileId: 'source-pdf-first-csv-no-id',
      batchId: 'batch-excluded-no-id',
      creditCardId: 'card-excluded-no-id',
      parser: 'csv',
      documentKind: 'card_statement',
      sourceTransactionCount: 1,
      parsedTransactionCount: 1,
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      periodSource: 'user',
      coverageConfidence: 'high',
      totalDebitsCents: 7_000,
      netMovementCents: -7_000,
      validationStatus: 'imported',
      status: 'review',
    },
  ])
  await db.insert(schema.transactions).values([
    {
      id: 'canonical-excluded-no-id',
      importId: 'import-excluded-no-id-origin',
      creditCardId: 'card-excluded-no-id',
      categoryId: 'transfer',
      sourceKey: 'card:excluded:no-id',
      fingerprint: 'excluded-no-id-original',
      postedAt: '2026-10-10',
      description: 'Autorização original sem ID',
      normalizedDescription: 'AUTORIZACAO ORIGINAL SEM ID',
      amountCents: -7_000,
      currency: 'BRL',
      baseAmountCents: -7_000,
      exchangeRateMicros: 1_000_000,
      status: 'excluded',
    },
    {
      id: 'canonical-excluded-counterpart',
      accountId: 'account-excluded-counterpart',
      categoryId: 'transfer',
      sourceKey: 'account:excluded:counterpart',
      fingerprint: 'excluded-counterpart',
      postedAt: '2026-10-10',
      description: 'Contraparte conciliada',
      normalizedDescription: 'CONTRAPARTE CONCILIADA',
      amountCents: 7_000,
      currency: 'BRL',
      baseAmountCents: 7_000,
      exchangeRateMicros: 1_000_000,
      status: 'confirmed',
    },
  ])
  await db.insert(schema.cardStatementCycles).values({
    id: 'cycle-excluded-no-id',
    creditCardId: 'card-excluded-no-id',
    importId: 'import-excluded-no-id-control',
    periodStart: '2026-10-01',
    periodEnd: '2026-10-31',
    closingDate: '2026-10-31',
    totalCents: 0,
    status: 'reconciled',
  })
  await db.insert(schema.statementExclusions).values({
    id: 'exclusion-no-id',
    importId: 'import-excluded-no-id-control',
    transactionId: 'canonical-excluded-no-id',
    previousStatus: 'pending',
    reason: 'Autorização ausente da primeira fatura.',
  })
  await db.insert(schema.reconciliationGroups).values({
    id: 'group-excluded-no-id',
    type: 'transfer',
    status: 'confirmed',
    confidence: 100,
    reason: 'Conciliação anterior à exclusão.',
  })
  await db.insert(schema.reconciliationLinks).values([
    {
      id: 'link-excluded-no-id',
      groupId: 'group-excluded-no-id',
      transactionId: 'canonical-excluded-no-id',
      role: 'outgoing',
      previousCategoryId: 'uncategorized',
    },
    {
      id: 'link-excluded-counterpart',
      groupId: 'group-excluded-no-id',
      transactionId: 'canonical-excluded-counterpart',
      role: 'incoming',
      previousCategoryId: 'uncategorized',
    },
  ])
  await db.insert(schema.stagedTransactions).values({
    id: 'staged-excluded-no-id-returned',
    importId: 'import-excluded-no-id-returned',
    fingerprint: 'excluded-no-id-changed-description',
    postedAt: '2026-10-10',
    description: 'Descrição diferente da movimentação confirmada',
    normalizedDescription: 'DESCRICAO DIFERENTE DA MOVIMENTACAO CONFIRMADA',
    amountCents: -7_000,
    currency: 'BRL',
    suggestedCategoryId: 'uncategorized',
  })
  const noIdRestore = await commitImport('import-excluded-no-id-returned', true)
  assert.equal(noIdRestore.committed, 0)
  const [noIdTransactions, noIdExclusion, reopenedGroup, noIdReturnedImport] =
    await Promise.all([
      db
        .select()
        .from(schema.transactions)
        .where(
          inArray(schema.transactions.id, [
            'canonical-excluded-no-id',
            'canonical-excluded-counterpart',
          ]),
        ),
      db
        .select()
        .from(schema.statementExclusions)
        .where(eq(schema.statementExclusions.id, 'exclusion-no-id')),
      db
        .select()
        .from(schema.reconciliationGroups)
        .where(eq(schema.reconciliationGroups.id, 'group-excluded-no-id')),
      db
        .select()
        .from(schema.imports)
        .where(eq(schema.imports.id, 'import-excluded-no-id-returned')),
    ])
  assert.equal(noIdTransactions.length, 2)
  assert.equal(
    noIdTransactions.find((item) => item.id === 'canonical-excluded-no-id')
      ?.status,
    'pending',
  )
  assert.ok(
    noIdTransactions.every((item) => item.categoryId === 'uncategorized'),
  )
  assert.ok(noIdExclusion[0].reversedAt)
  assert.notEqual(reopenedGroup[0].status, 'confirmed')
  assert.equal(noIdReturnedImport[0].status, 'evidence')

  process.stdout.write('card-statement-control:ok')
}
