import assert from 'node:assert/strict'

import { eq } from 'drizzle-orm'

import { db, ensureDatabase } from '#/db/index.server'
import * as schema from '#/db/schema'
import { resolveTransactionCorrection } from './finance.server'
import { commitImport } from './import.server'

await ensureDatabase()
const scope = (await db.select().from(schema.ownershipScopes).limit(1))[0]
assert(scope)

await db.insert(schema.accounts).values({
  id: 'correction-account',
  ownershipScopeId: scope.id,
  name: 'Conta de correções',
})

await db.insert(schema.sourceFiles).values([
  {
    id: 'source-rejected-correction',
    sha256: 'source-rejected-correction',
    originalName: 'rejected-correction.ofx',
    mediaType: 'application/x-ofx',
    sizeBytes: 10,
    storagePath: '/tmp/rejected-correction.ofx',
  },
  {
    id: 'source-promoted-identity',
    sha256: 'source-promoted-identity',
    originalName: 'promoted-identity.ofx',
    mediaType: 'application/x-ofx',
    sizeBytes: 10,
    storagePath: '/tmp/promoted-identity.ofx',
  },
  {
    id: 'source-accepted-correction',
    sha256: 'source-accepted-correction',
    originalName: 'accepted-correction.ofx',
    mediaType: 'application/x-ofx',
    sizeBytes: 10,
    storagePath: '/tmp/accepted-correction.ofx',
  },
])

await db.insert(schema.transactions).values({
  id: 'canonical-rejected-correction',
  accountId: 'correction-account',
  categoryId: 'uncategorized',
  externalId: 'bank-existing',
  sourceKey: 'correction-account:external:bank-existing',
  fingerprint: 'old-correction-fingerprint',
  postedAt: '2026-08-03',
  description: 'Descrição original',
  normalizedDescription: 'DESCRICAO ORIGINAL',
  amountCents: -1_000,
  currency: 'BRL',
  baseAmountCents: -1_000,
  exchangeRateMicros: 1_000_000,
  status: 'confirmed',
})
await db.insert(schema.imports).values({
  id: 'import-rejected-correction',
  sourceFileId: 'source-rejected-correction',
  accountId: 'correction-account',
  parser: 'ofx',
  documentKind: 'bank_statement',
  sourceTransactionCount: 2,
  parsedTransactionCount: 2,
  activityStart: '2026-08-03',
  activityEnd: '2026-08-04',
  periodStart: '2026-08-01',
  periodEnd: '2026-08-31',
  periodSource: 'metadata',
  coverageConfidence: 'high',
  totalDebitsCents: 3_000,
  netMovementCents: -3_000,
  validationStatus: 'divergent',
  status: 'review',
})
await db.insert(schema.stagedTransactions).values([
  {
    id: 'staged-rejected-correction',
    importId: 'import-rejected-correction',
    externalId: 'bank-existing',
    fingerprint: 'new-rejected-fingerprint',
    postedAt: '2026-08-03',
    description: 'Descrição reapresentada',
    normalizedDescription: 'DESCRICAO REAPRESENTADA',
    amountCents: -1_000,
    currency: 'BRL',
    suggestedCategoryId: 'uncategorized',
  },
  {
    id: 'staged-new-after-rejection',
    importId: 'import-rejected-correction',
    externalId: 'bank-new',
    fingerprint: 'new-transaction-fingerprint',
    postedAt: '2026-08-04',
    description: 'Lançamento realmente novo',
    normalizedDescription: 'LANCAMENTO REALMENTE NOVO',
    amountCents: -2_000,
    currency: 'BRL',
    suggestedCategoryId: 'uncategorized',
  },
])
await db.insert(schema.transactionCorrections).values({
  id: 'rejected-correction',
  stagedTransactionId: 'staged-rejected-correction',
  transactionId: 'canonical-rejected-correction',
  status: 'pending',
  previousJson: JSON.stringify({ fingerprint: 'old-correction-fingerprint' }),
  proposedJson: JSON.stringify({ fingerprint: 'new-rejected-fingerprint' }),
})

await resolveTransactionCorrection({
  correctionId: 'rejected-correction',
  action: 'reject',
})
const afterRejection = await db
  .select()
  .from(schema.imports)
  .where(eq(schema.imports.id, 'import-rejected-correction'))
assert.equal(afterRejection[0].status, 'review')

const rejectedCommit = await commitImport('import-rejected-correction', true)
assert.equal(rejectedCommit.committed, 1)
const transactionsAfterRejection = await db
  .select()
  .from(schema.transactions)
  .where(eq(schema.transactions.accountId, 'correction-account'))
assert.equal(transactionsAfterRejection.length, 2)
assert(
  transactionsAfterRejection.some((item) => item.externalId === 'bank-new'),
)

