import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'

import { db, ensureDatabase } from '#/db/index.server'
import * as schema from '#/db/schema'
import {
  duplicateReasonForOutcome,
  resolveImportObservationOutcomes,
} from '#/domain/canonicalization'
import { normalizeDescription } from '#/domain/finance'
import {
  evaluateImportAudit,
  IDENTICAL_FILE_CONFLICT_MESSAGE,
  summarizeImport,
} from '#/domain/import-audit'
import { categorizeTransactionsWithAi } from './ai.server'
import {
  applyHistoricalCategorySuggestions,
  applyTargetCategoryPolicy,
  suggestCategory,
} from './categories.server'
import type { CategorySuggestion } from './categories.server'
import { transactionFingerprint } from './canonicalization.server'
import {
  getLearnedCoverageTemplates,
  hasReliableCoverage,
  refreshImportBatchCoverage,
  setCoverageInterval,
} from './coverage-lifecycle.server'
import { reconcileCsvWithPdfControl } from './import-control-reconciliation.server'
import {
  readStatement,
  statementReaderDefaults,
  StatementReadError,
} from './statement-reader.server'
import type { StatementReadResult } from './statement-reader.server'

const MAX_FILE_SIZE = 20 * 1024 * 1024
const IDENTICAL_FILE_CONFLICT = {
  reasonCode: 'identical_file' as const,
  message: IDENTICAL_FILE_CONFLICT_MESSAGE,
  warning:
    'Este arquivo idêntico já foi usado em outro destino. Confirme a conta ou o cartão antes de consolidar.',
}
export type StageImportBatchInput = {
  files: File[]
  targetType: 'account' | 'card'
  targetId: string
  aiConsent: boolean
}

export type InvalidStageImportFormDataCode =
  'files_required' | 'invalid_target_type' | 'target_required'

const stageImportFormDataMessages: Record<
  InvalidStageImportFormDataCode,
  string
> = {
  files_required: 'Selecione pelo menos um arquivo.',
  invalid_target_type: 'Destino inválido.',
  target_required: 'Selecione uma conta ou cartão.',
}

export class InvalidStageImportFormDataError extends Error {
  readonly code: InvalidStageImportFormDataCode

  constructor(code: InvalidStageImportFormDataCode) {
    super(stageImportFormDataMessages[code])
    this.name = 'InvalidStageImportFormDataError'
    this.code = code
  }
}

export function parseStageImportFormData(
  data: FormData,
): StageImportBatchInput {
  const files = [...data.getAll('files'), ...data.getAll('file')].filter(
    (file): file is File => file instanceof File && file.size > 0,
  )
  const targetType = data.get('targetType')
  const targetId = data.get('targetId')
  if (!files.length) {
    throw new InvalidStageImportFormDataError('files_required')
  }
  if (targetType !== 'account' && targetType !== 'card') {
    throw new InvalidStageImportFormDataError('invalid_target_type')
  }
  if (typeof targetId !== 'string' || !targetId) {
    throw new InvalidStageImportFormDataError('target_required')
  }
  return {
    files,
    targetType,
    targetId,
    aiConsent: data.get('aiConsent') === 'true',
  }
}

export function stageImportFormData(data: FormData) {
  return stageImportBatch(parseStageImportFormData(data))
}
type ExistingImportReference = Pick<
  typeof schema.imports.$inferSelect,
  'id' | 'status' | 'accountId' | 'creditCardId'
>

export function resolveIdenticalFileUsage(
  existingImports: ExistingImportReference[],
  targetType: 'account' | 'card',
  targetId: string,
) {
  const activeImports = existingImports.filter(
    (item) => item.status !== 'failed' && item.status !== 'rejected',
  )
  const hasSameDestination = (item: ExistingImportReference) =>
    targetType === 'account'
      ? item.accountId === targetId
      : item.creditCardId === targetId
  const reusableImport = activeImports.find(hasSameDestination)

  return {
    reusableImportId: reusableImport?.id ?? null,
    usedByAnotherDestination: activeImports.some(
      (item) => !hasSameDestination(item),
    ),
  }
}

