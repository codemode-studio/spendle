import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { statementValueSignature } from '#/domain/canonicalization'
import { openTestDatabase } from '#/test/database'
import type { TestDatabase } from '#/test/database'
import { linkStatementObservation } from './finance.server'
import { getImportReviewSnapshot } from './import-review-read.server'

describe('modelo de leitura da revisão de importação', () => {
  let database: TestDatabase

  beforeAll(async () => {
    database = await openTestDatabase()
    const { db, ids, schema } = database

    await db.insert(schema.sourceFiles).values([
      {
        id: 'review-source',
        sha256: 'review-source-sha',
        originalName: 'fatura.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 100,
        storagePath: '/tmp/review-source.pdf',
      },
      {
        id: 'destination-source',
        sha256: 'destination-source-sha',
        originalName: 'destino.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 100,
        storagePath: '/tmp/destination-source.pdf',
      },
      {
        id: 'difference-source',
        sha256: 'difference-source-sha',
        originalName: 'fatura-divergente.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 100,
        storagePath: '/tmp/difference-source.pdf',
      },
      {
        id: 'open-source',
        sha256: 'open-source-sha',
        originalName: 'fatura-aberta.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 100,
        storagePath: '/tmp/open-source.pdf',
      },
      {
        id: 'quarantine-source',
        sha256: 'quarantine-source-sha',
        originalName: 'fatura-quarentena.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 100,
        storagePath: '/tmp/quarantine-source.pdf',
      },
      {
        id: 'currency-mismatch-source',
        sha256: 'currency-mismatch-source-sha',
        originalName: 'fatura-moeda-divergente.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 100,
        storagePath: '/tmp/currency-mismatch-source.pdf',
      },
    ])
    await db.insert(schema.imports).values([
      {
        id: 'balance-import-a',
        sourceFileId: 'review-source',
        creditCardId: ids.card,
        parser: 'pdf_inspector',
        documentKind: 'card_statement',
        periodSource: 'metadata',
        periodStart: '2026-06-01',
        periodEnd: '2026-06-30',
        closingBalanceCents: 10_000,
        balanceDifferenceCents: 500,
        validationStatus: 'divergent',
        validationMessage: 'O total da fatura não fecha.',
        status: 'review',
      },
      {
        id: 'identical-import-b',
        sourceFileId: 'review-source',
        accountId: ids.brlAccount,
        parser: 'pdf_inspector',
        documentKind: 'bank_statement',
        periodSource: 'metadata',
        periodStart: '2026-06-01',
        periodEnd: '2026-06-30',
        validationStatus: 'divergent',
        validationMessage:
          'O mesmo arquivo já foi associado a outro destino. O lote foi bloqueado.',
        warning:
          'Este arquivo idêntico já foi usado em outro destino. Confirme a conta ou o cartão antes de consolidar.',
        status: 'review',
      },
      {
        id: 'destination-conflict-import',
        sourceFileId: 'destination-source',
        accountId: ids.brlAccount,
        parser: 'pdf_inspector',
        documentKind: 'card_statement',
        periodSource: 'metadata',
        periodStart: '2026-08-01',
        periodEnd: '2026-08-31',
        validationStatus: 'divergent',
        validationMessage: 'Mensagem exibida sem classificação embutida.',
        status: 'review',
      },
      {
        id: 'difference-import',
        sourceFileId: 'difference-source',
        creditCardId: ids.card,
        parser: 'pdf_inspector',
        documentKind: 'card_statement',
        periodSource: 'metadata',
        periodStart: '2026-08-01',
        periodEnd: '2026-08-31',
        parsedTransactionCount: 4,
        validationStatus: 'divergent',
        validationReason: 'missing_statement_transactions',
        validationMessage: 'Há uma diferença real na fatura.',
        status: 'review',
      },
      {
        id: 'open-import',
        sourceFileId: 'open-source',
        creditCardId: ids.card,
        parser: 'pdf_inspector',
        documentKind: 'card_statement',
        periodSource: 'metadata',
        periodStart: '2026-09-01',
        periodEnd: '2026-09-30',
        parsedTransactionCount: 1,
        validationStatus: 'imported',
        validationReason: 'statement_match_candidates',
        validationMessage: 'Fatura aberta importada.',
        status: 'review',
      },
      {
        id: 'quarantined-balance-import',
        sourceFileId: 'quarantine-source',
        creditCardId: ids.card,
        parser: 'pdf_inspector',
        documentKind: 'card_statement',
        periodSource: 'metadata',
        periodStart: '2026-07-01',
        periodEnd: '2026-07-31',
        closingBalanceCents: 12_000,
        balanceAsOf: '2026-07-31',
        balanceDifferenceCents: 500,
        validationStatus: 'divergent',
        validationReason: 'blocked',
        validationMessage: 'A extração ficou em quarentena.',
        status: 'review',
      },
      {
        id: 'currency-mismatch-import',
        sourceFileId: 'currency-mismatch-source',
        creditCardId: ids.card,
        parser: 'pdf_inspector',
        documentKind: 'card_statement',
        periodSource: 'metadata',
        periodStart: '2026-10-01',
        periodEnd: '2026-10-31',
        parsedTransactionCount: 1,
        validationStatus: 'divergent',
        validationReason: 'statement_match_candidates',
        validationMessage: 'A linha da fatura diverge do lançamento atual.',
        status: 'review',
      },
    ])
    await db.insert(schema.stagedTransactions).values([
      {
        id: 'statement-a',
        importId: 'difference-import',
        fingerprint: 'statement-a',
        postedAt: '2026-08-10',
        description: 'Compra A no PDF',
        normalizedDescription: 'compra a no pdf',
        amountCents: -1_000,
        currency: 'BRL',
        suggestedCategoryId: ids.categories.transfer,
      },
      {
        id: 'statement-b',
        importId: 'difference-import',
        fingerprint: 'statement-b',
        postedAt: '2026-08-11',
        description: 'Compra B no PDF',
        normalizedDescription: 'compra b no pdf',
        amountCents: -2_000,
        currency: 'BRL',
        duplicate: true,
        duplicateReason: 'fingerprint_overlap',
      },
      {
        id: 'statement-difference',
        importId: 'difference-import',
        externalId: 'same-id-with-changed-values',
        fingerprint: 'statement-difference',
        postedAt: '2026-08-12',
        description: 'Compra alterada no PDF',
        normalizedDescription: 'compra alterada no pdf',
        amountCents: -3_000,
        currency: 'BRL',
      },
      {
        id: 'statement-without-id-at-old-values',
        importId: 'difference-import',
        fingerprint: 'statement-without-id-at-old-values',
        postedAt: '2026-08-13',
        description: 'Compra sem identificador com valores antigos',
        normalizedDescription: 'compra sem identificador com valores antigos',
        amountCents: -3_200,
        currency: 'BRL',
      },
      {
        id: 'open-observation',
        importId: 'open-import',
        fingerprint: 'open-observation',
        postedAt: '2026-09-10',
        description: 'Compra na fatura aberta',
        normalizedDescription: 'compra na fatura aberta',
        amountCents: -4_000,
        currency: 'BRL',
      },
      {
        id: 'quarantined-observation',
        importId: 'quarantined-balance-import',
        fingerprint: 'quarantined-observation',
        postedAt: '2026-07-10',
        description: 'Compra extraída em quarentena',
        normalizedDescription: 'compra extraida em quarentena',
        amountCents: -5_000,
        currency: 'BRL',
      },
      {
        id: 'currency-mismatch-observation',
        importId: 'currency-mismatch-import',
        externalId: 'currency-mismatch-external-id',
        fingerprint: 'currency-mismatch-observation',
        postedAt: '2026-10-10',
        description: 'Compra em reais no PDF',
        normalizedDescription: 'compra em reais no pdf',
        amountCents: -7_000,
        currency: 'BRL',
      },
    ])
    await db.insert(schema.transactions).values([
      {
        id: 'transaction-a',
        creditCardId: ids.card,
        fingerprint: 'transaction-a',
        postedAt: '2026-08-10',
        description: 'Compra A existente',
        normalizedDescription: 'compra a existente',
        amountCents: -1_000,
        currency: 'BRL',
        status: 'pending',
      },
      {
        id: 'transaction-b',
        creditCardId: ids.card,
        fingerprint: 'transaction-b',
        postedAt: '2026-08-11',
        description: 'Compra B existente',
        normalizedDescription: 'compra b existente',
        amountCents: -2_000,
        currency: 'BRL',
        status: 'pending',
      },
      {
        id: 'transaction-candidate',
        creditCardId: ids.card,
        externalId: 'same-id-with-changed-values',
        fingerprint: 'transaction-candidate',
        postedAt: '2026-08-13',
        description: 'Compra candidata alterada',
        normalizedDescription: 'compra candidata alterada',
        amountCents: -3_100,
        currency: 'BRL',
        status: 'pending',
      },
      {
        id: 'open-candidate',
        creditCardId: ids.card,
        fingerprint: 'open-candidate',
        postedAt: '2026-09-11',
        description: 'Compra pendente parecida',
        normalizedDescription: 'compra pendente parecida',
        amountCents: -4_100,
        currency: 'BRL',
        status: 'confirmed',
      },
      {
        id: 'quarantined-missing-transaction',
        creditCardId: ids.card,
        fingerprint: 'quarantined-missing-transaction',
        postedAt: '2026-07-11',
        description: 'Autorização ausente em quarentena',
        normalizedDescription: 'autorizacao ausente em quarentena',
        amountCents: -6_000,
        currency: 'BRL',
        status: 'pending',
      },
      {
        id: 'currency-mismatch-transaction',
        creditCardId: ids.card,
        externalId: 'currency-mismatch-external-id',
        fingerprint: 'currency-mismatch-transaction',
        postedAt: '2026-10-10',
        description: 'Compra registrada em dólar',
        normalizedDescription: 'compra registrada em dolar',
        amountCents: -7_000,
        currency: 'USD',
        status: 'pending',
      },
    ])
    await db.insert(schema.balanceCheckpoints).values({
      id: 'quarantined-conflicting-checkpoint',
      creditCardId: ids.card,
      kind: 'statement_closing',
      balanceType: 'card_statement',
      source: 'manual',
      reviewState: 'verified',
      balanceCents: 13_000,
      asOf: '2026-07-31',
    })
  })

  afterAll(() => {
    database.close()
  })

  it('consome correspondências exatas antes de expor diferenças', async () => {
    const snapshot = await getImportReviewSnapshot()
    const item = snapshot.imports.find(
      (candidate) => candidate.id === 'difference-import',
    )

    expect(item?.statementDifferenceRows).toHaveLength(1)
    expect(item?.statementMissingCandidates).toEqual([])
    expect(item).toMatchObject({
      reasonCode: 'statement_match_candidates',
      guidance: { kind: 'statement_match_candidates' },
      duplicateCount: 1,
      newCount: 3,
      needsCoverageConfirmation: false,
      hasIncompleteTransfer: true,
      coverageProvenance: {
        source: 'metadata',
        evidence: 'declared_period',
        reliable: true,
      },
    })

    const differenceRow = item?.statementDifferenceRows[0]
    expect(differenceRow?.observation.id).toBe('statement-difference')
    expect(differenceRow?.candidates.map((candidate) => candidate.id)).toEqual([
      'transaction-candidate',
    ])
    expect(
      item?.statementDifferenceRows.find(
        ({ observation }) =>
          observation.id === 'statement-without-id-at-old-values',
      ),
    ).toBeUndefined()
    expect(
      differenceRow?.candidates.every(
        (candidate) =>
          statementValueSignature(candidate) !==
          statementValueSignature(differenceRow.observation),
      ),
    ).toBe(true)
  })

  it('recusa reservar para uma linha sem ID o fato reclamado por outra linha', async () => {
    await expect(
      linkStatementObservation({
        stagedTransactionId: 'statement-without-id-at-old-values',
        transactionId: 'transaction-candidate',
      }),
    ).rejects.toThrow('outra linha desta fatura')
  })

  it('expõe pares de mesma identidade e moedas diferentes como bloqueados', async () => {
    const snapshot = await getImportReviewSnapshot()
    const item = snapshot.imports.find(
      (candidate) => candidate.id === 'currency-mismatch-import',
    )

    expect(item).toMatchObject({
      validationStatus: 'divergent',
      reasonCode: 'blocked',
      guidance: { kind: 'blocked', reason: 'currency_mismatch' },
      statementDifferenceRows: [],
      statementBlockedRows: [
        {
          reason: 'currency_mismatch',
          linkable: false,
          observation: {
            id: 'currency-mismatch-observation',
            currency: 'BRL',
          },
          transaction: {
            id: 'currency-mismatch-transaction',
            currency: 'USD',
          },
        },
      ],
    })
  })

  it('não emite ações de vínculo para uma fatura aberta importada', async () => {
    const snapshot = await getImportReviewSnapshot()
    const item = snapshot.imports.find(
      (candidate) => candidate.id === 'open-import',
    )

    expect(item).toMatchObject({
      validationStatus: 'imported',
      reasonCode: 'needs_balance',
      guidance: { kind: 'needs_balance' },
      statementDifferenceRows: [],
      statementMissingCandidates: [],
    })
  })

  it('atribui conflito apenas ao lote que o persistiu', async () => {
    const snapshot = await getImportReviewSnapshot()

    expect(
      snapshot.imports.find((candidate) => candidate.id === 'balance-import-a'),
    ).toMatchObject({
      reasonCode: 'balance_mismatch',
      guidance: { kind: 'balance_mismatch' },
    })
    expect(
      snapshot.imports.find(
        (candidate) => candidate.id === 'identical-import-b',
      ),
    ).toMatchObject({
      reasonCode: 'identical_file',
      guidance: { kind: 'identical_file' },
    })

    expect(
      snapshot.imports.find(
        (candidate) => candidate.id === 'destination-conflict-import',
      ),
    ).toMatchObject({
      reasonCode: 'destination_conflict',
      guidance: { kind: 'destination_conflict' },
    })
  })

  it('preserva o bloqueio da quarentena mesmo com diferença de saldo', async () => {
    const snapshot = await getImportReviewSnapshot()
    const item = snapshot.imports.find(
      (candidate) => candidate.id === 'quarantined-balance-import',
    )

    expect(item).toMatchObject({
      validationStatus: 'divergent',
      validationReason: 'blocked',
      balanceDifferenceCents: 500,
      reasonCode: 'blocked',
      guidance: { kind: 'blocked' },
      statementDifferenceRows: [],
      statementMissingCandidates: [],
      conflictingCheckpoint: null,
    })
  })
})