await db.insert(schema.transactions).values({
  id: 'canonical-without-external-id',
  accountId: 'correction-account',
  categoryId: 'uncategorized',
  sourceKey: 'correction-account:file:legacy',
  fingerprint: 'shared-fingerprint',
  postedAt: '2026-09-03',
  description: 'Aporte identificado depois',
  normalizedDescription: 'APORTE IDENTIFICADO DEPOIS',
  amountCents: 50_000,
  currency: 'BRL',
  baseAmountCents: 50_000,
  exchangeRateMicros: 1_000_000,
  status: 'confirmed',
})
await db.insert(schema.imports).values({
  id: 'import-promoted-identity',
  sourceFileId: 'source-promoted-identity',
  accountId: 'correction-account',
  parser: 'ofx',
  documentKind: 'bank_statement',
  sourceTransactionCount: 1,
  parsedTransactionCount: 1,
  activityStart: '2026-09-03',
  activityEnd: '2026-09-03',
  periodStart: '2026-09-01',
  periodEnd: '2026-09-30',
  periodSource: 'metadata',
  coverageConfidence: 'high',
  totalCreditsCents: 50_000,
  netMovementCents: 50_000,
  validationStatus: 'imported',
  status: 'review',
})
await db.insert(schema.stagedTransactions).values({
  id: 'staged-promoted-identity',
  importId: 'import-promoted-identity',
  externalId: 'bank-promoted',
  fingerprint: 'shared-fingerprint',
  postedAt: '2026-09-03',
  description: 'Aporte identificado depois',
  normalizedDescription: 'APORTE IDENTIFICADO DEPOIS',
  amountCents: 50_000,
  currency: 'BRL',
  suggestedCategoryId: 'uncategorized',
})

await commitImport('import-promoted-identity', true)
const promoted = await db
  .select()
  .from(schema.transactions)
  .where(eq(schema.transactions.id, 'canonical-without-external-id'))
assert.equal(promoted[0].externalId, 'bank-promoted')

await db
  .update(schema.accounts)
  .set({ statementBalanceCents: 200_000, statementBalanceAt: '2026-10-31' })
  .where(eq(schema.accounts.id, 'correction-account'))
await db.insert(schema.balanceCheckpoints).values([
  {
    id: 'checkpoint-before-correction',
    accountId: 'correction-account',
    kind: 'manual',
    balanceType: 'posted',
    source: 'manual',
    reviewState: 'verified',
    balanceCents: 150_000,
    asOf: '2026-07-31',
    verified: true,
  },
  {
    id: 'checkpoint-after-correction',
    accountId: 'correction-account',
    kind: 'manual',
    balanceType: 'posted',
    source: 'manual',
    reviewState: 'verified',
    balanceCents: 200_000,
    asOf: '2026-10-31',
    verified: true,
  },
])
await db.insert(schema.imports).values({
  id: 'import-accepted-correction',
  sourceFileId: 'source-accepted-correction',
  accountId: 'correction-account',
  parser: 'ofx',
  documentKind: 'bank_statement',
  parsedTransactionCount: 1,
  validationStatus: 'divergent',
  status: 'review',
})
await db.insert(schema.stagedTransactions).values({
  id: 'staged-accepted-correction',
  importId: 'import-accepted-correction',
  externalId: 'bank-existing',
  fingerprint: 'accepted-correction-fingerprint',
  postedAt: '2026-10-15',
  description: 'Correção aceita',
  normalizedDescription: 'CORRECAO ACEITA',
  amountCents: -1_500,
  currency: 'BRL',
  suggestedCategoryId: 'uncategorized',
})
await db.insert(schema.transactionCorrections).values({
  id: 'accepted-correction',
  stagedTransactionId: 'staged-accepted-correction',
  transactionId: 'canonical-rejected-correction',
  status: 'pending',
  previousJson: JSON.stringify({
    postedAt: '2026-08-03',
    description: 'Descrição original',
    amountCents: -1_000,
    currency: 'BRL',
    fingerprint: 'old-correction-fingerprint',
  }),
  proposedJson: JSON.stringify({
    postedAt: '2026-10-15',
    description: 'Correção aceita',
    amountCents: -1_500,
    currency: 'BRL',
    fingerprint: 'accepted-correction-fingerprint',
  }),
})

await resolveTransactionCorrection({
  correctionId: 'accepted-correction',
  action: 'accept',
})
const [accountAfterCorrection, checkpointsAfterCorrection] = await Promise.all([
  db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.id, 'correction-account')),
  db
    .select()
    .from(schema.balanceCheckpoints)
    .where(eq(schema.balanceCheckpoints.accountId, 'correction-account')),
])
assert.equal(accountAfterCorrection[0].statementBalanceCents, 150_000)
assert.equal(accountAfterCorrection[0].statementBalanceAt, '2026-07-31')
assert.equal(
  checkpointsAfterCorrection.find(
    (item) => item.id === 'checkpoint-after-correction',
  )?.reviewState,
  'invalidated',
)