export function shouldRetryIdenticalFileImport(
  item: Pick<
    typeof schema.imports.$inferSelect,
    'status' | 'validationStatus' | 'validationMessage'
  >,
  usedByAnotherDestination: boolean,
) {
  return (
    !usedByAnotherDestination &&
    item.status === 'review' &&
    item.validationStatus === 'divergent'
  )
}

interface StageImportInput {
  file: File
  targetType: 'account' | 'card'
  targetId: string
  aiConsent: boolean
  batchId?: string
}

async function readStageSource(
  input: StageImportInput,
  buffer: Buffer,
  defaults: ReturnType<typeof statementReaderDefaults>,
) {
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  const existingFile = await db
    .select()
    .from(schema.sourceFiles)
    .where(eq(schema.sourceFiles.sha256, sha256))
    .limit(1)
  let identicalFileUsedElsewhere = false
  if (existingFile[0]) {
    const existingImports = await db
      .select()
      .from(schema.imports)
      .where(eq(schema.imports.sourceFileId, existingFile[0].id))
    const usage = resolveIdenticalFileUsage(
      existingImports,
      input.targetType,
      input.targetId,
    )
    if (usage.reusableImportId) {
      const reusableImport = existingImports.find(
        (item) => item.id === usage.reusableImportId,
      )
      if (
        !reusableImport ||
        !shouldRetryIdenticalFileImport(
          reusableImport,
          usage.usedByAnotherDestination,
        )
      ) {
        return { reused: { importId: usage.reusableImportId, reused: true } }
      }
      await db
        .update(schema.imports)
        .set({ status: 'rejected' })
        .where(eq(schema.imports.id, reusableImport.id))
    }
    identicalFileUsedElsewhere = usage.usedByAnotherDestination
  }

  const accountTarget =
    input.targetType === 'account'
      ? await db
          .select({
            purpose: schema.accounts.purpose,
            scopeName: schema.ownershipScopes.name,
            scopeType: schema.ownershipScopes.type,
            institutionName: schema.institutions.name,
            externalId: schema.accounts.externalId,
            currency: schema.accounts.currency,
          })
          .from(schema.accounts)
          .innerJoin(
            schema.ownershipScopes,
            eq(schema.accounts.ownershipScopeId, schema.ownershipScopes.id),
          )
          .leftJoin(
            schema.institutions,
            eq(schema.accounts.institutionId, schema.institutions.id),
          )
          .where(eq(schema.accounts.id, input.targetId))
          .limit(1)
      : []
  const cardTarget =
    input.targetType === 'card'
      ? await db
          .select({
            scopeName: schema.ownershipScopes.name,
            scopeType: schema.ownershipScopes.type,
            institutionName: schema.institutions.name,
            externalId: schema.creditCards.lastFour,
            currency: schema.creditCards.currency,
          })
          .from(schema.creditCards)
          .innerJoin(
            schema.ownershipScopes,
            eq(schema.creditCards.ownershipScopeId, schema.ownershipScopes.id),
          )
          .leftJoin(
            schema.institutions,
            eq(schema.creditCards.institutionId, schema.institutions.id),
          )
          .where(eq(schema.creditCards.id, input.targetId))
          .limit(1)
      : []
  const rawTarget = accountTarget.at(0) ?? cardTarget.at(0)
  if (!rawTarget) throw new Error('A conta ou o cartão de destino não existe.')
  const target = {
    ...rawTarget,
    purpose: accountTarget[0]?.purpose ?? 'operating',
  }
  const cardInstruments =
    input.targetType === 'card'
      ? await db
          .select({ lastFour: schema.creditCardInstruments.lastFour })
          .from(schema.creditCardInstruments)
          .where(eq(schema.creditCardInstruments.creditCardId, input.targetId))
      : []
  const sourceFileId = existingFile[0]?.id ?? randomUUID()
  const importId = randomUUID()
  const importsDirectory = resolve(process.cwd(), 'data', 'imports')
  await mkdir(importsDirectory, { recursive: true })
  const storagePath = resolve(importsDirectory, sha256)
  await writeFile(storagePath, buffer, { flag: 'wx' }).catch(async (error) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  })
  if (!existingFile[0]) {
    await db.insert(schema.sourceFiles).values({
      id: sourceFileId,
      sha256,
      originalName: input.file.name,
      mediaType: input.file.type || defaults.mediaType,
      sizeBytes: input.file.size,
      storagePath,
    })
  }

  let statement: StatementReadResult | null = null
  try {
    statement = await readStatement({
      buffer,
      filename: input.file.name,
      targetType: input.targetType,
      targetCurrency: target.currency,
      targetInstitution: target.institutionName,
      targetIdentifiers: [
        target.externalId,
        ...cardInstruments.map((item) => item.lastFour),
      ],
      aiConsent: input.aiConsent,
      learnedCoverageTemplates: await getLearnedCoverageTemplates(),
    })
  } catch (error) {
    const failedStatement =
      error instanceof StatementReadError ? error.result : statement
    const message =
      error instanceof Error ? error.message : 'Falha ao interpretar o arquivo.'
    await db.insert(schema.imports).values({
      id: importId,
      sourceFileId,
      batchId: input.batchId ?? null,
      accountId: input.targetType === 'account' ? input.targetId : null,
      creditCardId: input.targetType === 'card' ? input.targetId : null,
      parser: failedStatement?.parser ?? defaults.parser,
      documentKind: failedStatement?.documentKind ?? defaults.documentKind,
      detectedInstitution: failedStatement?.identity.institution ?? null,
      detectedLastFour: failedStatement?.identity.lastFour ?? null,
      detectedCurrency: failedStatement?.identity.currency ?? null,
      pdfType: failedStatement?.diagnostics.pdfType ?? null,
      pdfConfidenceBps: failedStatement?.diagnostics.pdfConfidenceBps ?? null,
      pageCount: failedStatement?.diagnostics.pageCount ?? null,
      pagesNeedingOcrJson:
        failedStatement?.diagnostics.pagesNeedingOcrJson ?? null,
      markdown: failedStatement?.diagnostics.markdown ?? null,
      positionedTextJson:
        failedStatement?.diagnostics.positionedTextJson ?? null,
      extractionDiagnosticsJson:
        failedStatement?.diagnostics.extractionDiagnosticsJson ?? null,
      status: 'failed',
      validationStatus: 'divergent',
      validationReason:
        error instanceof StatementReadError &&
        error.kind === 'identity_mismatch'
          ? 'destination_conflict'
          : 'blocked',
      validationMessage: message,
      aiConsent: input.aiConsent,
      warning: message,
    })
    throw error
  }
  return {
    reused: null,
    sha256,
    sourceFileId,
    importId,
    target,
    statement,
    identicalFileUsedElsewhere,
  }
}

