import assert from 'node:assert/strict'

import { eq } from 'drizzle-orm'

import { db, ensureDatabase } from '#/db/index.server'
import * as schema from '#/db/schema'
import { createManualBalanceCheckpoint } from './finance.server'
import {
  commitImport,
  reconcileCsvWithPdfControl,
  rejectImport,
  replaceConflictingCheckpoint,
  stageImportBatch,
} from './import.server'

function createTextPdf(lines: string[], variant: string) {
  const escape = (value: string) =>
    value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')
  const commands = [
    'BT',
    '/F1 12 Tf',
    '50 760 Td',
    ...lines.flatMap((line, index) => [
      `(${escape(line)}) Tj`,
      ...(index === lines.length - 1 ? [] : ['0 -24 Td']),
    ]),
    'ET',
  ].join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(commands)} >>\nstream\n${commands}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let source = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(source))
    source += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(source)
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  source += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n% ${variant}`
  return new File([Buffer.from(source)], 'extrato-controle.pdf', {
    type: 'application/pdf',
  })
}

export async function runCheckpointIntegrityFixture() {
  await ensureDatabase()
  const scope = (await db.select().from(schema.ownershipScopes).limit(1))[0]
  assert(scope)

  await db.insert(schema.accounts).values({
    id: 'account-parser-reimport',
    ownershipScopeId: scope.id,
    name: 'Conta de reimportação real',
  })
  const statementLines = [
    'Extrato bancario',
    'Periodo 01/08/2026 a 31/08/2026',
    'Saldo inicial 01/08/2026 R$ 1.000,00',
    '03/08/2026 Compra teste R$ 100,00 D',
    'Saldo final 31/08/2026 R$ 900,00',
  ]
  const firstPdf = createTextPdf(statementLines, 'primeira via')
  const firstStage = await stageImportBatch({
    files: [firstPdf],
    targetType: 'account',
    targetId: 'account-parser-reimport',
    aiConsent: false,
  })
  assert.equal(firstStage.importIds.length, 1)
  const firstCommit = await commitImport(firstStage.importIds[0])
  assert.equal(firstCommit.committed, 1)

  const secondPdf = createTextPdf(statementLines, 'segunda via')
  const secondStage = await stageImportBatch({
    files: [secondPdf],
    targetType: 'account',
    targetId: 'account-parser-reimport',
    aiConsent: false,
  })
  const [canonicalBeforeReimport, stagedBeforeReimport, importBeforeReimport] =
    await Promise.all([
      db
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.accountId, 'account-parser-reimport')),
      db
        .select()
        .from(schema.stagedTransactions)
        .where(
          eq(schema.stagedTransactions.importId, secondStage.importIds[0]),
        ),
      db
        .select()
        .from(schema.imports)
        .where(eq(schema.imports.id, secondStage.importIds[0])),
    ])
  assert.equal(stagedBeforeReimport.length, 1)
  assert.equal(canonicalBeforeReimport.length, 1)
  assert.equal(importBeforeReimport[0].periodSource, 'metadata')
  assert.equal(importBeforeReimport[0].periodStart, '2026-08-01')
  assert.equal(importBeforeReimport[0].periodEnd, '2026-08-31')
  assert.equal(
    stagedBeforeReimport[0].fingerprint,
    canonicalBeforeReimport[0].fingerprint,
  )
  assert.equal(stagedBeforeReimport[0].duplicate, true)
  const secondCommit = await commitImport(secondStage.importIds[0])
  assert.equal(secondCommit.committed, 0)
  const [parserTransactions, parserReimport] = await Promise.all([
    db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.accountId, 'account-parser-reimport')),
    db
      .select()
      .from(schema.imports)
      .where(eq(schema.imports.id, secondStage.importIds[0])),
  ])
  assert.equal(parserTransactions.length, 1)
  assert.equal(parserReimport[0].status, 'evidence')

  await db.insert(schema.accounts).values({
    id: 'account-opening-conflict',
    ownershipScopeId: scope.id,
    name: 'Conta com conflito de abertura',
    statementBalanceCents: 100_000,
    statementBalanceAt: '2026-07-31',
  })
  await db.insert(schema.balanceCheckpoints).values({
    id: 'checkpoint-opening-conflict',
    accountId: 'account-opening-conflict',
    kind: 'statement_closing',
    balanceType: 'posted',
    source: 'manual',
    reviewState: 'verified',
    balanceCents: 100_000,
    asOf: '2026-07-31',
    verified: true,
  })
  await db.insert(schema.sourceFiles).values({
    id: 'source-integrity-pdf',
    sha256: 'integrity-pdf-sha',
    originalName: 'integridade.pdf',
    mediaType: 'application/pdf',
    sizeBytes: 10,
    storagePath: '/tmp/integridade.pdf',
  })
  await db.insert(schema.imports).values({
    id: 'import-opening-conflict',
    sourceFileId: 'source-integrity-pdf',
    accountId: 'account-opening-conflict',
    parser: 'pdf_inspector',
    documentKind: 'bank_statement',
    sourceTransactionCount: 1,
    parsedTransactionCount: 1,
    openingBalanceCents: 200_000,
    openingBalanceAt: '2026-08-01',
    closingBalanceCents: 190_000,
    closingBalanceType: 'posted',
    balanceAsOf: '2026-08-31',
    periodStart: '2026-08-01',
    periodEnd: '2026-08-31',
    periodSource: 'metadata',
    coverageConfidence: 'high',
    validationStatus: 'imported',
    status: 'review',
  })
  await db.insert(schema.stagedTransactions).values({
    id: 'staged-opening-conflict',
    importId: 'import-opening-conflict',
    fingerprint: 'opening-conflict-fingerprint',
    postedAt: '2026-08-03',
    description: 'Compra no extrato conflitante',
    normalizedDescription: 'COMPRA NO EXTRATO CONFLITANTE',
    amountCents: -10_000,
    currency: 'BRL',
    suggestedCategoryId: 'uncategorized',
  })
  await assert.rejects(
    () => commitImport('import-opening-conflict'),
    /contradiz/,
  )
  assert.equal(
    (
      await db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.id, 'account-opening-conflict'))
    )[0].statementBalanceCents,
    100_000,
  )
  const replacedOpening = await replaceConflictingCheckpoint(
    'import-opening-conflict',
  )
  assert.equal(replacedOpening.invalidated, 1)
  assert.equal(
    (
      await db
        .select()
        .from(schema.balanceCheckpoints)
        .where(eq(schema.balanceCheckpoints.id, 'checkpoint-opening-conflict'))
    )[0].reviewState,
    'invalidated',
  )
  const correctedOpeningCommit = await commitImport('import-opening-conflict')
  assert.equal(correctedOpeningCommit.committed, 1)

  await db.insert(schema.accounts).values({
    id: 'account-historical-conflict',
    ownershipScopeId: scope.id,
    name: 'Conta com checkpoint histórico',
    statementBalanceCents: 120_000,
    statementBalanceAt: '2026-09-30',
  })
  await db.insert(schema.imports).values({
    id: 'import-historical-control-old',
    sourceFileId: 'source-integrity-pdf',
    accountId: 'account-historical-conflict',
    parser: 'pdf_inspector',
    documentKind: 'bank_statement',
    parsedTransactionCount: 0,
    closingBalanceCents: 90_000,
    closingBalanceType: 'posted',
    balanceAsOf: '2026-08-31',
    periodStart: '2026-08-01',
    periodEnd: '2026-08-31',
    periodSource: 'metadata',
    coverageConfidence: 'high',
    validationStatus: 'reconciled',
    status: 'committed',
  })
  await db.insert(schema.balanceCheckpoints).values({
    id: 'checkpoint-historical-existing',
    accountId: 'account-historical-conflict',
    importId: 'import-historical-control-old',
    kind: 'statement_closing',
    balanceType: 'posted',
    source: 'manual',
    reviewState: 'verified',
    balanceCents: 90_000,
    asOf: '2026-08-31',
    verified: true,
  })
  await db.insert(schema.imports).values({
    id: 'import-historical-conflict',
    sourceFileId: 'source-integrity-pdf',
    accountId: 'account-historical-conflict',
    parser: 'pdf_inspector',
    documentKind: 'bank_statement',
    sourceTransactionCount: 1,
    parsedTransactionCount: 1,
    openingBalanceCents: 100_000,
    openingBalanceAt: '2026-08-01',
    closingBalanceCents: 89_000,
    closingBalanceType: 'posted',
    balanceAsOf: '2026-08-31',
    periodStart: '2026-08-01',
    periodEnd: '2026-08-31',
    periodSource: 'metadata',
    coverageConfidence: 'high',
    validationStatus: 'imported',
    status: 'review',
  })
  await db.insert(schema.stagedTransactions).values({
    id: 'staged-historical-conflict',
    importId: 'import-historical-conflict',
    fingerprint: 'historical-conflict-fingerprint',
    postedAt: '2026-08-03',
    description: 'Movimento do checkpoint conflitante',
    normalizedDescription: 'MOVIMENTO DO CHECKPOINT CONFLITANTE',
    amountCents: -11_000,
    currency: 'BRL',
    suggestedCategoryId: 'uncategorized',
  })
  await assert.rejects(
    () => commitImport('import-historical-conflict'),
    /Já existe outro saldo .*ativo/,
  )
  assert.equal(
    (
      await db
        .select()
        .from(schema.balanceCheckpoints)
        .where(
          eq(
            schema.balanceCheckpoints.accountId,
            'account-historical-conflict',
          ),
        )
    ).length,
    1,
  )
  assert.equal(
    (
      await db
        .select()
        .from(schema.imports)
        .where(eq(schema.imports.id, 'import-historical-control-old'))
    )[0].validationStatus,
    'reconciled',
  )

  await assert.rejects(
    () =>
      createManualBalanceCheckpoint({
        targetType: 'account',
        targetId: 'account-historical-conflict',
        balanceCents: 89_000,
        asOf: '2026-08-31',
        balanceType: 'posted',
      }),
    /Já existe outro saldo para esta data/,
  )
  const repeatedManual = await createManualBalanceCheckpoint({
    targetType: 'account',
    targetId: 'account-historical-conflict',
    balanceCents: 90_000,
    asOf: '2026-08-31',
    balanceType: 'posted',
  })
  assert.equal(repeatedManual.id, 'checkpoint-historical-existing')
  const replacedManual = await createManualBalanceCheckpoint({
    targetType: 'account',
    targetId: 'account-historical-conflict',
    balanceCents: 89_000,
    asOf: '2026-08-31',
    balanceType: 'posted',
    replaceExisting: true,
  })
  assert.notEqual(replacedManual.id, 'checkpoint-historical-existing')
  const historicalCheckpointsAfterReplacement = await db
    .select()
    .from(schema.balanceCheckpoints)
    .where(
      eq(schema.balanceCheckpoints.accountId, 'account-historical-conflict'),
    )
  assert.equal(
    historicalCheckpointsAfterReplacement.find(
      (checkpoint) => checkpoint.id === 'checkpoint-historical-existing',
    )?.reviewState,
    'invalidated',
  )
  assert.equal(
    historicalCheckpointsAfterReplacement.filter(
      (checkpoint) => checkpoint.reviewState !== 'invalidated',
    ).length,
    1,
  )

  await db.insert(schema.accounts).values({
    id: 'account-available-balance',
    ownershipScopeId: scope.id,
    name: 'Conta com saldo disponível',
    statementBalanceCents: 50_000,
    statementBalanceAt: '2026-07-31',
  })
  await db.insert(schema.imports).values({
    id: 'import-available-balance',
    sourceFileId: 'source-integrity-pdf',
    accountId: 'account-available-balance',
    parser: 'pdf_inspector',
    documentKind: 'bank_statement',
    sourceTransactionCount: 1,
    parsedTransactionCount: 1,
    closingBalanceCents: 44_000,
    closingBalanceType: 'available',
    balanceAsOf: '2026-08-31',
    periodStart: '2026-08-01',
    periodEnd: '2026-08-31',
    periodSource: 'metadata',
    coverageConfidence: 'high',
    validationStatus: 'imported',
    status: 'review',
  })
  await db.insert(schema.stagedTransactions).values({
    id: 'staged-available-balance',
    importId: 'import-available-balance',
    fingerprint: 'available-balance-fingerprint',
    postedAt: '2026-08-03',
    description: 'Movimento com saldo disponível',
    normalizedDescription: 'MOVIMENTO COM SALDO DISPONIVEL',
    amountCents: -5_000,
    currency: 'BRL',
    suggestedCategoryId: 'uncategorized',
  })
  await commitImport('import-available-balance')
  const [availableAccount, availableCheckpoint] = await Promise.all([
    db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, 'account-available-balance')),
    db
      .select()
      .from(schema.balanceCheckpoints)
      .where(
        eq(schema.balanceCheckpoints.accountId, 'account-available-balance'),
      ),
  ])
  assert.equal(availableAccount[0].statementBalanceCents, 50_000)
  assert.equal(availableAccount[0].statementBalanceAt, '2026-07-31')
  assert.equal(availableCheckpoint[0].balanceType, 'available')
  assert.equal(availableCheckpoint[0].reviewState, 'observed')
  assert.equal(availableCheckpoint[0].verified, false)

  await assert.rejects(
    () => rejectImport(firstStage.importIds[0]),
    /Apenas uma importação ainda em revisão/,
  )
  assert.equal(
    (
      await db
        .select()
        .from(schema.imports)
        .where(eq(schema.imports.id, firstStage.importIds[0]))
    )[0].status,
    'committed',
  )

  await db.insert(schema.importBatches).values([
    {
      id: 'batch-reject-single',
      accountId: 'account-available-balance',
      status: 'review',
    },
    {
      id: 'batch-reject-mixed',
      accountId: 'account-available-balance',
      status: 'review',
    },
  ])
  await db.insert(schema.imports).values([
    {
      id: 'import-reject-single',
      sourceFileId: 'source-integrity-pdf',
      batchId: 'batch-reject-single',
      accountId: 'account-available-balance',
      parser: 'pdf_inspector',
      documentKind: 'bank_statement',
      parsedTransactionCount: 0,
      validationStatus: 'imported',
      status: 'review',
    },
    {
      id: 'import-reject-mixed-committed',
      sourceFileId: 'source-integrity-pdf',
      batchId: 'batch-reject-mixed',
      accountId: 'account-available-balance',
      parser: 'pdf_inspector',
      documentKind: 'bank_statement',
      parsedTransactionCount: 0,
      periodStart: '2026-09-01',
      periodEnd: '2026-09-15',
      periodSource: 'metadata',
      coverageConfidence: 'high',
      validationStatus: 'reconciled',
      status: 'committed',
    },
    {
      id: 'import-reject-mixed-review',
      sourceFileId: 'source-integrity-pdf',
      batchId: 'batch-reject-mixed',
      accountId: 'account-available-balance',
      parser: 'pdf_inspector',
      documentKind: 'bank_statement',
      parsedTransactionCount: 0,
      periodStart: '2026-09-16',
      periodEnd: '2026-09-30',
      periodSource: 'metadata',
      coverageConfidence: 'high',
      validationStatus: 'imported',
      status: 'review',
    },
  ])
  await rejectImport('import-reject-single')
  await rejectImport('import-reject-mixed-review')
  const [singleRejectedBatch, mixedRejectedBatch] = await Promise.all([
    db
      .select()
      .from(schema.importBatches)
      .where(eq(schema.importBatches.id, 'batch-reject-single')),
    db
      .select()
      .from(schema.importBatches)
      .where(eq(schema.importBatches.id, 'batch-reject-mixed')),
  ])
  assert.equal(singleRejectedBatch[0].status, 'failed')
  assert.equal(singleRejectedBatch[0].coverageStart, null)
  assert.equal(mixedRejectedBatch[0].status, 'committed')
  assert.equal(mixedRejectedBatch[0].coverageStart, '2026-09-01')
  assert.equal(mixedRejectedBatch[0].coverageEnd, '2026-09-15')

  await db.insert(schema.creditCards).values({
    id: 'card-pdf-restores-only-excluded',
    ownershipScopeId: scope.id,
    name: 'Cartão com única linha excluída',
    statementBalanceCents: 9_999,
    statementBalanceAt: '2026-12-31',
    closingDay: 31,
  })
  await db.insert(schema.imports).values([
    {
      id: 'import-card-excluded-origin',
      sourceFileId: 'source-integrity-pdf',
      creditCardId: 'card-pdf-restores-only-excluded',
      parser: 'csv',
      documentKind: 'card_statement',
      parsedTransactionCount: 1,
      periodStart: '2026-11-01',
      periodEnd: '2026-11-30',
      periodSource: 'user',
      coverageConfidence: 'high',
      validationStatus: 'imported',
      status: 'committed',
    },
    {
      id: 'import-card-excluded-control',
      sourceFileId: 'source-integrity-pdf',
      creditCardId: 'card-pdf-restores-only-excluded',
      parser: 'pdf_inspector',
      documentKind: 'card_statement',
      parsedTransactionCount: 0,
      closingBalanceCents: 4_000,
      closingBalanceType: 'card_statement',
      balanceAsOf: '2026-11-30',
      periodStart: '2026-11-01',
      periodEnd: '2026-11-30',
      periodSource: 'metadata',
      coverageConfidence: 'high',
      validationStatus: 'reconciled',
      status: 'committed',
    },
    {
      id: 'import-card-excluded-returned-pdf',
      sourceFileId: 'source-integrity-pdf',
      creditCardId: 'card-pdf-restores-only-excluded',
      parser: 'pdf_inspector',
      documentKind: 'card_statement',
      sourceTransactionCount: 1,
      parsedTransactionCount: 1,
      closingBalanceCents: 4_000,
      closingBalanceType: 'card_statement',
      balanceAsOf: '2026-11-30',
      periodStart: '2026-11-01',
      periodEnd: '2026-11-30',
      periodSource: 'metadata',
      coverageConfidence: 'high',
      totalDebitsCents: 4_000,
      netMovementCents: -4_000,
      validationStatus: 'imported',
      status: 'review',
    },
  ])
  await db.insert(schema.transactions).values({
    id: 'canonical-card-only-excluded',
    importId: 'import-card-excluded-origin',
    creditCardId: 'card-pdf-restores-only-excluded',
    categoryId: 'uncategorized',
    externalId: 'CARD-EXCLUDED-E1',
    sourceKey: 'card:only-excluded:e1',
    fingerprint: 'card-only-excluded-original',
    postedAt: '2026-11-10',
    description: 'Autorização que expirou',
    normalizedDescription: 'AUTORIZACAO QUE EXPIROU',
    amountCents: -4_000,
    currency: 'BRL',
    baseAmountCents: -4_000,
    exchangeRateMicros: 1_000_000,
    status: 'excluded',
  })
  await db.insert(schema.stagedTransactions).values({
    id: 'staged-card-only-excluded-returned',
    importId: 'import-card-excluded-returned-pdf',
    fingerprint: 'card-only-excluded-changed-description',
    postedAt: '2026-11-10',
    description: 'Descrição diferente no PDF posterior',
    normalizedDescription: 'DESCRICAO DIFERENTE NO PDF POSTERIOR',
    amountCents: -4_000,
    currency: 'BRL',
    suggestedCategoryId: 'uncategorized',
  })
  await db.insert(schema.statementExclusions).values({
    id: 'exclusion-card-only-excluded',
    importId: 'import-card-excluded-control',
    transactionId: 'canonical-card-only-excluded',
    previousStatus: 'pending',
    reason: 'Ausente da primeira fatura.',
  })
  await db.insert(schema.cardStatementCycles).values({
    id: 'cycle-card-only-excluded',
    creditCardId: 'card-pdf-restores-only-excluded',
    importId: 'import-card-excluded-control',
    periodStart: '2026-11-01',
    periodEnd: '2026-11-30',
    closingDate: '2026-11-30',
    totalCents: 4_000,
    status: 'reconciled',
  })
  await db.insert(schema.balanceCheckpoints).values([
    {
      id: 'checkpoint-card-excluded-exact',
      creditCardId: 'card-pdf-restores-only-excluded',
      importId: 'import-card-excluded-control',
      kind: 'statement_closing',
      balanceType: 'card_statement',
      source: 'pdf',
      reviewState: 'verified',
      balanceCents: 4_000,
      asOf: '2026-11-30',
      verified: true,
    },
    {
      id: 'checkpoint-card-excluded-future',
      creditCardId: 'card-pdf-restores-only-excluded',
      kind: 'statement_closing',
      balanceType: 'card_statement',
      source: 'manual',
      reviewState: 'verified',
      balanceCents: 9_999,
      asOf: '2026-12-31',
      verified: true,
    },
  ])
  await reconcileCsvWithPdfControl({
    importIds: ['import-card-excluded-returned-pdf'],
    targetType: 'card',
    targetId: 'card-pdf-restores-only-excluded',
  })
  const [cardOnlyFacts, cardOnlyImport, cardOnlyAccount, cardOnlyCheckpoints] =
    await Promise.all([
      db
        .select()
        .from(schema.transactions)
        .where(
          eq(
            schema.transactions.creditCardId,
            'card-pdf-restores-only-excluded',
          ),
        ),
      db
        .select()
        .from(schema.imports)
        .where(eq(schema.imports.id, 'import-card-excluded-returned-pdf')),
      db
        .select()
        .from(schema.creditCards)
        .where(eq(schema.creditCards.id, 'card-pdf-restores-only-excluded')),
      db
        .select()
        .from(schema.balanceCheckpoints)
        .where(
          eq(
            schema.balanceCheckpoints.creditCardId,
            'card-pdf-restores-only-excluded',
          ),
        ),
    ])
  assert.equal(cardOnlyFacts.length, 1)
  assert.equal(cardOnlyFacts[0].status, 'confirmed')
  assert.equal(cardOnlyImport[0].status, 'evidence')
  assert.equal(cardOnlyAccount[0].statementBalanceCents, 4_000)
  assert.equal(cardOnlyAccount[0].statementBalanceAt, '2026-11-30')
  assert.equal(
    cardOnlyCheckpoints.filter(
      (checkpoint) => checkpoint.reviewState !== 'invalidated',
    ).length,
    1,
  )

  await db.insert(schema.accounts).values({
    id: 'account-pdf-restores-excluded',
    ownershipScopeId: scope.id,
    name: 'Conta com linha excluída restaurada por PDF',
    statementBalanceCents: 150_000,
    statementBalanceAt: '2026-12-31',
  })
  await db.insert(schema.imports).values([
    {
      id: 'import-account-excluded-control',
      sourceFileId: 'source-integrity-pdf',
      accountId: 'account-pdf-restores-excluded',
      parser: 'pdf_inspector',
      documentKind: 'bank_statement',
      parsedTransactionCount: 0,
      closingBalanceCents: 90_000,
      closingBalanceType: 'posted',
      balanceAsOf: '2026-11-30',
      periodStart: '2026-11-01',
      periodEnd: '2026-11-30',
      periodSource: 'metadata',
      coverageConfidence: 'high',
      validationStatus: 'reconciled',
      status: 'committed',
    },
    {
      id: 'import-account-excluded-returned-pdf',
      sourceFileId: 'source-integrity-pdf',
      accountId: 'account-pdf-restores-excluded',
      parser: 'pdf_inspector',
      documentKind: 'bank_statement',
      sourceTransactionCount: 1,
      parsedTransactionCount: 1,
      openingBalanceCents: 100_000,
      openingBalanceAt: '2026-11-01',
      closingBalanceCents: 90_000,
      closingBalanceType: 'posted',
      balanceAsOf: '2026-11-30',
      periodStart: '2026-11-01',
      periodEnd: '2026-11-30',
      periodSource: 'metadata',
      coverageConfidence: 'high',
      totalDebitsCents: 10_000,
      netMovementCents: -10_000,
      validationStatus: 'imported',
      status: 'review',
    },
  ])
  await db.insert(schema.transactions).values({
    id: 'canonical-account-excluded',
    accountId: 'account-pdf-restores-excluded',
    categoryId: 'uncategorized',
    sourceKey: 'account:excluded:pdf',
    fingerprint: 'account-excluded-original',
    postedAt: '2026-11-10',
    description: 'Movimentação excluída da conta',
    normalizedDescription: 'MOVIMENTACAO EXCLUIDA DA CONTA',
    amountCents: -10_000,
    currency: 'BRL',
    baseAmountCents: -10_000,
    exchangeRateMicros: 1_000_000,
    status: 'excluded',
  })
  await db.insert(schema.stagedTransactions).values({
    id: 'staged-account-excluded-returned',
    importId: 'import-account-excluded-returned-pdf',
    fingerprint: 'account-excluded-changed-description',
    postedAt: '2026-11-10',
    description: 'Descrição diferente no novo extrato',
    normalizedDescription: 'DESCRICAO DIFERENTE NO NOVO EXTRATO',
    amountCents: -10_000,
    currency: 'BRL',
    suggestedCategoryId: 'uncategorized',
  })
  await db.insert(schema.statementExclusions).values({
    id: 'exclusion-account-pdf',
    importId: 'import-account-excluded-control',
    transactionId: 'canonical-account-excluded',
    previousStatus: 'pending',
    reason: 'Exclusão histórica a ser revertida.',
  })
  await db.insert(schema.balanceCheckpoints).values([
    {
      id: 'checkpoint-account-excluded-exact',
      accountId: 'account-pdf-restores-excluded',
      importId: 'import-account-excluded-control',
      kind: 'statement_closing',
      balanceType: 'posted',
      source: 'pdf',
      reviewState: 'verified',
      balanceCents: 90_000,
      asOf: '2026-11-30',
      verified: true,
    },
    {
      id: 'checkpoint-account-excluded-future',
      accountId: 'account-pdf-restores-excluded',
      kind: 'statement_closing',
      balanceType: 'posted',
      source: 'manual',
      reviewState: 'verified',
      balanceCents: 150_000,
      asOf: '2026-12-31',
      verified: true,
    },
  ])
  await reconcileCsvWithPdfControl({
    importIds: ['import-account-excluded-returned-pdf'],
    targetType: 'account',
    targetId: 'account-pdf-restores-excluded',
  })
  const [accountRestoredFacts, restoredAccount, accountRestoredCheckpoints] =
    await Promise.all([
      db
        .select()
        .from(schema.transactions)
        .where(
          eq(schema.transactions.accountId, 'account-pdf-restores-excluded'),
        ),
      db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.id, 'account-pdf-restores-excluded')),
      db
        .select()
        .from(schema.balanceCheckpoints)
        .where(
          eq(
            schema.balanceCheckpoints.accountId,
            'account-pdf-restores-excluded',
          ),
        ),
    ])
  assert.equal(accountRestoredFacts.length, 1)
  assert.equal(accountRestoredFacts[0].status, 'confirmed')
  assert.equal(restoredAccount[0].statementBalanceCents, 90_000)
  assert.equal(restoredAccount[0].statementBalanceAt, '2026-11-30')
  assert.equal(
    accountRestoredCheckpoints.filter(
      (checkpoint) => checkpoint.reviewState !== 'invalidated',
    ).length,
    1,
  )

  await db.insert(schema.accounts).values({
    id: 'account-mixed-balance-conflict',
    ownershipScopeId: scope.id,
    name: 'Conta com tipos de saldo mistos',
    statementBalanceCents: 100_000,
    statementBalanceAt: '2026-07-31',
  })
  await db.insert(schema.sourceFiles).values({
    id: 'source-mixed-balance-conflict',
    sha256: 'source-mixed-balance-conflict',
    originalName: 'mixed-balance.ofx',
    mediaType: 'application/x-ofx',
    sizeBytes: 10,
    storagePath: '/tmp/mixed-balance.ofx',
  })
  await db.insert(schema.imports).values({
    id: 'import-mixed-balance-conflict',
    sourceFileId: 'source-mixed-balance-conflict',
    accountId: 'account-mixed-balance-conflict',
    parser: 'ofx',
    documentKind: 'bank_statement',
    openingBalanceCents: 200_000,
    openingBalanceAt: '2026-07-31',
    closingBalanceCents: 250_000,
    closingBalanceType: 'available',
    balanceAsOf: '2026-08-31',
    parsedTransactionCount: 1,
    validationStatus: 'imported',
    status: 'review',
  })
  await db.insert(schema.balanceCheckpoints).values([
    {
      id: 'mixed-posted-conflict',
      accountId: 'account-mixed-balance-conflict',
      kind: 'manual',
      balanceType: 'posted',
      source: 'manual',
      reviewState: 'verified',
      balanceCents: 100_000,
      asOf: '2026-07-31',
      verified: true,
    },
    {
      id: 'mixed-available-conflict',
      accountId: 'account-mixed-balance-conflict',
      kind: 'manual',
      balanceType: 'available',
      source: 'manual',
      reviewState: 'observed',
      balanceCents: 240_000,
      asOf: '2026-08-31',
      verified: false,
    },
  ])
  const mixedReplacement = await replaceConflictingCheckpoint(
    'import-mixed-balance-conflict',
  )
  assert.equal(mixedReplacement.invalidated, 2)
  const mixedCheckpoints = await db
    .select()
    .from(schema.balanceCheckpoints)
    .where(
      eq(schema.balanceCheckpoints.accountId, 'account-mixed-balance-conflict'),
    )
  assert(
    mixedCheckpoints.every(
      (checkpoint) => checkpoint.reviewState === 'invalidated',
    ),
  )

  console.log('checkpoint-integrity:ok')
}
