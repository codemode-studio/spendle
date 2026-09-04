import { unlink } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { eq, inArray } from 'drizzle-orm'

import { openTestDatabase } from '#/test/database'
import type { TestDatabase } from '#/test/database'
import {
  linkStatementObservation,
  resolveStatementExclusion,
} from './import-resolution.server'
import {
  commitImport,
  confirmImportCoverage,
  reconcileCsvWithPdfControl,
  replaceConflictingCheckpoint,
  retryImportFinalization,
  stageImport,
} from './import.server'
import { getImportReviewSnapshot } from './import-review-read.server'

describe('persistência dos motivos de validação', () => {
  let database: TestDatabase

  beforeAll(async () => {
    database = await openTestDatabase()
    const { db, ids, schema } = database

    await db.insert(schema.sourceFiles).values([
      {
        id: 'altered-statement-source',
        sha256: 'altered-statement-source-sha',
        originalName: 'fatura-alterada.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 100,
        storagePath: '/tmp/fatura-alterada.pdf',
      },
      {
        id: 'missing-statement-source',
        sha256: 'missing-statement-source-sha',
        originalName: 'fatura-com-autorizacao-ausente.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 100,
        storagePath: '/tmp/fatura-com-autorizacao-ausente.pdf',
      },
      {
        id: 'open-statement-source',
        sha256: 'open-statement-source-sha',
        originalName: 'fatura-aberta.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 100,
        storagePath: '/tmp/fatura-aberta.pdf',
      },
      {
        id: 'quarantined-open-statement-source',
        sha256: 'quarantined-open-statement-source-sha',
        originalName: 'fatura-aberta-em-quarentena.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 100,
        storagePath: '/tmp/fatura-aberta-em-quarentena.pdf',
      },
      {
        id: 'legacy-identical-source',
        sha256: 'legacy-identical-source-sha',
        originalName: 'arquivo-identico-legado.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 100,
        storagePath: '/tmp/arquivo-identico-legado.pdf',
      },
      {
        id: 'changed-excluded-source',
        sha256: 'changed-excluded-source-sha',
        originalName: 'fatura-com-autorizacao-corrigida.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 100,
        storagePath: '/tmp/fatura-com-autorizacao-corrigida.pdf',
      },
      {
        id: 'different-id-source',
        sha256: 'different-id-source-sha',
        originalName: 'fatura-com-identidade-diferente.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 100,
        storagePath: '/tmp/fatura-com-identidade-diferente.pdf',
      },
      {
        id: 'live-destination-source',
        sha256: 'live-destination-source-sha',
        originalName: 'destino-alterado-depois-da-revisao.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 100,
        storagePath: '/tmp/destino-alterado-depois-da-revisao.pdf',
      },
      {
        id: 'incompatible-link-source',
        sha256: 'incompatible-link-source-sha',
        originalName: 'fatura-com-vinculo-incompativel.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 100,
        storagePath: '/tmp/fatura-com-vinculo-incompativel.pdf',
      },
      {
        id: 'idempotent-destination-source',
        sha256: 'idempotent-destination-source-sha',
        originalName: 'commit-idempotente.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 100,
        storagePath: '/tmp/commit-idempotente.pdf',
      },
    ])
    await db.insert(schema.creditCards).values([
      {
        id: 'live-destination-card',
        ownershipScopeId: ids.personScope,
        institutionId: ids.institution,
        name: 'Cartão com destino mutável',
        currency: 'BRL',
        lastFour: '4321',
        closingDay: 5,
      },
      {
        id: 'idempotent-destination-card',
        ownershipScopeId: ids.personScope,
        institutionId: ids.institution,
        name: 'Cartão com commit idempotente',
        currency: 'BRL',
        lastFour: '2468',
        closingDay: 5,
      },
    ])
    await db.insert(schema.imports).values([
      {
        id: 'altered-statement-import',
        sourceFileId: 'altered-statement-source',
        creditCardId: ids.card,
        parser: 'pdf_inspector',
        documentKind: 'card_statement',
        periodSource: 'metadata',
        periodStart: '2026-10-01',
        periodEnd: '2026-10-31',
        closingBalanceCents: 1_000,
        closingBalanceType: 'card_statement',
        balanceAsOf: '2026-10-31',
        sourceTransactionCount: 1,
        parsedTransactionCount: 1,
        validationStatus: 'imported',
        validationReason: 'ready',
        status: 'review',
      },
      {
        id: 'missing-statement-import',
        sourceFileId: 'missing-statement-source',
        creditCardId: ids.card,
        parser: 'pdf_inspector',
        documentKind: 'card_statement',
        periodSource: 'metadata',
        periodStart: '2026-11-01',
        periodEnd: '2026-11-30',
        closingBalanceCents: 1_000,
        closingBalanceType: 'card_statement',
        balanceAsOf: '2026-11-30',
        sourceTransactionCount: 1,
        parsedTransactionCount: 1,
        validationStatus: 'imported',
        validationReason: 'ready',
        status: 'review',
      },
      {
        id: 'open-statement-import',
        sourceFileId: 'open-statement-source',
        creditCardId: ids.card,
        parser: 'pdf_inspector',
        documentKind: 'card_statement',
        periodSource: 'metadata',
        periodStart: '2026-12-01',
        periodEnd: '2026-12-31',
        sourceTransactionCount: 1,
        parsedTransactionCount: 1,
        validationStatus: 'divergent',
        validationReason: 'missing_statement_transactions',
        status: 'review',
      },
      {
        id: 'quarantined-open-statement-import',
        sourceFileId: 'quarantined-open-statement-source',
        creditCardId: ids.card,
        parser: 'pdf_inspector',
        documentKind: 'card_statement',
        periodSource: 'metadata',
        periodStart: '2027-01-01',
        periodEnd: '2027-01-31',
        sourceTransactionCount: 1,
        parsedTransactionCount: 1,
        validationStatus: 'divergent',
        validationReason: 'blocked',
        validationMessage: 'A extração ficou em quarentena.',
        status: 'review',
      },
      {
        id: 'legacy-identical-import',
        sourceFileId: 'legacy-identical-source',
        accountId: ids.brlAccount,
        parser: 'pdf_inspector',
        documentKind: 'bank_statement',
        periodSource: 'metadata',
        periodStart: '2027-02-01',
        periodEnd: '2027-02-28',
        validationStatus: 'divergent',
        validationReason: null,
        validationMessage:
          'O mesmo arquivo já foi associado a outro destino. O lote foi bloqueado.',
        status: 'review',
      },
      {
        id: 'changed-excluded-import',
        sourceFileId: 'changed-excluded-source',
        creditCardId: ids.card,
        parser: 'pdf_inspector',
        documentKind: 'card_statement',
        periodSource: 'metadata',
        periodStart: '2027-03-01',
        periodEnd: '2027-03-31',
        closingBalanceCents: 1_200,
        closingBalanceType: 'card_statement',
        balanceAsOf: '2027-03-31',
        sourceTransactionCount: 1,
        parsedTransactionCount: 1,
        totalDebitsCents: 1_200,
        netMovementCents: -1_200,
        validationStatus: 'imported',
        validationReason: 'ready',
        status: 'review',
      },
      {
        id: 'different-id-import',
        sourceFileId: 'different-id-source',
        creditCardId: ids.card,
        parser: 'pdf_inspector',
        documentKind: 'card_statement',
        periodSource: 'metadata',
        periodStart: '2027-04-01',
        periodEnd: '2027-04-30',
        sourceTransactionCount: 1,
        parsedTransactionCount: 1,
        validationStatus: 'divergent',
        validationReason: 'missing_statement_transactions',
        status: 'review',
      },
      {
        id: 'live-destination-import',
        sourceFileId: 'live-destination-source',
        creditCardId: 'live-destination-card',
        parser: 'pdf_inspector',
        documentKind: 'card_statement',
        detectedLastFour: '4321',
        periodSource: 'metadata',
        periodStart: '2027-07-01',
        periodEnd: '2027-07-31',
        validationStatus: 'imported',
        validationReason: 'ready',
        status: 'review',
      },
      {
        id: 'incompatible-link-import',
        sourceFileId: 'incompatible-link-source',
        creditCardId: ids.card,
        parser: 'pdf_inspector',
        documentKind: 'card_statement',
        periodSource: 'metadata',
        periodStart: '2027-08-01',
        periodEnd: '2027-08-31',
        sourceTransactionCount: 1,
        parsedTransactionCount: 1,
        validationStatus: 'divergent',
        validationReason: 'statement_match_candidates',
        status: 'review',
      },
      {
        id: 'idempotent-destination-import',
        sourceFileId: 'idempotent-destination-source',
        creditCardId: 'idempotent-destination-card',
        parser: 'pdf_inspector',
        documentKind: 'card_statement',
        detectedLastFour: '2468',
        periodSource: 'metadata',
        periodStart: '2027-09-01',
        periodEnd: '2027-09-30',
        validationStatus: 'imported',
        validationReason: 'ready',
        status: 'review',
      },
    ])
    await db.insert(schema.stagedTransactions).values([
      {
        id: 'altered-statement-observation',
        importId: 'altered-statement-import',
        fingerprint: 'altered-statement-observation-fingerprint',
        postedAt: '2026-10-10',
        description: 'Compra corrigida no PDF',
        normalizedDescription: 'compra corrigida no pdf',
        amountCents: -1_000,
        currency: 'BRL',
      },
      {
        id: 'missing-statement-observation',
        importId: 'missing-statement-import',
        fingerprint: 'missing-statement-observation-fingerprint',
        postedAt: '2026-11-10',
        description: 'Compra presente no PDF',
        normalizedDescription: 'compra presente no pdf',
        amountCents: -1_000,
        currency: 'BRL',
      },
      {
        id: 'open-statement-observation',
        importId: 'open-statement-import',
        fingerprint: 'open-statement-observation-fingerprint',
        postedAt: '2026-12-10',
        description: 'Compra presente na fatura aberta',
        normalizedDescription: 'compra presente na fatura aberta',
        amountCents: -1_000,
        currency: 'BRL',
      },
      {
        id: 'quarantined-open-statement-observation',
        importId: 'quarantined-open-statement-import',
        fingerprint: 'quarantined-open-statement-observation-fingerprint',
        postedAt: '2027-01-10',
        description: 'Compra presente na extração em quarentena',
        normalizedDescription: 'compra presente na extracao em quarentena',
        amountCents: -1_000,
        currency: 'BRL',
      },
      {
        id: 'changed-excluded-observation',
        importId: 'changed-excluded-import',
        externalId: 'stable-authorization-id',
        fingerprint: 'changed-excluded-observation-fingerprint',
        postedAt: '2027-03-10',
        description: 'Compra corrigida na fatura definitiva',
        normalizedDescription: 'compra corrigida na fatura definitiva',
        amountCents: -1_200,
        currency: 'BRL',
      },
      {
        id: 'different-id-observation',
        importId: 'different-id-import',
        externalId: 'statement-identity',
        fingerprint: 'different-id-observation-fingerprint',
        postedAt: '2027-04-10',
        description: 'Compra com identidade da fatura',
        normalizedDescription: 'compra com identidade da fatura',
        amountCents: -1_000,
        currency: 'BRL',
      },
      {
        id: 'incompatible-link-observation',
        importId: 'incompatible-link-import',
        externalId: 'statement-link-id',
        fingerprint: 'incompatible-link-observation-fingerprint',
        postedAt: '2027-08-10',
        description: 'Compra corrigida na fatura',
        normalizedDescription: 'compra corrigida na fatura',
        amountCents: -1_000,
        currency: 'BRL',
      },
      {
        id: 'live-destination-observation',
        importId: 'live-destination-import',
        fingerprint: 'live-destination-observation-fingerprint',
        postedAt: '2027-07-10',
        description: 'Compra do destino alterado',
        normalizedDescription: 'compra do destino alterado',
        amountCents: -1_000,
        currency: 'BRL',
      },
    ])
    await db.insert(schema.transactions).values([
      {
        id: 'altered-existing-transaction',
        creditCardId: ids.card,
        fingerprint: 'altered-existing-transaction-fingerprint',
        postedAt: '2026-10-10',
        description: 'Compra antes da correção',
        normalizedDescription: 'compra antes da correcao',
        amountCents: -1_100,
        currency: 'BRL',
        status: 'confirmed',
      },
      {
        id: 'missing-matched-transaction',
        creditCardId: ids.card,
        fingerprint: 'missing-matched-transaction-fingerprint',
        postedAt: '2026-11-10',
        description: 'Compra presente na fatura',
        normalizedDescription: 'compra presente na fatura',
        amountCents: -1_000,
        currency: 'BRL',
        status: 'pending',
      },
      {
        id: 'missing-authorization-transaction',
        creditCardId: ids.card,
        fingerprint: 'missing-authorization-transaction-fingerprint',
        postedAt: '2026-11-11',
        description: 'Autorização que não consta na fatura',
        normalizedDescription: 'autorizacao que nao consta na fatura',
        amountCents: -500,
        currency: 'BRL',
        status: 'pending',
      },
      {
        id: 'open-matched-transaction',
        creditCardId: ids.card,
        fingerprint: 'open-matched-transaction-fingerprint',
        postedAt: '2026-12-10',
        description: 'Compra presente na fatura aberta',
        normalizedDescription: 'compra presente na fatura aberta',
        amountCents: -1_000,
        currency: 'BRL',
        status: 'pending',
      },
      {
        id: 'open-missing-authorization',
        creditCardId: ids.card,
        fingerprint: 'open-missing-authorization-fingerprint',
        postedAt: '2026-12-11',
        description: 'Autorização ausente da fatura aberta',
        normalizedDescription: 'autorizacao ausente da fatura aberta',
        amountCents: -500,
        currency: 'BRL',
        status: 'pending',
      },
      {
        id: 'quarantined-open-matched-transaction',
        creditCardId: ids.card,
        fingerprint: 'quarantined-open-matched-transaction-fingerprint',
        postedAt: '2027-01-10',
        description: 'Compra presente na extração em quarentena',
        normalizedDescription: 'compra presente na extracao em quarentena',
        amountCents: -1_000,
        currency: 'BRL',
        status: 'pending',
      },
      {
        id: 'quarantined-open-missing-authorization',
        creditCardId: ids.card,
        fingerprint: 'quarantined-open-missing-authorization-fingerprint',
        postedAt: '2027-01-11',
        description: 'Autorização ausente da extração em quarentena',
        normalizedDescription: 'autorizacao ausente da extracao em quarentena',
        amountCents: -500,
        currency: 'BRL',
        status: 'pending',
      },
      {
        id: 'changed-excluded-transaction',
        creditCardId: ids.card,
        externalId: 'stable-authorization-id',
        fingerprint: 'changed-excluded-transaction-fingerprint',
        postedAt: '2027-03-10',
        description: 'Autorização antes da correção',
        normalizedDescription: 'autorizacao antes da correcao',
        amountCents: -1_000,
        currency: 'BRL',
        status: 'excluded',
      },
      {
        id: 'different-id-transaction',
        creditCardId: ids.card,
        externalId: 'pending-identity',
        fingerprint: 'different-id-transaction-fingerprint',
        postedAt: '2027-04-10',
        description: 'Compra pendente com outra identidade',
        normalizedDescription: 'compra pendente com outra identidade',
        amountCents: -1_000,
        currency: 'BRL',
        status: 'pending',
      },
      {
        id: 'incompatible-link-transaction',
        creditCardId: ids.card,
        externalId: 'transaction-link-id',
        fingerprint: 'incompatible-link-transaction-fingerprint',
        postedAt: '2027-08-11',
        description: 'Autorização com outra identidade',
        normalizedDescription: 'autorizacao com outra identidade',
        amountCents: -900,
        currency: 'BRL',
        status: 'pending',
      },
      {
        id: 'live-destination-transaction',
        creditCardId: 'live-destination-card',
        fingerprint: 'live-destination-transaction-fingerprint',
        postedAt: '2027-07-11',
        description: 'Autorização do destino alterado',
        normalizedDescription: 'autorizacao do destino alterado',
        amountCents: -900,
        currency: 'BRL',
        status: 'pending',
      },
    ])
    await db.insert(schema.statementExclusions).values({
      id: 'changed-excluded-record',
      importId: 'changed-excluded-import',
      transactionId: 'changed-excluded-transaction',
      previousStatus: 'pending',
      reason: 'A autorização não constava na primeira versão da fatura.',
    })
  })

  afterAll(() => {
    database.close()
  })

  it('persiste ações específicas quando a fatura não cobre os lançamentos existentes', async () => {
    const { db, ids, schema } = database

    await reconcileCsvWithPdfControl({
      importIds: ['altered-statement-import', 'missing-statement-import'],
      targetType: 'card',
      targetId: ids.card,
    })

    const rows = await db
      .select({
        id: schema.imports.id,
        validationReason: schema.imports.validationReason,
      })
      .from(schema.imports)
      .where(
        inArray(schema.imports.id, [
          'altered-statement-import',
          'missing-statement-import',
        ]),
      )

    expect(
      Object.fromEntries(rows.map((row) => [row.id, row.validationReason])),
    ).toEqual({
      'altered-statement-import': 'statement_match_candidates',
      'missing-statement-import': 'missing_statement_transactions',
    })
  })

  it('volta a fatura sem total para imported depois de excluir a autorização ausente', async () => {
    const { db, schema } = database

    await resolveStatementExclusion({
      importId: 'open-statement-import',
      transactionId: 'open-missing-authorization',
      action: 'exclude',
    })

    const row = await db
      .select({
        validationStatus: schema.imports.validationStatus,
        validationReason: schema.imports.validationReason,
      })
      .from(schema.imports)
      .where(eq(schema.imports.id, 'open-statement-import'))
      .limit(1)

    expect(row[0]).toEqual({
      validationStatus: 'imported',
      validationReason: 'needs_balance',
    })
  })

  it('recusa excluir uma autorização de uma extração em quarentena', async () => {
    const { db, schema } = database

    await expect(
      resolveStatementExclusion({
        importId: 'quarantined-open-statement-import',
        transactionId: 'quarantined-open-missing-authorization',
        action: 'exclude',
      }),
    ).rejects.toThrow(
      'Esta importação está bloqueada por uma validação obrigatória.',
    )

    const [row, transaction] = await Promise.all([
      db
        .select({
          validationStatus: schema.imports.validationStatus,
          validationReason: schema.imports.validationReason,
        })
        .from(schema.imports)
        .where(eq(schema.imports.id, 'quarantined-open-statement-import'))
        .limit(1),
      db
        .select({ status: schema.transactions.status })
        .from(schema.transactions)
        .where(
          eq(schema.transactions.id, 'quarantined-open-missing-authorization'),
        )
        .limit(1),
    ])

    expect.soft(row[0]).toEqual({
      validationStatus: 'divergent',
      validationReason: 'blocked',
    })
    expect.soft(transaction[0]?.status).toBe('pending')
    await expect(
      commitImport('quarantined-open-statement-import'),
    ).rejects.toThrow(
      'Esta importação está bloqueada por uma validação obrigatória.',
    )
  })

  it('mantém arquivo idêntico legado bloqueado e orientado pelo motivo efetivo', async () => {
    const snapshot = await getImportReviewSnapshot()
    const legacyImport = snapshot.imports.find(
      (item) => item.id === 'legacy-identical-import',
    )

    expect(legacyImport?.reasonCode).toBe('identical_file')
    expect(legacyImport?.guidance.kind).toBe('identical_file')
    await expect(commitImport('legacy-identical-import')).rejects.toThrow(
      'Esta importação está bloqueada por uma validação obrigatória.',
    )
  })

  it('recusa o commit quando um conflito de destino surge após a revisão', async () => {
    const { db, schema } = database
    await db
      .update(schema.creditCards)
      .set({ lastFour: '9876' })
      .where(eq(schema.creditCards.id, 'live-destination-card'))

    const snapshot = await getImportReviewSnapshot()
    const importItem = snapshot.imports.find(
      (item) => item.id === 'live-destination-import',
    )
    const persisted = await db
      .select({ validationStatus: schema.imports.validationStatus })
      .from(schema.imports)
      .where(eq(schema.imports.id, 'live-destination-import'))
      .limit(1)

    expect(importItem).toMatchObject({
      validationStatus: 'divergent',
      validationReason: 'destination_conflict',
      validationMessage:
        'O tipo de documento não corresponde ao destino selecionado.',
      reasonCode: 'destination_conflict',
      guidance: { kind: 'destination_conflict' },
    })
    expect(persisted[0]?.validationStatus).toBe('imported')
    await expect(commitImport('live-destination-import')).rejects.toThrow(
      'Esta importação está bloqueada por uma validação obrigatória.',
    )
  })

  it('recusa vincular uma observação quando o cartão mudou após o staging', async () => {
    const { db, schema } = database
    await db
      .update(schema.creditCards)
      .set({ lastFour: '9876' })
      .where(eq(schema.creditCards.id, 'live-destination-card'))

    await expect(
      linkStatementObservation({
        stagedTransactionId: 'live-destination-observation',
        transactionId: 'live-destination-transaction',
      }),
    ).rejects.toThrow(
      'Esta importação está bloqueada por uma validação obrigatória.',
    )

    const transaction = await db
      .select({ amountCents: schema.transactions.amountCents })
      .from(schema.transactions)
      .where(eq(schema.transactions.id, 'live-destination-transaction'))
      .limit(1)
    expect(transaction[0]?.amountCents).toBe(-900)
  })

  it('mantém o retry do commit idempotente após o cartão mudar', async () => {
    const { db, schema } = database

    await expect(
      commitImport('idempotent-destination-import'),
    ).resolves.toMatchObject({ reused: false })
    await db
      .update(schema.creditCards)
      .set({ lastFour: '1357' })
      .where(eq(schema.creditCards.id, 'idempotent-destination-card'))

    await expect(
      commitImport('idempotent-destination-import'),
    ).resolves.toEqual({ committed: 0, reused: true })
    await expect(
      retryImportFinalization('idempotent-destination-import'),
    ).rejects.toThrow(
      'Esta importação está bloqueada por uma validação obrigatória.',
    )
  })

  it('aplica o bloqueio ao vivo às demais ações da revisão', async () => {
    const { db, schema } = database
    await db
      .update(schema.creditCards)
      .set({ lastFour: '9876' })
      .where(eq(schema.creditCards.id, 'live-destination-card'))

    await expect(
      resolveStatementExclusion({
        importId: 'live-destination-import',
        transactionId: 'live-destination-transaction',
        action: 'exclude',
      }),
    ).rejects.toThrow(
      'Esta importação está bloqueada por uma validação obrigatória.',
    )
    await expect(
      replaceConflictingCheckpoint('live-destination-import'),
    ).rejects.toThrow(
      'Esta importação está bloqueada por uma validação obrigatória.',
    )
    await expect(
      confirmImportCoverage({
        importId: 'live-destination-import',
        periodStart: '2027-07-01',
        periodEnd: '2027-07-31',
      }),
    ).rejects.toThrow(
      'Esta importação está bloqueada por uma validação obrigatória.',
    )
  })

  it('mantém em revisão uma autorização excluída que reaparece alterada e fixa a candidata pela identidade', async () => {
    const { db, ids, schema } = database

    await reconcileCsvWithPdfControl({
      importIds: ['changed-excluded-import'],
      targetType: 'card',
      targetId: ids.card,
    })

    const snapshot = await getImportReviewSnapshot()
    const item = snapshot.imports.find(
      (candidate) => candidate.id === 'changed-excluded-import',
    )
    const persisted = await db
      .select({ status: schema.imports.status })
      .from(schema.imports)
      .where(eq(schema.imports.id, 'changed-excluded-import'))
      .limit(1)

    expect(persisted[0]?.status).toBe('review')
    expect(item?.statementDifferenceRows).toHaveLength(1)
    expect(item?.statementDifferenceRows[0]).toMatchObject({
      observation: { id: 'changed-excluded-observation' },
      candidates: [{ id: 'changed-excluded-transaction' }],
    })
  })

  it('restaura e corrige uma autorização excluída que reaparece com a mesma identidade', async () => {
    const { db, schema } = database

    await expect(
      linkStatementObservation({
        stagedTransactionId: 'changed-excluded-observation',
        transactionId: 'changed-excluded-transaction',
      }),
    ).resolves.toEqual({ success: true })

    const [transaction, exclusion, correction, evidence, importRow] =
      await Promise.all([
        db
          .select()
          .from(schema.transactions)
          .where(eq(schema.transactions.id, 'changed-excluded-transaction'))
          .limit(1),
        db
          .select()
          .from(schema.statementExclusions)
          .where(eq(schema.statementExclusions.id, 'changed-excluded-record'))
          .limit(1),
        db
          .select()
          .from(schema.transactionCorrections)
          .where(
            eq(
              schema.transactionCorrections.stagedTransactionId,
              'changed-excluded-observation',
            ),
          )
          .limit(1),
        db
          .select()
          .from(schema.transactionEvidence)
          .where(
            eq(
              schema.transactionEvidence.stagedTransactionId,
              'changed-excluded-observation',
            ),
          )
          .limit(1),
        db
          .select()
          .from(schema.imports)
          .where(eq(schema.imports.id, 'changed-excluded-import'))
          .limit(1),
      ])

    expect(transaction[0]).toMatchObject({
      externalId: 'stable-authorization-id',
      postedAt: '2027-03-10',
      description: 'Compra corrigida na fatura definitiva',
      amountCents: -1_200,
      status: 'pending',
    })
    expect(exclusion[0]?.reversedAt).toBeInstanceOf(Date)
    expect(correction[0]).toMatchObject({
      transactionId: 'changed-excluded-transaction',
      status: 'accepted',
    })
    expect(evidence[0]?.matchKind).toBe('manual_correction')
    expect(importRow[0]).toMatchObject({
      validationStatus: 'reconciled',
      validationReason: 'ready',
    })
  })

  it('mantém a fatura divergente enquanto resta outro par de mesma identidade alterado', async () => {
    const { db, ids, schema } = database

    await db.insert(schema.sourceFiles).values({
      id: 'two-changes-source',
      sha256: 'two-changes-source-sha',
      originalName: 'fatura-com-duas-correcoes.pdf',
      mediaType: 'application/pdf',
      sizeBytes: 100,
      storagePath: '/tmp/fatura-com-duas-correcoes.pdf',
    })
    await db.insert(schema.imports).values({
      id: 'two-changes-import',
      sourceFileId: 'two-changes-source',
      creditCardId: ids.card,
      parser: 'pdf_inspector',
      documentKind: 'card_statement',
      periodSource: 'metadata',
      periodStart: '2027-05-01',
      periodEnd: '2027-05-31',
      closingBalanceCents: 3_000,
      closingBalanceType: 'card_statement',
      balanceAsOf: '2027-05-31',
      sourceTransactionCount: 2,
      parsedTransactionCount: 2,
      totalDebitsCents: 3_000,
      netMovementCents: -3_000,
      validationStatus: 'divergent',
      validationReason: 'statement_match_candidates',
      status: 'review',
    })
    await db.insert(schema.stagedTransactions).values([
      {
        id: 'two-changes-observation-a',
        importId: 'two-changes-import',
        externalId: 'two-changes-a',
        fingerprint: 'two-changes-observation-a-fingerprint',
        postedAt: '2027-05-10',
        description: 'Primeira compra corrigida',
        normalizedDescription: 'primeira compra corrigida',
        amountCents: -1_000,
        currency: 'BRL',
      },
      {
        id: 'two-changes-observation-b',
        importId: 'two-changes-import',
        externalId: 'two-changes-b',
        fingerprint: 'two-changes-observation-b-fingerprint',
        postedAt: '2027-05-11',
        description: 'Segunda compra corrigida',
        normalizedDescription: 'segunda compra corrigida',
        amountCents: -2_000,
        currency: 'BRL',
      },
    ])
    await db.insert(schema.transactions).values([
      {
        id: 'two-changes-transaction-a',
        creditCardId: ids.card,
        externalId: 'two-changes-a',
        fingerprint: 'two-changes-transaction-a-fingerprint',
        postedAt: '2027-05-10',
        description: 'Primeira autorização',
        normalizedDescription: 'primeira autorizacao',
        amountCents: -900,
        currency: 'BRL',
        status: 'pending',
      },
      {
        id: 'two-changes-transaction-b',
        creditCardId: ids.card,
        externalId: 'two-changes-b',
        fingerprint: 'two-changes-transaction-b-fingerprint',
        postedAt: '2027-05-11',
        description: 'Segunda autorização',
        normalizedDescription: 'segunda autorizacao',
        amountCents: -1_900,
        currency: 'BRL',
        status: 'pending',
      },
    ])

    await linkStatementObservation({
      stagedTransactionId: 'two-changes-observation-a',
      transactionId: 'two-changes-transaction-a',
    })

    const persisted = await db
      .select({
        validationStatus: schema.imports.validationStatus,
        validationReason: schema.imports.validationReason,
      })
      .from(schema.imports)
      .where(eq(schema.imports.id, 'two-changes-import'))
      .limit(1)
    const snapshot = await getImportReviewSnapshot()
    const item = snapshot.imports.find(
      (candidate) => candidate.id === 'two-changes-import',
    )

    expect(persisted[0]).toEqual({
      validationStatus: 'divergent',
      validationReason: 'statement_match_candidates',
    })
    expect(item?.statementDifferenceRows).toHaveLength(1)
    expect(item?.statementDifferenceRows[0]).toMatchObject({
      observation: { id: 'two-changes-observation-b' },
      candidates: [{ id: 'two-changes-transaction-b' }],
    })
  })

  it('não oferece uma transação com identidade externa incompatível', async () => {
    const snapshot = await getImportReviewSnapshot()
    const item = snapshot.imports.find(
      (candidate) => candidate.id === 'incompatible-link-import',
    )
    const difference = item?.statementDifferenceRows.find(
      ({ observation }) => observation.id === 'incompatible-link-observation',
    )

    expect(
      difference?.candidates.map((candidate) => candidate.id) ?? [],
    ).not.toContain('incompatible-link-transaction')
  })

  it('recusa vincular fatos bancários com identidades externas diferentes', async () => {
    await expect(
      linkStatementObservation({
        stagedTransactionId: 'incompatible-link-observation',
        transactionId: 'incompatible-link-transaction',
      }),
    ).rejects.toThrow('identificadores externos diferentes')
  })

  it('lista e permite excluir um pendente com os mesmos valores e outra identidade', async () => {
    const { db, schema } = database
    const before = await getImportReviewSnapshot()
    const item = before.imports.find(
      (candidate) => candidate.id === 'different-id-import',
    )

    expect(
      item?.statementMissingCandidates.map((candidate) => candidate.id),
    ).toEqual(['different-id-transaction'])

    await expect(
      resolveStatementExclusion({
        importId: 'different-id-import',
        transactionId: 'different-id-transaction',
        action: 'exclude',
      }),
    ).resolves.toEqual({ success: true })

    const transaction = await db
      .select({ status: schema.transactions.status })
      .from(schema.transactions)
      .where(eq(schema.transactions.id, 'different-id-transaction'))
      .limit(1)
    expect(transaction[0]?.status).toBe('excluded')
  })

  it('persiste conflito de destino quando o CSV pertence a outra conta', async () => {
    const { db, ids, schema } = database
    await db
      .update(schema.accounts)
      .set({ externalId: 'account-1234' })
      .where(eq(schema.accounts.id, ids.brlAccount))
    const file = new File(
      [
        [
          'Conta;9876',
          'Data,Valor,Identificador,Descrição',
          '2027-06-10,-10.00,csv-destination-conflict,Compra',
        ].join('\n'),
      ],
      'conta-diferente-2027-06.csv',
      { type: 'text/csv' },
    )

    await expect(
      stageImport({
        file,
        targetType: 'account',
        targetId: ids.brlAccount,
        aiConsent: false,
      }),
    ).rejects.toThrow('diferente do destino selecionado')

    const snapshot = await getImportReviewSnapshot()
    const item = snapshot.imports.find(
      (candidate) =>
        candidate.sourceFile?.originalName === 'conta-diferente-2027-06.csv',
    )
    if (item?.sourceFile) {
      await unlink(item.sourceFile.storagePath).catch(() => undefined)
    }

    expect(item).toMatchObject({
      status: 'failed',
      validationStatus: 'divergent',
      validationReason: 'destination_conflict',
      reasonCode: 'destination_conflict',
      guidance: { kind: 'destination_conflict' },
    })
  })
})