interface PreparedStageObservation {
  item: StatementReadResult['transactions'][number]
  fingerprint: string
  suggestion: CategorySuggestion
}

async function applyAiCategorySuggestions(
  prepared: PreparedStageObservation[],
  targetType: 'account' | 'card',
) {
  const unresolved = prepared.filter(
    ({ suggestion }) => suggestion.categoryId === 'uncategorized',
  )
  if (!unresolved.length) return null
  const [settings, categoryRows] = await Promise.all([
    db.select().from(schema.appSettings).limit(1),
    db
      .select()
      .from(schema.categories)
      .where(eq(schema.categories.active, true)),
  ])
  if (!settings[0]?.aiClassificationConsent) return null
  const allowedCategories = categoryRows.filter(
    (category) =>
      !['uncategorized', 'transfer', 'card_payment'].includes(category.id),
  )
  try {
    const aiSuggestions = await categorizeTransactionsWithAi(
      unresolved.map(({ item, fingerprint }) => ({
        id: fingerprint,
        description: item.description,
        amountCents: item.amountCents,
        currency: item.currency,
        targetType,
      })),
      allowedCategories.map(({ id, name, bucket }) => ({ id, name, bucket })),
    )
    const byTransaction = new Map(
      aiSuggestions.map((suggestion) => [suggestion.transactionId, suggestion]),
    )
    for (const preparedItem of unresolved) {
      const suggestion = byTransaction.get(preparedItem.fingerprint)
      if (suggestion) {
        preparedItem.suggestion = {
          categoryId: suggestion.categoryId,
          confidence: suggestion.confidence,
          source: 'ai',
        }
      }
    }
    return null
  } catch {
    return 'A categorização por IA falhou; os demais lançamentos ficaram sem categoria para revisão.'
  }
}

export async function stageImport(input: StageImportInput) {
  await ensureDatabase()
  if (input.file.size <= 0 || input.file.size > MAX_FILE_SIZE) {
    throw new Error('O arquivo deve ter no máximo 20 MB.')
  }
  const defaults = statementReaderDefaults(input.file.name, input.targetType)

  const buffer = Buffer.from(await input.file.arrayBuffer())
  const source = await readStageSource(input, buffer, defaults)
  if (source.reused) return source.reused
  const {
    sourceFileId,
    importId,
    target,
    statement,
    identicalFileUsedElsewhere,
  } = source
  const parsed = statement.transactions
  const { parser, documentKind, sourceTransactionCount } = statement
  const {
    openingBalanceCents,
    openingBalanceAt,
    closingBalanceCents,
    closingBalanceType,
    balanceAsOf,
    dueDate: statementDueDate,
  } = statement.controls
  const {
    periodStart: statementPeriodStart,
    periodEnd: statementPeriodEnd,
    activityStart,
    activityEnd,
    periodSource,
    confidence: coverageConfidence,
  } = statement.coverage
  const {
    institution: detectedInstitution,
    lastFour: detectedLastFour,
    currency: detectedCurrency,
  } = statement.identity
  const {
    pdfType,
    pdfConfidenceBps,
    pageCount,
    pagesNeedingOcrJson,
    markdown,
    positionedTextJson,
    extractionDiagnosticsJson,
    blockingReason: extractionBlockingReason,
  } = statement.diagnostics
  const targetFilter =
    input.targetType === 'account'
      ? eq(schema.transactions.accountId, input.targetId)
      : eq(schema.transactions.creditCardId, input.targetId)
  const existingTransactions = await db
    .select({
      id: schema.transactions.id,
      importId: schema.transactions.importId,
      fingerprint: schema.transactions.fingerprint,
      externalId: schema.transactions.externalId,
      postedAt: schema.transactions.postedAt,
      amountCents: schema.transactions.amountCents,
      description: schema.transactions.description,
      normalizedDescription: schema.transactions.normalizedDescription,
      currency: schema.transactions.currency,
      status: schema.transactions.status,
    })
    .from(schema.transactions)
    .where(targetFilter)
  const prepared = await Promise.all(
    parsed.map(async (item) => {
      const fingerprint = transactionFingerprint(item)
      let suggestion = await suggestCategory({
        description: item.description,
        amountCents: item.amountCents,
        accountId: input.targetType === 'account' ? input.targetId : null,
        creditCardId: input.targetType === 'card' ? input.targetId : null,
      })
      suggestion = applyTargetCategoryPolicy({
        suggestion,
        amountCents: item.amountCents,
        description: item.description,
        raw: item.raw,
        purpose: target.purpose,
        scopeName: target.scopeName,
        scopeType: target.scopeType,
      })
      return { item, fingerprint, suggestion }
    }),
  )
  const reliableCoverage = hasReliableCoverage({
    periodStart: statementPeriodStart,
    periodEnd: statementPeriodEnd,
    periodSource,
  })
  const duplicateReasons = resolveImportObservationOutcomes({
    observations: prepared.map(({ item, fingerprint }, index) => ({
      id: String(index),
      externalId: item.externalId,
      fingerprint,
    })),
    transactions: existingTransactions.filter(
      (transaction) =>
        Boolean(transaction.externalId) ||
        (reliableCoverage &&
          transaction.postedAt >= statementPeriodStart! &&
          transaction.postedAt <= statementPeriodEnd!),
    ),
  }).map(duplicateReasonForOutcome)

  await applyHistoricalCategorySuggestions(prepared)

  const aiWarning = await applyAiCategorySuggestions(prepared, input.targetType)

  const summary = summarizeImport(parsed, sourceTransactionCount)
  const accountAnchor =
    input.targetType === 'account'
      ? await db
          .select({
            balanceCents: schema.accounts.statementBalanceCents,
            balanceAt: schema.accounts.statementBalanceAt,
          })
          .from(schema.accounts)
          .where(eq(schema.accounts.id, input.targetId))
          .limit(1)
      : []
  const anchor = accountAnchor.at(0)
  const existingMovementCents = anchor?.balanceAt
    ? existingTransactions
        .filter(
          (transaction) =>
            transaction.postedAt > anchor.balanceAt! &&
            (!balanceAsOf || transaction.postedAt <= balanceAsOf),
        )
        .reduce((sum, transaction) => sum + transaction.amountCents, 0)
    : 0
  const newMovementCents =
    input.targetType === 'card'
      ? prepared.reduce((sum, { item }) => sum + item.amountCents, 0)
      : prepared
          .filter(
            ({ item }, index) =>
              !duplicateReasons[index] &&
              (!anchor?.balanceAt || item.postedAt > anchor.balanceAt) &&
              (!balanceAsOf || item.postedAt <= balanceAsOf),
          )
          .reduce((sum, { item }) => sum + item.amountCents, 0)
  const evaluatedAudit = evaluateImportAudit({
    targetType: input.targetType,
    sourceTransactionCount,
    parsedTransactionCount: summary.parsedTransactionCount,
    invalidTransactionCount: summary.invalidTransactionCount,
    openingBalanceCents,
    openingBalanceAt,
    closingBalanceCents:
      closingBalanceType === 'available' ? null : closingBalanceCents,
    balanceAsOf,
    statementPeriodStart,
    anchorBalanceCents: anchor?.balanceCents ?? null,
    anchorBalanceAt: anchor?.balanceAt ?? null,
    existingMovementCents,
    newMovementCents,
    documentMovementCents: prepared.reduce(
      (sum, { item }) => sum + item.amountCents,
      0,
    ),
  })
  const audit = extractionBlockingReason
    ? {
        reasonCode: 'blocked' as const,
        status: 'divergent' as const,
        expectedBalanceCents: evaluatedAudit.expectedBalanceCents,
        balanceDifferenceCents: evaluatedAudit.balanceDifferenceCents,
        message: extractionBlockingReason,
      }
    : identicalFileUsedElsewhere
      ? {
          ...evaluatedAudit,
          reasonCode: IDENTICAL_FILE_CONFLICT.reasonCode,
          status: 'divergent' as const,
          message: IDENTICAL_FILE_CONFLICT.message,
        }
      : evaluatedAudit
  const warnings = [
    identicalFileUsedElsewhere ? IDENTICAL_FILE_CONFLICT.warning : null,
    aiWarning,
  ].filter(Boolean)

  db.transaction((transaction) => {
    transaction
      .insert(schema.imports)
      .values({
        id: importId,
        sourceFileId,
        batchId: input.batchId ?? null,
        accountId: input.targetType === 'account' ? input.targetId : null,
        creditCardId: input.targetType === 'card' ? input.targetId : null,
        parser,
        documentKind,
        detectedInstitution,
        detectedLastFour,
        detectedCurrency,
        pdfType,
        pdfConfidenceBps,
        pageCount,
        pagesNeedingOcrJson,
        markdown,
        positionedTextJson,
        extractionDiagnosticsJson,
        openingBalanceCents,
        openingBalanceAt,
        closingBalanceCents,
        closingBalanceType,
        balanceAsOf,
        ...summary,
        activityStart: activityStart ?? summary.periodStart,
        activityEnd: activityEnd ?? summary.periodEnd,
        periodStart: statementPeriodStart ?? summary.periodStart,
        periodEnd: statementPeriodEnd ?? summary.periodEnd,
        periodSource,
        coverageConfidence,
        statementDueDate,
        expectedBalanceCents: audit.expectedBalanceCents,
        balanceDifferenceCents: audit.balanceDifferenceCents,
        validationStatus: audit.status,
        validationReason: audit.reasonCode,
        validationMessage: audit.message,
        aiConsent: input.aiConsent,
        warning: warnings.join(' ') || null,
      })
      .run()
    if (
      statementPeriodStart &&
      statementPeriodEnd &&
      (periodSource === 'metadata' || periodSource === 'filename')
    ) {
      setCoverageInterval(transaction, {
        importId,
        accountId: input.targetType === 'account' ? input.targetId : null,
        creditCardId: input.targetType === 'card' ? input.targetId : null,
        start: statementPeriodStart,
        end: statementPeriodEnd,
        source: periodSource,
        confidence:
          coverageConfidence === 'unknown' ? 'low' : coverageConfidence,
      })
    }
    for (const [
      index,
      { item, fingerprint, suggestion },
    ] of prepared.entries()) {
      const duplicateReason = duplicateReasons[index]
      const evidence = item.raw as
        { bounds?: { page?: number } & Record<string, unknown> } | undefined
      transaction
        .insert(schema.stagedTransactions)
        .values({
          id: randomUUID(),
          importId,
          externalId: item.externalId || null,
          fingerprint,
          postedAt: item.postedAt,
          description: item.description,
          normalizedDescription: normalizeDescription(item.description),
          amountCents: item.amountCents,
          currency: item.currency,
          suggestedCategoryId: suggestion.categoryId,
          counterpartyAccountId: suggestion.counterpartyAccountId ?? null,
          suggestionConfidence: suggestion.confidence,
          suggestionSource: suggestion.source,
          duplicate: duplicateReason !== null,
          duplicateReason,
          rawJson: item.raw ? JSON.stringify(item.raw) : null,
          sourcePage: evidence?.bounds?.page ?? null,
          sourceBoundsJson: evidence?.bounds
            ? JSON.stringify(evidence.bounds)
            : null,
        })
        .run()
    }
  })
  return { importId, reused: false }
}

export async function stageImportBatch(input: StageImportBatchInput) {
  await ensureDatabase()
  if (!input.files.length) throw new Error('Selecione pelo menos um arquivo.')
  if (input.files.length > 24) {
    throw new Error('Envie no máximo 24 arquivos por lote.')
  }

  const batchId = randomUUID()
  await db.insert(schema.importBatches).values({
    id: batchId,
    accountId: input.targetType === 'account' ? input.targetId : null,
    creditCardId: input.targetType === 'card' ? input.targetId : null,
  })

  const results: Array<{ importId: string; reused: boolean }> = []
  try {
    for (const file of input.files) {
      results.push(
        await stageImport({
          file,
          targetType: input.targetType,
          targetId: input.targetId,
          aiConsent: input.aiConsent,
          batchId,
        }),
      )
    }
  } catch (error) {
    await db
      .update(schema.importBatches)
      .set({ status: 'failed' })
      .where(eq(schema.importBatches.id, batchId))
    throw error
  }

  const allImportIds = [...new Set(results.map((result) => result.importId))]
  await reconcileCsvWithPdfControl({
    importIds: allImportIds,
    targetType: input.targetType,
    targetId: input.targetId,
  })
  const batchCoverage = await refreshImportBatchCoverage({
    batchId,
    importIds: allImportIds,
    mode: 'staged',
  })
  const requiresReview = shouldReviewStagedBatch(
    results,
    batchCoverage?.imports.map((item) => item.status) ?? [],
  )

  return {
    batchId,
    importIds: results.map((result) => result.importId),
    reused: results.filter((result) => result.reused).length,
    requiresReview,
    gaps: batchCoverage?.gaps ?? [],
  }
}

export function shouldReviewStagedBatch(
  _results: Array<{ reused: boolean }>,
  statuses: Array<'review' | 'committed' | 'evidence' | 'rejected' | 'failed'>,
) {
  return statuses.some((status) => status === 'review')
}
