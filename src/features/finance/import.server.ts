import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { and, desc, eq, gte, inArray, lte, or, sql } from 'drizzle-orm'

import { db, ensureDatabase } from '#/db/index.server'
import * as schema from '#/db/schema'
import { parseInstallmentDescription } from '#/domain/credit-card'
import { classifyCheckpointAtDate } from '#/domain/balance-checkpoint'
import {
  canonicalEvidenceKind,
  matchOptionalStatementValues,
  matchStatementValueSubset,
  resolveCanonicalAssignments,
  sameStatementValues,
  statementValueSignature,
} from '#/domain/canonicalization'
import { convertMinorUnitsAtRate } from '#/domain/currency'
import { normalizeDescription } from '#/domain/finance'
import {
  canCommitImportAudit,
  evaluateImportAudit,
  identifyDuplicateReasons,
  summarizeImport,
} from '#/domain/import-audit'
import {
  detectOwnedTransferCategory,
  matchLearnedTransferRule,
} from '#/domain/reconciliation'
import { runPostCommitStep } from '#/domain/post-commit'
import { parseCsvStatement } from './csv-statement.server'
import { categorizeTransactionsWithAi } from './ai.server'
import {
  linkCanonicalObservation,
  transactionFingerprint,
} from './canonicalization.server'
import {
  addBalanceCheckpoint,
  invalidateCheckpointChain,
  refreshStatementAnchor,
  replaceCheckpointChainForImport,
} from './checkpoint-chain.server'
import {
  confirmCoveragePeriod,
  getLearnedCoverageTemplates,
  refreshImportBatchCoverage,
  setCoverageInterval,
} from './coverage-lifecycle.server'
import {
  matchesDocumentLastFour,
  normalizeLastFour,
  readStatement,
  StatementReadError,
} from './statement-reader.server'
import { refreshReconciliationAfterCommit } from './reconciliation-refresh.server'
import type { StatementReadResult } from './statement-reader.server'

const MAX_FILE_SIZE = 20 * 1024 * 1024
const IDENTICAL_FILE_CONFLICT_MESSAGE =
  'O mesmo arquivo já foi associado a outro destino. O lote foi bloqueado.'
const SAME_BATCH_PARTIAL_CSV_WARNING =
  'O PDF definitivo contém movimentações posteriores ao CSV e será a fonte canônica deste período.'
const SAME_BATCH_EXACT_PDF_WARNING =
  'Este PDF será preservado como evidência quando o arquivo estruturado equivalente for consolidado.'

function isDependentBatchEvidence(importRow: {
  dependsOnImportId: string | null
}) {
  return Boolean(importRow.dependsOnImportId)
}

type SuggestionSource =
  'none' | 'rule' | 'history' | 'heuristic' | 'ai' | 'system'

interface CategorySuggestion {
  categoryId: string
  counterpartyAccountId?: string | null
  confidence: number
  source: SuggestionSource
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

async function suggestCategory(
  description: string,
  amountCents: number,
  accountId: string | null,
  creditCardId: string | null,
): Promise<CategorySuggestion> {
  const normalized = normalizeDescription(description)
  const rules = await db.select().from(schema.categorizationRules)
  const learnedTransfer = matchLearnedTransferRule({
    description,
    amountCents,
    sourceAccountId: accountId,
    rules,
  })
  if (learnedTransfer) {
    return {
      ...learnedTransfer,
      confidence: 100,
      source: 'history' as const,
    }
  }
  const direction = amountCents < 0 ? 'outgoing' : 'incoming'
  const rule = rules
    .filter((candidate) => candidate.active)
    .sort((left, right) => left.priority - right.priority)
    .find(
      (candidate) =>
        normalized.includes(candidate.pattern) &&
        (!candidate.accountId || candidate.accountId === accountId) &&
        (!candidate.direction || candidate.direction === direction) &&
        (candidate.minAmountCents === null ||
          Math.abs(amountCents) >= candidate.minAmountCents) &&
        (candidate.maxAmountCents === null ||
          Math.abs(amountCents) <= candidate.maxAmountCents),
    )
  if (rule) {
    return {
      categoryId: rule.categoryId,
      counterpartyAccountId: rule.counterpartyAccountId,
      confidence: 100,
      source: 'rule' as const,
    }
  }

  if (
    creditCardId &&
    amountCents > 0 &&
    /pagamento\s+(?:de\s+)?(?:fatura|recebido)|fatura.*(?:paga|pagamento)/i.test(
      normalized,
    )
  ) {
    return {
      categoryId: 'card_payment',
      confidence: 100,
      source: 'system' as const,
    }
  }

  const heuristics: Array<[RegExp, string]> = [
    [/pagamento.*fatura|fatura.*(?:paga|pagamento)/i, 'card_payment'],
    [/aluguel|condominio|iptu/i, 'housing'],
    [/energia|internet|telefone|agua|gas/i, 'utilities'],
    [/mercado|supermercado|padaria|restaurante|ifood|delivery/i, 'food'],
    [/uber|posto|combustivel|estacionamento|pedagio/i, 'transport'],
    [/farmacia|hospital|clinica|medico|laboratorio/i, 'health'],
    [/escola|curso|faculdade|livro/i, 'education'],
    [/seguro|protecao veicular/i, 'insurance'],
    [/spotify|netflix|amazon prime|assinatura/i, 'subscriptions'],
    [/cinema|show|lazer/i, 'leisure'],
    [/petshop|veterinari|racao/i, 'pets'],
    [/salao|barbear|cosmetic|estetica/i, 'personal_care'],
    [/tarifa|encargo|juros|anuidade|iof/i, 'fees_interest'],
    [
      /dividendo|rendimento|juros sobre capital/i,
      amountCents > 0 ? 'investment_income' : 'uncategorized',
    ],
    [
      /reembolso|restituicao/i,
      amountCents > 0 ? 'reimbursements' : 'uncategorized',
    ],
    [/invest|corretora|aplicacao/i, 'investment'],
    [/salario|pro labore/i, amountCents > 0 ? 'salary' : 'uncategorized'],
    [/imposto|das|darf|gps|tributo/i, 'tax'],
  ]
  const match = heuristics.find(([pattern]) => pattern.test(normalized))
  return {
    categoryId: match?.[1] ?? 'uncategorized',
    confidence: match ? 80 : 0,
    source: match ? ('heuristic' as const) : ('none' as const),
  }
}

export async function stageImport(input: {
  file: File
  targetType: 'account' | 'card'
  targetId: string
  aiConsent: boolean
  batchId?: string
}) {
  await ensureDatabase()
  if (input.file.size <= 0 || input.file.size > MAX_FILE_SIZE) {
    throw new Error('O arquivo deve ter no máximo 20 MB.')
  }
  const extension = input.file.name.split('.').pop()?.toLowerCase()
  if (!['ofx', 'pdf', 'csv'].includes(extension ?? '')) {
    throw new Error('Envie um arquivo OFX, CSV ou PDF.')
  }

  const buffer = Buffer.from(await input.file.arrayBuffer())
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
        return { importId: usage.reusableImportId, reused: true }
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
      mediaType:
        input.file.type ||
        (extension === 'ofx'
          ? 'application/x-ofx'
          : extension === 'csv'
            ? 'text/csv'
            : 'application/pdf'),
      sizeBytes: input.file.size,
      storagePath,
    })
  }

  const defaultParser: StatementReadResult['parser'] =
    extension === 'csv' ? 'csv' : extension === 'pdf' ? 'pdf_inspector' : 'ofx'
  const defaultDocumentKind: StatementReadResult['documentKind'] =
    extension === 'ofx'
      ? input.targetType === 'account'
        ? 'bank_statement'
        : 'card_statement'
      : 'unknown'
  let statement: StatementReadResult | null = null
  try {
    const learnedCoverageTemplates =
      extension === 'csv' ? await getLearnedCoverageTemplates() : []
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
      learnedCoverageTemplates,
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
      parser: failedStatement?.parser ?? defaultParser,
      documentKind: failedStatement?.documentKind ?? defaultDocumentKind,
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
      validationMessage: message,
      aiConsent: input.aiConsent,
      warning: message,
    })
    throw error
  }
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
      let suggestion = await suggestCategory(
        item.description,
        item.amountCents,
        input.targetType === 'account' ? input.targetId : null,
        input.targetType === 'card' ? input.targetId : null,
      )
      const ownedTransferCategory = detectOwnedTransferCategory({
        amountCents: item.amountCents,
        description: item.description,
        raw: item.raw,
        sourceScopeName: target.scopeName,
        sourceScopeType: target.scopeType,
      })
      if (
        ownedTransferCategory &&
        suggestion.source !== 'rule' &&
        !suggestion.counterpartyAccountId
      ) {
        suggestion = {
          categoryId: ownedTransferCategory,
          confidence: 96,
          source: 'system' as const,
        }
      } else if (item.amountCents > 0 && target.purpose === 'reserve') {
        suggestion = {
          categoryId: 'reserve',
          confidence: 100,
          source: 'system' as const,
        }
      } else if (item.amountCents > 0 && target.purpose === 'investment') {
        suggestion = {
          categoryId: 'investment',
          confidence: 100,
          source: 'system' as const,
        }
      } else if (
        target.scopeType === 'company_br' &&
        suggestion.categoryId === 'uncategorized'
      ) {
        suggestion = {
          categoryId: 'business',
          confidence: 70,
          source: 'system' as const,
        }
      }
      return { item, fingerprint, suggestion }
    }),
  )
  const hasReliableCoverage =
    (periodSource === 'metadata' || periodSource === 'filename') &&
    Boolean(statementPeriodStart && statementPeriodEnd)
  const duplicateReasons = identifyDuplicateReasons(
    prepared.map(({ item, fingerprint }) => ({
      externalId: item.externalId,
      fingerprint,
    })),
    existingTransactions.filter(
      (transaction) =>
        Boolean(transaction.externalId) ||
        (hasReliableCoverage &&
          transaction.postedAt >= statementPeriodStart! &&
          transaction.postedAt <= statementPeriodEnd!),
    ),
  )

  const unresolvedDescriptions = [
    ...new Set(
      prepared
        .filter(({ suggestion }) => suggestion.categoryId === 'uncategorized')
        .map(({ item }) => normalizeDescription(item.description)),
    ),
  ]
  if (unresolvedDescriptions.length) {
    const history = await db
      .select({
        normalizedDescription: schema.transactions.normalizedDescription,
        categoryId: schema.transactions.categoryId,
        counterpartyAccountId: schema.transactions.counterpartyAccountId,
      })
      .from(schema.transactions)
      .where(
        inArray(
          schema.transactions.normalizedDescription,
          unresolvedDescriptions,
        ),
      )
      .orderBy(desc(schema.transactions.postedAt))
    const historyByDescription = new Map<
      string,
      { categoryId: string; counterpartyAccountId: string | null }
    >()
    for (const transaction of history) {
      if (
        transaction.categoryId &&
        transaction.categoryId !== 'uncategorized' &&
        !historyByDescription.has(transaction.normalizedDescription)
      ) {
        historyByDescription.set(transaction.normalizedDescription, {
          categoryId: transaction.categoryId,
          counterpartyAccountId: transaction.counterpartyAccountId,
        })
      }
    }
    for (const preparedItem of prepared) {
      if (preparedItem.suggestion.categoryId !== 'uncategorized') continue
      const historical = historyByDescription.get(
        normalizeDescription(preparedItem.item.description),
      )
      if (historical) {
        preparedItem.suggestion = {
          ...historical,
          confidence: 95,
          source: 'history',
        }
      }
    }
  }

  let aiWarning: string | null = null
  const unresolved = prepared.filter(
    ({ suggestion }) => suggestion.categoryId === 'uncategorized',
  )
  if (unresolved.length) {
    const [settings, categoryRows] = await Promise.all([
      db.select().from(schema.appSettings).limit(1),
      db
        .select()
        .from(schema.categories)
        .where(eq(schema.categories.active, true)),
    ])
    if (settings[0]?.aiClassificationConsent) {
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
            targetType: input.targetType,
          })),
          allowedCategories.map(({ id, name, bucket }) => ({
            id,
            name,
            bucket,
          })),
        )
        const byTransaction = new Map(
          aiSuggestions.map((suggestion) => [
            suggestion.transactionId,
            suggestion,
          ]),
        )
        for (const preparedItem of unresolved) {
          const aiSuggestion = byTransaction.get(preparedItem.fingerprint)
          if (aiSuggestion) {
            preparedItem.suggestion = {
              categoryId: aiSuggestion.categoryId,
              confidence: aiSuggestion.confidence,
              source: 'ai',
            }
          }
        }
      } catch {
        aiWarning =
          'A categorização por IA falhou; os demais lançamentos ficaram sem categoria para revisão.'
      }
    }
  }

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
        status: 'divergent' as const,
        expectedBalanceCents: evaluatedAudit.expectedBalanceCents,
        balanceDifferenceCents: evaluatedAudit.balanceDifferenceCents,
        message: extractionBlockingReason,
      }
    : identicalFileUsedElsewhere
      ? {
          ...evaluatedAudit,
          status: 'divergent' as const,
          message: IDENTICAL_FILE_CONFLICT_MESSAGE,
        }
      : evaluatedAudit
  const warnings = [
    identicalFileUsedElsewhere
      ? 'Este arquivo idêntico já foi usado em outro destino. Confirme a conta ou o cartão antes de consolidar.'
      : null,
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

export async function reconcileCsvWithPdfControl(input: {
  importIds: string[]
  targetType: 'account' | 'card'
  targetId: string
  finalize?: boolean
}) {
  if (!input.importIds.length) return
  const [importRows, stagedRows] = await Promise.all([
    db
      .select()
      .from(schema.imports)
      .where(inArray(schema.imports.id, input.importIds)),
    db
      .select()
      .from(schema.stagedTransactions)
      .where(inArray(schema.stagedTransactions.importId, input.importIds)),
  ])
  const stagedByImport = new Map<string, typeof stagedRows>()
  for (const row of stagedRows) {
    const current = stagedByImport.get(row.importId) ?? []
    current.push(row)
    stagedByImport.set(row.importId, current)
  }

  const pdfControls = importRows.filter(
    (item) =>
      item.parser === 'pdf_inspector' &&
      item.status === 'review' &&
      item.validationStatus !== 'divergent' &&
      item.closingBalanceCents !== null &&
      item.closingBalanceType !== 'available' &&
      item.balanceAsOf !== null,
  )
  if (!pdfControls.length) return
  const matchedPdfIds = new Set<string>()
  const canonicalDependencyByImport = new Map(
    importRows.flatMap((item) =>
      item.dependsOnImportId
        ? [[item.id, item.dependsOnImportId] as const]
        : [],
    ),
  )

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
  const existingTransactions =
    input.targetType === 'account'
      ? await db
          .select({
            postedAt: schema.transactions.postedAt,
            amountCents: schema.transactions.amountCents,
          })
          .from(schema.transactions)
          .where(eq(schema.transactions.accountId, input.targetId))
      : []

  for (const csvImport of importRows.filter(
    (item) => item.parser === 'csv' && item.status === 'review',
  )) {
    const csvStaged = stagedByImport.get(csvImport.id) ?? []
    const pdfControl = pdfControls.find((candidate) =>
      sameStatementValues(csvStaged, stagedByImport.get(candidate.id) ?? []),
    )
    if (!pdfControl) {
      if (!csvStaged.length) continue
      const partialPdf = pdfControls.find((candidate) => {
        const result = matchStatementValueSubset(
          stagedByImport.get(candidate.id) ?? [],
          csvStaged,
        )
        return Boolean(result?.unmatched.length)
      })
      if (!partialPdf) continue
      const pdfStaged = stagedByImport.get(partialPdf.id) ?? []
      const partialBalanceAsOf = partialPdf.balanceAsOf!
      const partialExistingMovementCents = anchor?.balanceAt
        ? existingTransactions
            .filter(
              (transaction) =>
                transaction.postedAt > anchor.balanceAt! &&
                transaction.postedAt <= partialBalanceAsOf,
            )
            .reduce((sum, transaction) => sum + transaction.amountCents, 0)
        : 0
      const partialNewMovementCents = pdfStaged
        .filter(
          (transaction) =>
            (!anchor?.balanceAt || transaction.postedAt > anchor.balanceAt) &&
            transaction.postedAt <= partialBalanceAsOf,
        )
        .reduce((total, item) => total + item.amountCents, 0)
      const audit = evaluateImportAudit({
        targetType: input.targetType,
        sourceTransactionCount: partialPdf.sourceTransactionCount,
        parsedTransactionCount: partialPdf.parsedTransactionCount,
        invalidTransactionCount: partialPdf.invalidTransactionCount,
        openingBalanceCents: partialPdf.openingBalanceCents,
        openingBalanceAt: partialPdf.openingBalanceAt,
        closingBalanceCents: partialPdf.closingBalanceCents,
        balanceAsOf: partialPdf.balanceAsOf,
        statementPeriodStart: partialPdf.periodStart,
        anchorBalanceCents: anchor?.balanceCents ?? null,
        anchorBalanceAt: anchor?.balanceAt ?? null,
        existingMovementCents: partialExistingMovementCents,
        newMovementCents: partialNewMovementCents,
        documentMovementCents: pdfStaged.reduce(
          (total, item) => total + item.amountCents,
          0,
        ),
      })
      if (audit.status !== 'reconciled') continue
      const documentLabel = input.targetType === 'card' ? 'fatura' : 'extrato'
      const dependencyId =
        canonicalDependencyByImport.get(partialPdf.id) ?? partialPdf.id
      db.transaction((transaction) => {
        transaction
          .update(schema.imports)
          .set({
            dependsOnImportId: dependencyId,
            validationStatus: 'reconciled',
            validationMessage: `Aguardando a consolidação do ${documentLabel} definitivo. Depois disso, este CSV parcial será preservado como evidência dos lançamentos já vistos.`,
            warning: SAME_BATCH_PARTIAL_CSV_WARNING,
          })
          .where(eq(schema.imports.id, csvImport.id))
          .run()
        transaction
          .update(schema.imports)
          .set({
            validationStatus: 'reconciled',
            validationMessage: `${documentLabel === 'fatura' ? 'Fatura definitiva reconciliada' : 'Extrato definitivo reconciliado'}. O documento inclui os lançamentos do CSV parcial e as movimentações ocorridas depois da última exportação.`,
            expectedBalanceCents: audit.expectedBalanceCents,
            balanceDifferenceCents: audit.balanceDifferenceCents,
            warning:
              'Ao consolidar, o PDF será canônico e o CSV parcial permanecerá ligado como evidência, sem duplicar lançamentos.',
          })
          .where(eq(schema.imports.id, partialPdf.id))
          .run()
      })
      canonicalDependencyByImport.set(csvImport.id, dependencyId)
      continue
    }

    const balanceAsOf = pdfControl.balanceAsOf!
    const existingMovementCents = anchor?.balanceAt
      ? existingTransactions
          .filter(
            (transaction) =>
              transaction.postedAt > anchor.balanceAt! &&
              transaction.postedAt <= balanceAsOf,
          )
          .reduce((sum, transaction) => sum + transaction.amountCents, 0)
      : 0
    const newMovementCents = csvStaged
      .filter(
        (transaction) =>
          (!anchor?.balanceAt || transaction.postedAt > anchor.balanceAt) &&
          transaction.postedAt <= balanceAsOf,
      )
      .reduce((sum, transaction) => sum + transaction.amountCents, 0)
    const audit = evaluateImportAudit({
      targetType: input.targetType,
      sourceTransactionCount: csvImport.sourceTransactionCount,
      parsedTransactionCount: csvImport.parsedTransactionCount,
      invalidTransactionCount: csvImport.invalidTransactionCount,
      openingBalanceCents: pdfControl.openingBalanceCents,
      openingBalanceAt: pdfControl.openingBalanceAt,
      closingBalanceCents: pdfControl.closingBalanceCents,
      balanceAsOf,
      statementPeriodStart: pdfControl.periodStart ?? csvImport.periodStart,
      anchorBalanceCents: anchor?.balanceCents ?? null,
      anchorBalanceAt: anchor?.balanceAt ?? null,
      existingMovementCents,
      newMovementCents,
      documentMovementCents: csvStaged.reduce(
        (sum, transaction) => sum + transaction.amountCents,
        0,
      ),
    })
    if (audit.status !== 'reconciled') continue

    db.transaction((transaction) => {
      transaction
        .update(schema.imports)
        .set({
          openingBalanceCents: pdfControl.openingBalanceCents,
          openingBalanceAt: pdfControl.openingBalanceAt,
          closingBalanceCents: pdfControl.closingBalanceCents,
          closingBalanceType: pdfControl.closingBalanceType,
          balanceAsOf,
          periodStart: pdfControl.periodStart ?? csvImport.periodStart,
          periodEnd: pdfControl.periodEnd ?? csvImport.periodEnd,
          statementDueDate: pdfControl.statementDueDate,
          expectedBalanceCents: audit.expectedBalanceCents,
          balanceDifferenceCents: audit.balanceDifferenceCents,
          validationStatus: audit.status,
          validationMessage: `${audit.message} Valores conferidos contra o PDF enviado no mesmo lote.`,
          warning:
            'O CSV é a fonte canônica dos lançamentos; o PDF foi preservado como evidência de controle.',
        })
        .where(eq(schema.imports.id, csvImport.id))
        .run()
      transaction
        .update(schema.imports)
        .set({
          dependsOnImportId: csvImport.id,
          validationMessage:
            'Aguardando a consolidação do arquivo estruturado equivalente. Depois disso, este PDF será preservado como evidência do saldo informado.',
          warning: SAME_BATCH_EXACT_PDF_WARNING,
        })
        .where(eq(schema.imports.id, pdfControl.id))
        .run()
      transaction
        .update(schema.imports)
        .set({ dependsOnImportId: csvImport.id })
        .where(
          and(
            eq(schema.imports.dependsOnImportId, pdfControl.id),
            eq(schema.imports.status, 'review'),
          ),
        )
        .run()
    })
    canonicalDependencyByImport.set(pdfControl.id, csvImport.id)
    for (const [dependentId, dependencyId] of canonicalDependencyByImport) {
      if (dependencyId === pdfControl.id) {
        canonicalDependencyByImport.set(dependentId, csvImport.id)
      }
    }
    matchedPdfIds.add(pdfControl.id)
  }

  const remainingPdfControls = pdfControls.filter(
    (item) =>
      !matchedPdfIds.has(item.id) &&
      item.periodStart &&
      item.periodEnd &&
      ['metadata', 'filename', 'user'].includes(item.periodSource),
  )
  if (!remainingPdfControls.length) return

  const loadTargetCheckpoints = () =>
    db
      .select()
      .from(schema.balanceCheckpoints)
      .where(
        input.targetType === 'account'
          ? eq(schema.balanceCheckpoints.accountId, input.targetId)
          : eq(schema.balanceCheckpoints.creditCardId, input.targetId),
      )

  if (input.targetType === 'account') {
    const [priorTransactions, accountRows] = await Promise.all([
      db
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.accountId, input.targetId)),
      db
        .select({
          balanceCents: schema.accounts.statementBalanceCents,
          balanceAt: schema.accounts.statementBalanceAt,
          coverageStart: schema.accounts.coverageStart,
        })
        .from(schema.accounts)
        .where(eq(schema.accounts.id, input.targetId))
        .limit(1),
    ])
    const account = accountRows.at(0)
    for (const pdfControl of remainingPdfControls) {
      const checkpointAtDate = classifyCheckpointAtDate(
        await loadTargetCheckpoints(),
        {
          balanceType: 'posted',
          balanceCents: pdfControl.closingBalanceCents!,
          asOf: pdfControl.balanceAsOf!,
        },
      )
      if (checkpointAtDate.status === 'conflict') {
        await db
          .update(schema.imports)
          .set({
            validationStatus: 'divergent',
            validationMessage:
              'Já existe outro saldo contábil ativo para esta conta na mesma data. Invalide o ponto anterior antes de consolidar este extrato.',
          })
          .where(eq(schema.imports.id, pdfControl.id))
        continue
      }
      const pdfStaged = stagedByImport.get(pdfControl.id) ?? []
      const canonicalInPeriod = priorTransactions.filter(
        (transaction) =>
          transaction.status !== 'excluded' &&
          transaction.postedAt >= pdfControl.periodStart! &&
          transaction.postedAt <= pdfControl.periodEnd!,
      )
      const excludedInPeriod = priorTransactions.filter(
        (transaction) =>
          transaction.status === 'excluded' &&
          transaction.postedAt >= pdfControl.periodStart! &&
          transaction.postedAt <= pdfControl.periodEnd!,
      )
      if (!canonicalInPeriod.length && !excludedInPeriod.length) continue
      let resolution = canonicalInPeriod.length
        ? matchStatementValueSubset(pdfStaged, canonicalInPeriod)
        : { matches: [], unmatched: pdfStaged }
      if (resolution) {
        const restored = matchOptionalStatementValues(
          resolution.unmatched,
          excludedInPeriod,
        )
        resolution = {
          matches: [...resolution.matches, ...restored.matches],
          unmatched: restored.unmatched,
        }
      }
      const existingMovementCents = account?.balanceAt
        ? priorTransactions
            .filter(
              (transaction) =>
                transaction.status === 'confirmed' &&
                transaction.postedAt > account.balanceAt! &&
                transaction.postedAt <= pdfControl.balanceAsOf!,
            )
            .reduce((total, transaction) => total + transaction.amountCents, 0)
        : 0
      const audit = evaluateImportAudit({
        targetType: 'account',
        sourceTransactionCount: pdfControl.sourceTransactionCount,
        parsedTransactionCount: pdfControl.parsedTransactionCount,
        invalidTransactionCount: pdfControl.invalidTransactionCount,
        openingBalanceCents: pdfControl.openingBalanceCents,
        openingBalanceAt: pdfControl.openingBalanceAt,
        closingBalanceCents: pdfControl.closingBalanceCents,
        balanceAsOf: pdfControl.balanceAsOf,
        statementPeriodStart: pdfControl.periodStart,
        anchorBalanceCents: account?.balanceCents ?? null,
        anchorBalanceAt: account?.balanceAt ?? null,
        existingMovementCents,
        newMovementCents:
          pdfControl.openingBalanceCents !== null
            ? pdfStaged.reduce(
                (total, transaction) => total + transaction.amountCents,
                0,
              )
            : resolution
              ? [
                  ...resolution.unmatched,
                  ...resolution.matches.flatMap(
                    ({ observation, transaction }) =>
                      transaction.status === 'excluded' ? [observation] : [],
                  ),
                ].reduce(
                  (total, transaction) => total + transaction.amountCents,
                  0,
                )
              : 0,
        documentMovementCents: pdfStaged.reduce(
          (total, transaction) => total + transaction.amountCents,
          0,
        ),
      })
      if (!resolution || audit.status === 'divergent') {
        await db
          .update(schema.imports)
          .set({
            validationStatus: 'divergent',
            validationMessage: resolution
              ? audit.message
              : 'Já existem lançamentos desta conta no período, mas o PDF não corresponde exatamente a eles em data, valor e moeda. A importação foi bloqueada para evitar duplicidades.',
          })
          .where(eq(schema.imports.id, pdfControl.id))
        continue
      }

      const assignments = resolution.matches
      if (resolution.unmatched.length && !input.finalize) {
        db.transaction((transaction) => {
          for (const { observation } of assignments) {
            transaction
              .update(schema.stagedTransactions)
              .set({ duplicate: true, duplicateReason: null })
              .where(eq(schema.stagedTransactions.id, observation.id))
              .run()
          }
          for (const observation of resolution.unmatched) {
            transaction
              .update(schema.stagedTransactions)
              .set({ duplicate: false, duplicateReason: null })
              .where(eq(schema.stagedTransactions.id, observation.id))
              .run()
          }
          transaction
            .update(schema.imports)
            .set({
              validationStatus: audit.status,
              validationMessage: `PDF conferido: ${assignments.length} lançamento(s) já existente(s) foram reconhecidos. Revise os ${resolution.unmatched.length} lançamento(s) novos antes de consolidar.`,
              expectedBalanceCents: audit.expectedBalanceCents,
              balanceDifferenceCents: audit.balanceDifferenceCents,
              warning:
                'As linhas já importadas não serão duplicadas. Somente os lançamentos novos do PDF entrarão ao consolidar.',
            })
            .where(eq(schema.imports.id, pdfControl.id))
            .run()
        })
        continue
      }

      const createdFromPdf = await Promise.all(
        resolution.unmatched.map(async (observation) => {
          let baseAmountCents: number | null = observation.amountCents
          let exchangeRateMicros: number | null = 1_000_000
          if (observation.currency === 'USD') {
            exchangeRateMicros = await fetchPtax(
              observation.postedAt.slice(0, 10),
            )
            baseAmountCents = exchangeRateMicros
              ? convertMinorUnitsAtRate(
                  observation.amountCents,
                  observation.currency,
                  'BRL',
                  exchangeRateMicros,
                )
              : null
          } else if (observation.currency !== 'BRL') {
            baseAmountCents = null
            exchangeRateMicros = null
          }
          return {
            observation,
            transaction: {
              id: randomUUID(),
              importId: pdfControl.id,
              accountId: input.targetId,
              categoryId: observation.suggestedCategoryId,
              counterpartyAccountId: observation.counterpartyAccountId,
              externalId: observation.externalId,
              sourceKey: `account:${input.targetId}:statement:${pdfControl.id}:${observation.id}`,
              fingerprint: observation.fingerprint,
              postedAt: observation.postedAt,
              description: observation.description,
              normalizedDescription: observation.normalizedDescription,
              amountCents: observation.amountCents,
              currency: observation.currency,
              baseAmountCents,
              exchangeRateMicros,
              status: 'confirmed' as const,
            },
          }
        }),
      )
      const restoredAssignments = assignments.filter(
        ({ transaction: matched }) => matched.status === 'excluded',
      )
      const checkpointVerified = audit.status === 'reconciled'
      db.transaction((transaction) => {
        if (restoredAssignments.length) {
          const restoredIds = restoredAssignments.map(
            ({ transaction: matched }) => matched.id,
          )
          const activeExclusions = transaction
            .select()
            .from(schema.statementExclusions)
            .where(
              and(
                inArray(schema.statementExclusions.transactionId, restoredIds),
                sql`${schema.statementExclusions.reversedAt} is null`,
              ),
            )
            .all()
          if (activeExclusions.length) {
            transaction
              .update(schema.statementExclusions)
              .set({
                reversedAt: new Date(),
                reason: sql`${schema.statementExclusions.reason} || ' Reaberta automaticamente porque um extrato posterior comprovou a movimentação.'`,
              })
              .where(
                inArray(
                  schema.statementExclusions.id,
                  activeExclusions.map((exclusion) => exclusion.id),
                ),
              )
              .run()
            transaction
              .update(schema.imports)
              .set({
                validationStatus: 'warning',
                validationMessage:
                  'Uma movimentação antes excluída apareceu em um extrato posterior. Os saldos seguintes foram reabertos para conferência.',
              })
              .where(
                inArray(schema.imports.id, [
                  ...new Set(activeExclusions.map((item) => item.importId)),
                ]),
              )
              .run()
          }
          transaction
            .update(schema.transactions)
            .set({ status: 'confirmed' })
            .where(inArray(schema.transactions.id, restoredIds))
            .run()
          const affectedGroupIds = transaction
            .select({ groupId: schema.reconciliationLinks.groupId })
            .from(schema.reconciliationLinks)
            .where(
              inArray(schema.reconciliationLinks.transactionId, restoredIds),
            )
            .all()
          const linkedGroups = affectedGroupIds.length
            ? transaction
                .select({
                  groupId: schema.reconciliationLinks.groupId,
                  transactionId: schema.reconciliationLinks.transactionId,
                  previousCategoryId:
                    schema.reconciliationLinks.previousCategoryId,
                  status: schema.reconciliationGroups.status,
                })
                .from(schema.reconciliationLinks)
                .innerJoin(
                  schema.reconciliationGroups,
                  eq(
                    schema.reconciliationGroups.id,
                    schema.reconciliationLinks.groupId,
                  ),
                )
                .where(
                  inArray(schema.reconciliationLinks.groupId, [
                    ...new Set(affectedGroupIds.map((item) => item.groupId)),
                  ]),
                )
                .all()
            : []
          for (const link of linkedGroups) {
            if (link.status !== 'confirmed') continue
            transaction
              .update(schema.transactions)
              .set({ categoryId: link.previousCategoryId })
              .where(eq(schema.transactions.id, link.transactionId))
              .run()
          }
          if (linkedGroups.length) {
            transaction
              .update(schema.reconciliationGroups)
              .set({
                status: 'suggested',
                aiValidation: null,
                aiConfidence: null,
                aiReason: null,
                aiValidatedAt: null,
                reason:
                  'Reaberta porque uma movimentação antes excluída reapareceu em um extrato posterior.',
              })
              .where(
                inArray(schema.reconciliationGroups.id, [
                  ...new Set(linkedGroups.map((link) => link.groupId)),
                ]),
              )
              .run()
          }
          const affectedFrom = restoredAssignments
            .map(({ transaction: matched }) => matched.postedAt)
            .sort()
            .at(0)!
          invalidateCheckpointChain(transaction, {
            targetType: 'account',
            targetId: input.targetId,
            from: affectedFrom,
            reason:
              'Uma movimentação antes excluída reapareceu em um extrato posterior.',
          })
        }
        for (const { observation, transaction: matched } of assignments) {
          linkCanonicalObservation(transaction, {
            stagedTransactionId: observation.id,
            transactionId: matched.id,
            matchKind: 'statement_control',
            duplicate: true,
            duplicateReason: null,
          })
        }
        if (createdFromPdf.length) {
          transaction
            .insert(schema.transactions)
            .values(createdFromPdf.map((item) => item.transaction))
            .run()
          for (const { observation, transaction: created } of createdFromPdf) {
            linkCanonicalObservation(transaction, {
              stagedTransactionId: observation.id,
              transactionId: created.id,
              matchKind: 'created',
              duplicate: false,
              duplicateReason: null,
            })
          }
        }
        const importStatusUpdate = transaction
          .update(schema.imports)
          .set({
            status: createdFromPdf.length ? 'committed' : 'evidence',
            committedAt: new Date(),
            validationStatus: audit.status,
            validationMessage: createdFromPdf.length
              ? `${audit.message} ${assignments.length} lançamento(s) existente(s) foram ligados e ${createdFromPdf.length} novo(s) foram incluídos uma única vez.`
              : `${audit.message} O PDF foi ligado aos lançamentos já existentes e não criou duplicidades.`,
            expectedBalanceCents: audit.expectedBalanceCents,
            balanceDifferenceCents: audit.balanceDifferenceCents,
            warning: createdFromPdf.length
              ? 'As linhas já existentes preservam sua origem; somente os lançamentos ausentes vieram do PDF.'
              : 'Os lançamentos estruturados continuam como fonte canônica; este PDF comprova o período e o saldo informado.',
          })
          .where(
            and(
              eq(schema.imports.id, pdfControl.id),
              eq(schema.imports.status, 'review'),
            ),
          )
          .run()
        if (importStatusUpdate.changes !== 1) {
          throw new Error(
            'A importação saiu da revisão enquanto era consolidada. Nenhum lançamento foi alterado; atualize a página.',
          )
        }
        if (
          restoredAssignments.length > 0 ||
          !account?.balanceAt ||
          account.balanceAt < pdfControl.balanceAsOf!
        ) {
          transaction
            .update(schema.accounts)
            .set({
              statementBalanceCents: pdfControl.closingBalanceCents,
              statementBalanceAt: pdfControl.balanceAsOf,
              coverageStart: account?.coverageStart ?? pdfControl.periodStart,
            })
            .where(eq(schema.accounts.id, input.targetId))
            .run()
        }
        if (
          checkpointAtDate.status === 'none' ||
          restoredAssignments.length > 0
        ) {
          addBalanceCheckpoint(transaction, {
            accountId: input.targetId,
            importId: pdfControl.id,
            kind: 'statement_closing',
            balanceType: 'posted',
            source: 'pdf',
            reviewState: checkpointVerified ? 'verified' : 'observed',
            balanceCents: pdfControl.closingBalanceCents!,
            asOf: pdfControl.balanceAsOf!,
            verified: checkpointVerified,
            differenceCents: audit.balanceDifferenceCents,
            evidenceJson: JSON.stringify({
              method: 'date_amount_currency_multiset',
            }),
          })
        }
      })
      matchedPdfIds.add(pdfControl.id)
    }
    return
  }

  const [priorTransactions, existingCycles] = await Promise.all([
    db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.creditCardId, input.targetId)),
    db
      .select()
      .from(schema.cardStatementCycles)
      .where(eq(schema.cardStatementCycles.creditCardId, input.targetId)),
  ])

  for (const pdfControl of remainingPdfControls) {
    const checkpointAtDate = classifyCheckpointAtDate(
      await loadTargetCheckpoints(),
      {
        balanceType: 'card_statement',
        balanceCents: pdfControl.closingBalanceCents!,
        asOf: pdfControl.balanceAsOf!,
      },
    )
    if (checkpointAtDate.status === 'conflict') {
      await db
        .update(schema.imports)
        .set({
          validationStatus: 'divergent',
          validationMessage:
            'Já existe outro total de fatura ativo para este cartão na mesma data. Invalide o ponto anterior antes de consolidar.',
        })
        .where(eq(schema.imports.id, pdfControl.id))
      continue
    }
    const canonicalInPeriod = priorTransactions.filter(
      (transaction) =>
        transaction.status !== 'excluded' &&
        transaction.postedAt >= pdfControl.periodStart! &&
        transaction.postedAt <= pdfControl.periodEnd!,
    )
    const pdfStaged = stagedByImport.get(pdfControl.id) ?? []
    const excludedInPeriod = priorTransactions.filter(
      (transaction) =>
        transaction.status === 'excluded' &&
        transaction.postedAt >= pdfControl.periodStart! &&
        transaction.postedAt <= pdfControl.periodEnd!,
    )
    if (!canonicalInPeriod.length && !excludedInPeriod.length) continue
    let resolution = canonicalInPeriod.length
      ? matchStatementValueSubset(pdfStaged, canonicalInPeriod)
      : { matches: [], unmatched: pdfStaged }
    if (resolution) {
      const restored = matchOptionalStatementValues(
        resolution.unmatched,
        excludedInPeriod,
      )
      resolution = {
        matches: [...resolution.matches, ...restored.matches],
        unmatched: restored.unmatched,
      }
    }
    const audit = evaluateImportAudit({
      targetType: 'card',
      sourceTransactionCount: pdfControl.sourceTransactionCount,
      parsedTransactionCount: pdfControl.parsedTransactionCount,
      invalidTransactionCount: pdfControl.invalidTransactionCount,
      openingBalanceCents: pdfControl.openingBalanceCents,
      openingBalanceAt: pdfControl.openingBalanceAt,
      closingBalanceCents: pdfControl.closingBalanceCents,
      balanceAsOf: pdfControl.balanceAsOf,
      statementPeriodStart: pdfControl.periodStart,
      anchorBalanceCents: null,
      anchorBalanceAt: null,
      existingMovementCents: 0,
      newMovementCents: pdfStaged.reduce(
        (total, item) => total + item.amountCents,
        0,
      ),
    })

    if (!resolution || audit.status !== 'reconciled') {
      await db
        .update(schema.imports)
        .set({
          validationStatus: 'divergent',
          validationMessage:
            'Já existem lançamentos deste cartão no período, mas eles não correspondem exatamente ao PDF definitivo. Compare as diferenças, corrija o período ou rejeite esta importação; nada novo será consolidado enquanto houver ambiguidade.',
        })
        .where(eq(schema.imports.id, pdfControl.id))
      continue
    }

    const assignments = resolution.matches
    if (resolution.unmatched.length && !input.finalize) {
      db.transaction((transaction) => {
        for (const { observation } of assignments) {
          transaction
            .update(schema.stagedTransactions)
            .set({ duplicate: true, duplicateReason: null })
            .where(eq(schema.stagedTransactions.id, observation.id))
            .run()
        }
        for (const observation of resolution.unmatched) {
          transaction
            .update(schema.stagedTransactions)
            .set({ duplicate: false, duplicateReason: null })
            .where(eq(schema.stagedTransactions.id, observation.id))
            .run()
        }
        transaction
          .update(schema.imports)
          .set({
            validationStatus: 'reconciled',
            validationMessage: `Fatura conferida: ${assignments.length} lançamento(s) já importado(s) foram reconhecidos. Revise os ${resolution.unmatched.length} lançamento(s) novos antes de consolidar.`,
            expectedBalanceCents: audit.expectedBalanceCents,
            balanceDifferenceCents: audit.balanceDifferenceCents,
            warning:
              'As compras novas do PDF ainda não entraram nos relatórios. Revise as categorias e clique em Consolidar.',
          })
          .where(eq(schema.imports.id, pdfControl.id))
          .run()
      })
      continue
    }
    const createdFromPdf = await Promise.all(
      resolution.unmatched.map(async (observation) => {
        let baseAmountCents: number | null = observation.amountCents
        let exchangeRateMicros: number | null = 1_000_000
        if (observation.currency === 'USD') {
          exchangeRateMicros = await fetchPtax(
            observation.postedAt.slice(0, 10),
          )
          baseAmountCents = exchangeRateMicros
            ? convertMinorUnitsAtRate(
                observation.amountCents,
                observation.currency,
                'BRL',
                exchangeRateMicros,
              )
            : null
        } else if (observation.currency !== 'BRL') {
          baseAmountCents = null
          exchangeRateMicros = null
        }
        return {
          observation,
          transaction: {
            id: randomUUID(),
            importId: pdfControl.id,
            creditCardId: input.targetId,
            categoryId: observation.suggestedCategoryId,
            counterpartyAccountId: observation.counterpartyAccountId,
            externalId: observation.externalId,
            sourceKey: `card:${input.targetId}:statement:${pdfControl.id}:${observation.id}`,
            fingerprint: observation.fingerprint,
            postedAt: observation.postedAt,
            description: observation.description,
            normalizedDescription: observation.normalizedDescription,
            amountCents: observation.amountCents,
            currency: observation.currency,
            baseAmountCents,
            exchangeRateMicros,
            status: 'confirmed' as const,
          },
        }
      }),
    )
    const matchedImportIds = [
      ...new Set(
        assignments.flatMap(({ transaction }) =>
          transaction.importId ? [transaction.importId] : [],
        ),
      ),
    ]
    const obsoleteOpenCycles = existingCycles.filter(
      (cycle) =>
        cycle.status === 'open' &&
        cycle.importId &&
        matchedImportIds.includes(cycle.importId) &&
        (cycle.periodStart !== pdfControl.periodStart ||
          cycle.periodEnd !== pdfControl.periodEnd),
    )
    const confirmedPending = assignments.some(
      ({ transaction }) => transaction.status === 'pending',
    )
    db.transaction((transaction) => {
      const restoredAssignments = assignments.filter(
        ({ transaction: matched }) => matched.status === 'excluded',
      )
      if (restoredAssignments.length) {
        const restoredIds = restoredAssignments.map(
          ({ transaction: matched }) => matched.id,
        )
        const activeExclusions = transaction
          .select()
          .from(schema.statementExclusions)
          .where(
            and(
              inArray(schema.statementExclusions.transactionId, restoredIds),
              sql`${schema.statementExclusions.reversedAt} is null`,
            ),
          )
          .all()
        if (activeExclusions.length) {
          transaction
            .update(schema.statementExclusions)
            .set({
              reversedAt: new Date(),
              reason: sql`${schema.statementExclusions.reason} || ' Reaberta automaticamente porque uma fatura posterior comprovou a movimentação.'`,
            })
            .where(
              inArray(
                schema.statementExclusions.id,
                activeExclusions.map((exclusion) => exclusion.id),
              ),
            )
            .run()
          transaction
            .update(schema.imports)
            .set({
              validationStatus: 'warning',
              validationMessage:
                'Uma movimentação antes marcada como autorização ausente apareceu em uma fatura posterior. O fechamento foi reaberto para conferência.',
            })
            .where(
              inArray(schema.imports.id, [
                ...new Set(activeExclusions.map((item) => item.importId)),
              ]),
            )
            .run()
        }
        transaction
          .update(schema.transactions)
          .set({ status: 'confirmed' })
          .where(inArray(schema.transactions.id, restoredIds))
          .run()
        const affectedGroupIds = transaction
          .select({ groupId: schema.reconciliationLinks.groupId })
          .from(schema.reconciliationLinks)
          .where(inArray(schema.reconciliationLinks.transactionId, restoredIds))
          .all()
        const linkedGroups = affectedGroupIds.length
          ? transaction
              .select({
                groupId: schema.reconciliationLinks.groupId,
                transactionId: schema.reconciliationLinks.transactionId,
                previousCategoryId:
                  schema.reconciliationLinks.previousCategoryId,
                status: schema.reconciliationGroups.status,
              })
              .from(schema.reconciliationLinks)
              .innerJoin(
                schema.reconciliationGroups,
                eq(
                  schema.reconciliationGroups.id,
                  schema.reconciliationLinks.groupId,
                ),
              )
              .where(
                inArray(schema.reconciliationLinks.groupId, [
                  ...new Set(affectedGroupIds.map((item) => item.groupId)),
                ]),
              )
              .all()
          : []
        for (const link of linkedGroups) {
          if (link.status !== 'confirmed') continue
          transaction
            .update(schema.transactions)
            .set({ categoryId: link.previousCategoryId })
            .where(eq(schema.transactions.id, link.transactionId))
            .run()
        }
        if (linkedGroups.length) {
          transaction
            .update(schema.reconciliationGroups)
            .set({
              status: 'suggested',
              aiValidation: null,
              aiConfidence: null,
              aiReason: null,
              aiValidatedAt: null,
              reason:
                'Reaberta porque uma autorização antes excluída reapareceu em uma fatura posterior.',
            })
            .where(
              inArray(schema.reconciliationGroups.id, [
                ...new Set(linkedGroups.map((link) => link.groupId)),
              ]),
            )
            .run()
        }
        const affectedFrom = restoredAssignments
          .map(({ transaction: matched }) => matched.postedAt)
          .sort()
          .at(0)!
        transaction
          .update(schema.cardStatementCycles)
          .set({ status: 'closed' })
          .where(
            and(
              eq(schema.cardStatementCycles.creditCardId, input.targetId),
              gte(schema.cardStatementCycles.periodEnd, affectedFrom),
            ),
          )
          .run()
        invalidateCheckpointChain(transaction, {
          targetType: 'card',
          targetId: input.targetId,
          from: affectedFrom,
          reason:
            'Uma autorização antes excluída reapareceu em uma fatura posterior.',
        })
      }
      for (const { observation, transaction: matched } of assignments) {
        linkCanonicalObservation(transaction, {
          stagedTransactionId: observation.id,
          transactionId: matched.id,
          matchKind: 'statement_control',
          duplicate: true,
          duplicateReason: null,
          transactionStatus: 'confirmed',
        })
      }
      if (createdFromPdf.length) {
        transaction
          .insert(schema.transactions)
          .values(createdFromPdf.map((item) => item.transaction))
          .run()
        for (const { observation, transaction: created } of createdFromPdf) {
          linkCanonicalObservation(transaction, {
            stagedTransactionId: observation.id,
            transactionId: created.id,
            matchKind: 'created',
            duplicate: false,
            duplicateReason: null,
          })
          const installment =
            observation.amountCents < 0
              ? parseInstallmentDescription(observation.description)
              : null
          if (installment) {
            transaction
              .insert(schema.installmentPlans)
              .values({
                id: randomUUID(),
                creditCardId: input.targetId,
                sourceTransactionId: created.id,
                description: installment.cleanDescription,
                categoryId: observation.suggestedCategoryId,
                installmentAmountCents: Math.abs(observation.amountCents),
                totalInstallments: installment.totalInstallments,
                currentInstallment: installment.currentInstallment,
                firstChargeDate: observation.postedAt,
                autoDetected: true,
              })
              .onConflictDoNothing()
              .run()
          }
        }
      }
      const importStatusUpdate = transaction
        .update(schema.imports)
        .set({
          status: createdFromPdf.length ? 'committed' : 'evidence',
          committedAt: new Date(),
          validationStatus: 'reconciled',
          validationMessage: createdFromPdf.length
            ? `PDF definitivo conferido: ${assignments.length} lançamento(s) já existente(s) foram ligados e ${createdFromPdf.length} lançamento(s) do fechamento foram incluídos uma única vez.`
            : confirmedPending
              ? 'PDF definitivo conferido contra os lançamentos já importados. Os pendentes foram confirmados sem duplicação.'
              : 'PDF definitivo repetido conferido contra os lançamentos já consolidados e preservado como evidência adicional.',
          expectedBalanceCents: audit.expectedBalanceCents,
          balanceDifferenceCents: audit.balanceDifferenceCents,
          warning: createdFromPdf.length
            ? 'Os lançamentos já vistos preservam o CSV como origem; somente as compras ausentes no último CSV vieram do PDF de fechamento.'
            : 'O CSV anterior continua como fonte canônica; este PDF comprova o fechamento e o total da fatura.',
        })
        .where(
          and(
            eq(schema.imports.id, pdfControl.id),
            eq(schema.imports.status, 'review'),
          ),
        )
        .run()
      if (importStatusUpdate.changes !== 1) {
        throw new Error(
          'A importação saiu da revisão enquanto era consolidada. Nenhum lançamento foi alterado; atualize a página.',
        )
      }
      for (const matchedImportId of matchedImportIds) {
        transaction
          .update(schema.imports)
          .set({
            closingBalanceCents: pdfControl.closingBalanceCents,
            balanceAsOf: pdfControl.balanceAsOf,
            statementDueDate: pdfControl.statementDueDate,
            validationStatus: 'reconciled',
            validationMessage:
              'Fatura encerrada pelo PDF definitivo importado posteriormente; os lançamentos do CSV foram preservados e confirmados.',
            expectedBalanceCents: audit.expectedBalanceCents,
            balanceDifferenceCents: audit.balanceDifferenceCents,
          })
          .where(eq(schema.imports.id, matchedImportId))
          .run()
      }
      for (const obsoleteCycle of obsoleteOpenCycles) {
        transaction
          .delete(schema.cardStatementCycles)
          .where(eq(schema.cardStatementCycles.id, obsoleteCycle.id))
          .run()
      }
      transaction
        .insert(schema.cardStatementCycles)
        .values({
          id: randomUUID(),
          creditCardId: input.targetId,
          importId: pdfControl.id,
          periodStart: pdfControl.periodStart!,
          periodEnd: pdfControl.periodEnd!,
          closingDate: pdfControl.balanceAsOf,
          dueDate: pdfControl.statementDueDate,
          totalCents: pdfControl.closingBalanceCents,
          status: 'reconciled',
        })
        .onConflictDoUpdate({
          target: [
            schema.cardStatementCycles.creditCardId,
            schema.cardStatementCycles.periodStart,
            schema.cardStatementCycles.periodEnd,
          ],
          set: {
            closingDate: pdfControl.balanceAsOf,
            dueDate: pdfControl.statementDueDate,
            totalCents: pdfControl.closingBalanceCents,
            status: 'reconciled',
          },
        })
        .run()
      const card = transaction
        .select({
          coverageStart: schema.creditCards.coverageStart,
          dueDay: schema.creditCards.dueDay,
          statementBalanceAt: schema.creditCards.statementBalanceAt,
        })
        .from(schema.creditCards)
        .where(eq(schema.creditCards.id, input.targetId))
        .get()
      if (
        restoredAssignments.length > 0 ||
        !card?.statementBalanceAt ||
        card.statementBalanceAt < pdfControl.balanceAsOf!
      ) {
        transaction
          .update(schema.creditCards)
          .set({
            statementBalanceCents: pdfControl.closingBalanceCents,
            statementBalanceAt: pdfControl.balanceAsOf,
            coverageStart: card?.coverageStart ?? pdfControl.periodStart,
            dueDay:
              card?.dueDay ??
              (pdfControl.statementDueDate
                ? Number(pdfControl.statementDueDate.slice(-2))
                : null),
          })
          .where(eq(schema.creditCards.id, input.targetId))
          .run()
      }
      if (
        checkpointAtDate.status === 'none' ||
        restoredAssignments.length > 0
      ) {
        addBalanceCheckpoint(transaction, {
          creditCardId: input.targetId,
          importId: pdfControl.id,
          kind: 'statement_closing',
          balanceType: 'card_statement',
          source: 'pdf',
          reviewState: 'verified',
          balanceCents: pdfControl.closingBalanceCents!,
          asOf: pdfControl.balanceAsOf!,
          verified: true,
          differenceCents: audit.balanceDifferenceCents,
          evidenceJson: JSON.stringify({
            method: 'date_amount_currency_multiset',
          }),
        })
      }
    })
  }
}

export async function stageImportBatch(input: {
  files: File[]
  targetType: 'account' | 'card'
  targetId: string
  aiConsent: boolean
}) {
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

async function fetchPtax(date: string) {
  const cached = await db
    .select()
    .from(schema.exchangeRates)
    .where(
      and(
        eq(schema.exchangeRates.date, date),
        eq(schema.exchangeRates.fromCurrency, 'USD'),
        eq(schema.exchangeRates.toCurrency, 'BRL'),
        eq(schema.exchangeRates.source, 'bcb_ptax'),
      ),
    )
    .limit(1)
  if (cached[0]) return cached[0].rateMicros

  const [year, month, day] = date.split('-')
  const formatted = `${month}-${day}-${year}`
  const url = `https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarDia(dataCotacao=@dataCotacao)?@dataCotacao='${formatted}'&$top=1&$format=json`
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(4_000) })
    if (!response.ok) return null
    const body = (await response.json()) as {
      value?: Array<{ cotacaoVenda?: number }>
    }
    const rate = body.value?.[0]?.cotacaoVenda
    if (!rate) return null
    const rateMicros = Math.round(rate * 1_000_000)
    await db
      .insert(schema.exchangeRates)
      .values({
        id: randomUUID(),
        date,
        fromCurrency: 'USD',
        toCurrency: 'BRL',
        rateMicros,
        source: 'bcb_ptax',
      })
      .onConflictDoNothing()
    return rateMicros
  } catch {
    return null
  }
}

async function linkBatchEvidence(batchId: string) {
  const observations = await db
    .select({ staged: schema.stagedTransactions, import: schema.imports })
    .from(schema.stagedTransactions)
    .innerJoin(
      schema.imports,
      eq(schema.imports.id, schema.stagedTransactions.importId),
    )
    .leftJoin(
      schema.transactionEvidence,
      eq(
        schema.transactionEvidence.stagedTransactionId,
        schema.stagedTransactions.id,
      ),
    )
    .where(
      and(
        eq(schema.imports.batchId, batchId),
        eq(schema.imports.status, 'evidence'),
        // SQLite represents an absent left-join row with a null id.
        sql`${schema.transactionEvidence.id} is null`,
      ),
    )
  const assigned = new Set<string>()
  const externalTransactions = await db
    .select({
      id: schema.transactions.id,
      accountId: schema.transactions.accountId,
      creditCardId: schema.transactions.creditCardId,
      externalId: schema.transactions.externalId,
    })
    .from(schema.transactions)
  const reservedExternalTransactions = new Set(
    observations.flatMap((row) => {
      if (!row.staged.externalId) return []
      const match = externalTransactions.find(
        (candidate) =>
          candidate.externalId === row.staged.externalId &&
          candidate.accountId === row.import.accountId &&
          candidate.creditCardId === row.import.creditCardId,
      )
      return match ? [`${row.import.id}:${match.id}`] : []
    }),
  )
  for (const row of observations) {
    const isControlledPartialCsv =
      row.import.parser === 'csv' &&
      row.import.validationStatus === 'reconciled' &&
      Boolean(row.import.dependsOnImportId)
    const target = row.import.accountId
      ? eq(schema.transactions.accountId, row.import.accountId)
      : eq(schema.transactions.creditCardId, row.import.creditCardId!)
    let candidates = await db
      .select({
        id: schema.transactions.id,
        externalId: schema.transactions.externalId,
      })
      .from(schema.transactions)
      .where(
        row.staged.externalId
          ? and(
              target,
              eq(schema.transactions.externalId, row.staged.externalId),
            )
          : and(
              target,
              eq(schema.transactions.fingerprint, row.staged.fingerprint),
            ),
      )
      .orderBy(schema.transactions.id)
    let matchKind: 'external_id' | 'exact_overlap' | 'statement_control' = row
      .staged.externalId
      ? 'external_id'
      : 'exact_overlap'
    if (row.staged.externalId && !candidates.length) {
      candidates = await db
        .select({
          id: schema.transactions.id,
          externalId: schema.transactions.externalId,
        })
        .from(schema.transactions)
        .where(
          and(
            target,
            sql`${schema.transactions.externalId} is null`,
            eq(schema.transactions.fingerprint, row.staged.fingerprint),
          ),
        )
        .orderBy(schema.transactions.id)
      matchKind = 'exact_overlap'
    }
    if (
      (!row.staged.externalId || isControlledPartialCsv) &&
      !candidates.length
    ) {
      candidates = await db
        .select({
          id: schema.transactions.id,
          externalId: schema.transactions.externalId,
        })
        .from(schema.transactions)
        .where(
          and(
            target,
            ...(row.staged.externalId
              ? [sql`${schema.transactions.externalId} is null`]
              : []),
            eq(schema.transactions.postedAt, row.staged.postedAt),
            eq(schema.transactions.amountCents, row.staged.amountCents),
            eq(schema.transactions.currency, row.staged.currency),
          ),
        )
        .orderBy(schema.transactions.id)
      matchKind = 'statement_control'
    }
    const transactionId = candidates.find(
      (candidate) =>
        !assigned.has(`${row.import.id}:${candidate.id}`) &&
        (Boolean(row.staged.externalId) ||
          !reservedExternalTransactions.has(
            `${row.import.id}:${candidate.id}`,
          )),
    )?.id
    if (!transactionId) continue
    db.transaction((transaction) => {
      linkCanonicalObservation(transaction, {
        stagedTransactionId: row.staged.id,
        transactionId,
        matchKind,
        externalId:
          isControlledPartialCsv && matchKind === 'statement_control'
            ? row.staged.externalId
            : null,
      })
    })
    assigned.add(`${row.import.id}:${transactionId}`)
  }
}

async function finishImportBatchIfComplete(batchId: string) {
  await refreshImportBatchCoverage({ batchId, mode: 'completed' })
}

async function finalizeImportAfterCommit(batchId: string | null) {
  const batchEvidence = await runPostCommitStep(
    batchId ? () => linkBatchEvidence(batchId) : null,
  )
  const batchCoverage = await runPostCommitStep(
    batchId ? () => finishImportBatchIfComplete(batchId) : null,
  )
  const reconciliation = await refreshReconciliationAfterCommit()
  const status =
    batchEvidence.status === 'deferred' ||
    batchCoverage.status === 'deferred' ||
    reconciliation.status === 'deferred'
      ? ('deferred' as const)
      : ('completed' as const)
  return { status, batchEvidence, batchCoverage, reconciliation }
}

async function matchStructuredImportToTrustedControls(
  importRow: typeof schema.imports.$inferSelect,
  staged: Array<typeof schema.stagedTransactions.$inferSelect>,
  existingTransactions: Array<
    Pick<
      typeof schema.transactions.$inferSelect,
      | 'id'
      | 'importId'
      | 'status'
      | 'externalId'
      | 'postedAt'
      | 'amountCents'
      | 'currency'
    >
  >,
) {
  const assignments = new Map<
    string,
    { transactionId: string; externalId: string | null }
  >()
  if (
    (importRow.parser !== 'csv' && importRow.parser !== 'ofx') ||
    (!importRow.creditCardId && !importRow.accountId)
  ) {
    return assignments
  }

  const cardControls = importRow.creditCardId
    ? await db
        .select({
          periodStart: schema.cardStatementCycles.periodStart,
          periodEnd: schema.cardStatementCycles.periodEnd,
          importId: schema.cardStatementCycles.importId,
        })
        .from(schema.cardStatementCycles)
        .where(
          and(
            eq(schema.cardStatementCycles.creditCardId, importRow.creditCardId),
            eq(schema.cardStatementCycles.status, 'reconciled'),
          ),
        )
    : []
  const accountControls = importRow.accountId
    ? await db
        .select({
          periodStart: schema.imports.periodStart,
          periodEnd: schema.imports.periodEnd,
          importId: schema.imports.id,
          reviewState: schema.balanceCheckpoints.reviewState,
        })
        .from(schema.balanceCheckpoints)
        .innerJoin(
          schema.imports,
          eq(schema.imports.id, schema.balanceCheckpoints.importId),
        )
        .where(
          and(
            eq(schema.balanceCheckpoints.accountId, importRow.accountId),
            eq(schema.balanceCheckpoints.source, 'pdf'),
            inArray(schema.imports.status, ['committed', 'evidence']),
          ),
        )
    : []
  const controls = [
    ...cardControls.map((control) => ({ ...control, kind: 'card' as const })),
    ...accountControls
      .filter(
        (control) =>
          control.reviewState !== 'invalidated' &&
          control.periodStart &&
          control.periodEnd,
      )
      .map((control) => ({
        periodStart: control.periodStart!,
        periodEnd: control.periodEnd!,
        importId: control.importId,
        kind: 'account' as const,
      })),
  ]
  if (!controls.length) return assignments

  const accountControlImportIds = controls.flatMap((control) =>
    control.kind === 'account' && control.importId ? [control.importId] : [],
  )
  const accountControlEvidence = accountControlImportIds.length
    ? await db
        .select({
          importId: schema.stagedTransactions.importId,
          transactionId: schema.transactionEvidence.transactionId,
        })
        .from(schema.transactionEvidence)
        .innerJoin(
          schema.stagedTransactions,
          eq(
            schema.stagedTransactions.id,
            schema.transactionEvidence.stagedTransactionId,
          ),
        )
        .where(
          inArray(schema.stagedTransactions.importId, accountControlImportIds),
        )
    : []
  const controlledTransactionIdsByImport = new Map<string, Set<string>>()
  for (const evidence of accountControlEvidence) {
    const transactionIds =
      controlledTransactionIdsByImport.get(evidence.importId) ??
      new Set<string>()
    transactionIds.add(evidence.transactionId)
    controlledTransactionIdsByImport.set(evidence.importId, transactionIds)
  }

  const reservedTransactionIds = new Set<string>()
  for (const observation of staged) {
    const postedDate = observation.postedAt.slice(0, 10)
    const matchingControls = controls.filter(
      (control) =>
        postedDate >= control.periodStart && postedDate <= control.periodEnd,
    )
    if (!matchingControls.length) continue
    if (
      importRow.creditCardId &&
      matchingControls.filter((control) => control.kind === 'card').length > 1
    ) {
      const message =
        'O lançamento pertence a mais de um ciclo reconciliado. Revise os períodos das faturas antes de consolidar este CSV.'
      await db
        .update(schema.imports)
        .set({ validationStatus: 'divergent', validationMessage: message })
        .where(eq(schema.imports.id, importRow.id))
      throw new Error(message)
    }
    if (
      observation.externalId &&
      existingTransactions.some(
        (transaction) => transaction.externalId === observation.externalId,
      )
    ) {
      continue
    }

    const controlledImportIds = new Set(
      matchingControls.flatMap((control) =>
        control.kind === 'account' && control.importId
          ? [control.importId]
          : [],
      ),
    )
    const controlledTransactionIds = new Set(
      [...controlledImportIds].flatMap((controlledImportId) => [
        ...(controlledTransactionIdsByImport.get(controlledImportId) ?? []),
      ]),
    )
    const candidate = existingTransactions
      .filter(
        (transaction) =>
          (transaction.status === 'confirmed' ||
            transaction.status === 'excluded') &&
          (!observation.externalId || !transaction.externalId) &&
          !reservedTransactionIds.has(transaction.id) &&
          matchingControls.some(
            (control) =>
              transaction.postedAt.slice(0, 10) >= control.periodStart &&
              transaction.postedAt.slice(0, 10) <= control.periodEnd,
          ) &&
          (!importRow.accountId ||
            (transaction.importId !== null &&
              controlledImportIds.has(transaction.importId)) ||
            controlledTransactionIds.has(transaction.id)) &&
          statementValueSignature(transaction) ===
            statementValueSignature(observation),
      )
      .sort((left, right) =>
        left.status !== right.status
          ? left.status === 'confirmed'
            ? -1
            : 1
          : left.id.localeCompare(right.id),
      )
      .at(0)
    if (!candidate) {
      const message = `O arquivo estruturado contém o lançamento "${observation.description}" dentro de um período já controlado por PDF, mas não existe uma linha idêntica em data, valor e moeda. Revise ou rejeite o arquivo; nenhuma duplicidade foi criada.`
      await db
        .update(schema.imports)
        .set({ validationStatus: 'divergent', validationMessage: message })
        .where(eq(schema.imports.id, importRow.id))
      throw new Error(message)
    }
    reservedTransactionIds.add(candidate.id)
    assignments.set(observation.id, {
      transactionId: candidate.id,
      externalId: observation.externalId,
    })
  }

  return assignments
}

export async function commitImport(
  importId: string,
  manualReviewConfirmed = false,
) {
  await ensureDatabase()
  const importRows = await db
    .select()
    .from(schema.imports)
    .where(eq(schema.imports.id, importId))
    .limit(1)
  if (!importRows[0]) throw new Error('Importação não encontrada.')
  let importRow: typeof schema.imports.$inferSelect = importRows[0]
  if (importRow.status === 'committed' || importRow.status === 'evidence') {
    return { committed: 0, reused: true }
  }
  if (importRow.status !== 'review') {
    throw new Error('Somente lotes em revisão podem ser consolidados.')
  }
  if (isDependentBatchEvidence(importRow)) {
    throw new Error(
      'Este arquivo está aguardando o documento principal do mesmo lote. Consolide ou rejeite o documento principal primeiro.',
    )
  }
  const source = await db
    .select({
      sha256: schema.sourceFiles.sha256,
      storagePath: schema.sourceFiles.storagePath,
      originalName: schema.sourceFiles.originalName,
    })
    .from(schema.sourceFiles)
    .where(eq(schema.sourceFiles.id, importRow.sourceFileId))
    .limit(1)
  if (!source[0]) throw new Error('Arquivo original não encontrado.')

  if (importRow.parser === 'csv') {
    const targetType = importRow.accountId ? 'account' : 'card'
    const statement = parseCsvStatement(
      await readFile(source[0].storagePath),
      targetType,
      source[0].originalName,
    )
    const accountIdentifiers = importRow.accountId
      ? await db
          .select({ externalId: schema.accounts.externalId })
          .from(schema.accounts)
          .where(eq(schema.accounts.id, importRow.accountId))
          .limit(1)
      : []
    const cardIdentifiers = importRow.creditCardId
      ? [
          ...(await db
            .select({ lastFour: schema.creditCards.lastFour })
            .from(schema.creditCards)
            .where(eq(schema.creditCards.id, importRow.creditCardId))
            .limit(1)),
          ...(await db
            .select({ lastFour: schema.creditCardInstruments.lastFour })
            .from(schema.creditCardInstruments)
            .where(
              eq(
                schema.creditCardInstruments.creditCardId,
                importRow.creditCardId,
              ),
            )),
        ]
      : []
    const targetIdentifiers = [
      ...accountIdentifiers.map((item) => item.externalId),
      ...cardIdentifiers.map((item) => item.lastFour),
    ]
    if (
      statement.detectedLastFour &&
      targetIdentifiers.some(Boolean) &&
      !matchesDocumentLastFour(statement.detectedLastFour, targetIdentifiers)
    ) {
      const targetLastFour = targetIdentifiers
        .map(normalizeLastFour)
        .find(Boolean)
      throw new Error(
        `O CSV termina em •${statement.detectedLastFour}, mas o destino selecionado termina em •${targetLastFour}.`,
      )
    }
    const preserveConfirmedPeriod = Boolean(
      importRow.periodStart &&
      importRow.periodEnd &&
      (importRow.periodSource === 'user' ||
        (importRow.periodSource === 'filename' &&
          statement.periodSource === 'activity' &&
          (!statement.activityStart ||
            importRow.periodStart <= statement.activityStart) &&
          (!statement.activityEnd ||
            importRow.periodEnd >= statement.activityEnd))),
    )
    const preserveReconciledPdfControl = Boolean(
      importRow.batchId &&
      importRow.validationStatus === 'reconciled' &&
      importRow.closingBalanceCents !== null &&
      importRow.balanceAsOf,
    )
    const refreshedControls = {
      closingBalanceCents: preserveReconciledPdfControl
        ? importRow.closingBalanceCents
        : statement.closingBalanceCents,
      closingBalanceType: preserveReconciledPdfControl
        ? importRow.closingBalanceType
        : statement.closingBalanceCents === null
          ? null
          : importRow.creditCardId
            ? ('card_statement' as const)
            : ('posted' as const),
      balanceAsOf: preserveReconciledPdfControl
        ? importRow.balanceAsOf
        : statement.balanceAsOf,
      periodStart: preserveConfirmedPeriod
        ? importRow.periodStart
        : statement.periodStart,
      periodEnd: preserveConfirmedPeriod
        ? importRow.periodEnd
        : statement.periodEnd,
      activityStart: statement.activityStart,
      activityEnd: statement.activityEnd,
      periodSource: preserveConfirmedPeriod
        ? importRow.periodSource
        : statement.periodSource,
      coverageConfidence: preserveConfirmedPeriod
        ? 'high'
        : statement.coverageConfidence,
      detectedLastFour: statement.detectedLastFour,
    }
    await db
      .update(schema.imports)
      .set(refreshedControls)
      .where(eq(schema.imports.id, importId))
    importRow = { ...importRow, ...refreshedControls }
  }

  if (importRow.validationStatus === 'divergent') {
    throw new Error(
      importRow.validationMessage ||
        'A auditoria encontrou uma divergência. Revise ou rejeite este lote antes de continuar.',
    )
  }
  if (
    importRow.periodSource === 'activity' ||
    importRow.periodSource === 'unknown'
  ) {
    throw new Error(
      'Confirme o período exportado antes de consolidar. Os dias com movimentação não provam, sozinhos, a cobertura do arquivo.',
    )
  }
  const staged = await db
    .select()
    .from(schema.stagedTransactions)
    .where(eq(schema.stagedTransactions.importId, importId))
  const incompleteTransfer = staged.find(
    (item) =>
      !item.duplicate &&
      item.suggestedCategoryId === 'transfer' &&
      !item.counterpartyAccountId,
  )
  if (incompleteTransfer) {
    throw new Error(
      `Selecione a conta relacionada à transferência "${incompleteTransfer.description}" antes de consolidar.`,
    )
  }
  if (
    importRow.parser === 'pdf_inspector' &&
    (importRow.creditCardId || importRow.accountId) &&
    importRow.closingBalanceCents !== null &&
    importRow.closingBalanceType !== 'available' &&
    importRow.balanceAsOf
  ) {
    await reconcileCsvWithPdfControl({
      importIds: [importId],
      targetType: importRow.accountId ? 'account' : 'card',
      targetId: importRow.accountId ?? importRow.creditCardId!,
      finalize: true,
    })
    const refreshed = await db
      .select()
      .from(schema.imports)
      .where(eq(schema.imports.id, importId))
      .limit(1)
    importRow = refreshed[0]
    if (importRow.status === 'committed' || importRow.status === 'evidence') {
      const postCommit = await finalizeImportAfterCommit(importRow.batchId)
      const created = await db
        .select({ count: sql<number>`count(*)` })
        .from(schema.transactions)
        .where(eq(schema.transactions.importId, importId))
      return {
        committed: Number(created[0]?.count ?? 0),
        reused: false,
        postCommit,
      }
    }
    if (importRow.validationStatus === 'divergent') {
      throw new Error(
        importRow.validationMessage ||
          'O documento ainda tem observações sem vínculo. Resolva as diferenças antes de consolidar.',
      )
    }
  }
  const targetFilter = importRow.accountId
    ? eq(schema.transactions.accountId, importRow.accountId)
    : eq(schema.transactions.creditCardId, importRow.creditCardId!)
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
  const closedCycleAssignments = await matchStructuredImportToTrustedControls(
    importRow,
    staged,
    existingTransactions,
  )
  const knownEvidenceVersions = existingTransactions.length
    ? await db
        .select({
          transactionId: schema.transactionEvidence.transactionId,
          fingerprint: schema.stagedTransactions.fingerprint,
        })
        .from(schema.transactionEvidence)
        .innerJoin(
          schema.stagedTransactions,
          eq(
            schema.stagedTransactions.id,
            schema.transactionEvidence.stagedTransactionId,
          ),
        )
        .innerJoin(
          schema.imports,
          eq(schema.imports.id, schema.stagedTransactions.importId),
        )
        .leftJoin(
          schema.transactionCorrections,
          eq(
            schema.transactionCorrections.stagedTransactionId,
            schema.stagedTransactions.id,
          ),
        )
        .where(
          and(
            inArray(
              schema.transactionEvidence.transactionId,
              existingTransactions.map((transaction) => transaction.id),
            ),
            or(
              inArray(schema.imports.status, ['committed', 'evidence']),
              and(
                eq(schema.imports.status, 'review'),
                inArray(schema.transactionCorrections.status, [
                  'accepted',
                  'rejected',
                ]),
              ),
            ),
          ),
        )
    : []
  const externalById = new Map(
    existingTransactions
      .filter(
        (
          transaction,
        ): transaction is typeof transaction & { externalId: string } =>
          Boolean(transaction.externalId),
      )
      .map((transaction) => [transaction.externalId, transaction]),
  )
  for (const item of staged) {
    const existing = item.externalId
      ? externalById.get(item.externalId)
      : undefined
    const knownHistoricalVersion = existing
      ? knownEvidenceVersions.some(
          (version) =>
            version.transactionId === existing.id &&
            version.fingerprint === item.fingerprint,
        )
      : false
    if (
      existing &&
      existing.fingerprint !== item.fingerprint &&
      !knownHistoricalVersion &&
      !closedCycleAssignments.has(item.id)
    ) {
      await db
        .insert(schema.transactionCorrections)
        .values({
          id: randomUUID(),
          stagedTransactionId: item.id,
          transactionId: existing.id,
          previousJson: JSON.stringify({
            postedAt: existing.postedAt,
            description: existing.description,
            amountCents: existing.amountCents,
            currency: existing.currency,
            fingerprint: existing.fingerprint,
          }),
          proposedJson: JSON.stringify({
            postedAt: item.postedAt,
            description: item.description,
            amountCents: item.amountCents,
            currency: item.currency,
            fingerprint: item.fingerprint,
          }),
        })
        .onConflictDoNothing()
      await db
        .update(schema.imports)
        .set({
          validationStatus: 'divergent',
          validationMessage:
            'O banco reenviou uma transação identificada com dados diferentes. A correção ficou pendente de revisão; o lançamento atual não foi alterado.',
        })
        .where(eq(schema.imports.id, importId))
      throw new Error(
        'O banco reenviou uma transação com dados diferentes. Revise a correção pendente; nada foi alterado no histórico.',
      )
    }
  }
  const hasReliableCoverage = Boolean(
    importRow.periodStart && importRow.periodEnd,
  )
  const promotedExternalIds = new Map(
    [...closedCycleAssignments.values()].flatMap((assignment) =>
      assignment.externalId
        ? [[assignment.transactionId, assignment.externalId] as const]
        : [],
    ),
  )
  const effectiveExistingTransactions = existingTransactions.map(
    (transaction) => ({
      ...transaction,
      externalId:
        promotedExternalIds.get(transaction.id) ?? transaction.externalId,
    }),
  )
  const duplicateReasons = identifyDuplicateReasons(
    staged,
    effectiveExistingTransactions.filter(
      (transaction) =>
        Boolean(transaction.externalId) ||
        (hasReliableCoverage &&
          transaction.postedAt >= importRow.periodStart! &&
          transaction.postedAt <= importRow.periodEnd!),
    ),
  )
  for (const [index, item] of staged.entries()) {
    if (!closedCycleAssignments.has(item.id)) continue
    duplicateReasons[index] = item.externalId
      ? 'external_id'
      : 'fingerprint_overlap'
  }
  const accountAnchor = importRow.accountId
    ? await db
        .select({
          balanceCents: schema.accounts.statementBalanceCents,
          balanceAt: schema.accounts.statementBalanceAt,
        })
        .from(schema.accounts)
        .where(eq(schema.accounts.id, importRow.accountId))
        .limit(1)
    : []
  const anchor = accountAnchor.at(0)
  const existingMovementCents = anchor?.balanceAt
    ? existingTransactions
        .filter(
          (transaction) =>
            transaction.status === 'confirmed' &&
            transaction.postedAt > anchor.balanceAt! &&
            (!importRow.balanceAsOf ||
              transaction.postedAt <= importRow.balanceAsOf),
        )
        .reduce((sum, transaction) => sum + transaction.amountCents, 0)
    : 0
  const newMovementCents = importRow.creditCardId
    ? staged.reduce((sum, item) => sum + item.amountCents, 0)
    : staged
        .filter(
          (item, index) =>
            !duplicateReasons[index] &&
            (!anchor?.balanceAt || item.postedAt > anchor.balanceAt) &&
            (!importRow.balanceAsOf || item.postedAt <= importRow.balanceAsOf),
        )
        .reduce((sum, item) => sum + item.amountCents, 0)
  const audit = evaluateImportAudit({
    targetType: importRow.accountId ? 'account' : 'card',
    sourceTransactionCount: importRow.sourceTransactionCount,
    parsedTransactionCount: importRow.parsedTransactionCount,
    invalidTransactionCount: importRow.invalidTransactionCount,
    openingBalanceCents: importRow.openingBalanceCents,
    openingBalanceAt: importRow.openingBalanceAt,
    closingBalanceCents:
      importRow.closingBalanceType === 'available'
        ? null
        : importRow.closingBalanceCents,
    balanceAsOf: importRow.balanceAsOf,
    statementPeriodStart: importRow.periodStart,
    anchorBalanceCents: anchor?.balanceCents ?? null,
    anchorBalanceAt: anchor?.balanceAt ?? null,
    existingMovementCents,
    newMovementCents,
    documentMovementCents: staged.reduce(
      (sum, item) => sum + item.amountCents,
      0,
    ),
  })
  if (!canCommitImportAudit(audit.status, manualReviewConfirmed)) {
    await db
      .update(schema.imports)
      .set({
        validationStatus: audit.status,
        validationMessage: audit.message,
        expectedBalanceCents: audit.expectedBalanceCents,
        balanceDifferenceCents: audit.balanceDifferenceCents,
      })
      .where(eq(schema.imports.id, importId))
    throw new Error(
      audit.status === 'warning'
        ? `Confirme a revisão manual antes de consolidar. ${audit.message}`
        : audit.message,
    )
  }
  const checkpointBalanceType = importRow.creditCardId
    ? ('card_statement' as const)
    : importRow.closingBalanceType === 'available'
      ? ('available' as const)
      : ('posted' as const)
  const checkpointAtDate =
    importRow.closingBalanceCents !== null && importRow.balanceAsOf
      ? classifyCheckpointAtDate(
          await db
            .select()
            .from(schema.balanceCheckpoints)
            .where(
              importRow.accountId
                ? eq(schema.balanceCheckpoints.accountId, importRow.accountId)
                : eq(
                    schema.balanceCheckpoints.creditCardId,
                    importRow.creditCardId!,
                  ),
            ),
          {
            balanceType: checkpointBalanceType,
            balanceCents: importRow.closingBalanceCents,
            asOf: importRow.balanceAsOf,
          },
        )
      : { status: 'none' as const, checkpointId: null }
  if (checkpointAtDate.status === 'conflict') {
    const message =
      'Já existe outro saldo ativo deste tipo para a mesma data. Invalide o ponto anterior antes de consolidar este arquivo.'
    await db
      .update(schema.imports)
      .set({ validationStatus: 'divergent', validationMessage: message })
      .where(eq(schema.imports.id, importId))
    throw new Error(message)
  }
  const checkpointControlImport =
    importRow.batchId &&
    (importRow.parser === 'csv' || importRow.parser === 'ofx') &&
    importRow.closingBalanceCents !== null &&
    importRow.balanceAsOf
      ? (
          await db
            .select()
            .from(schema.imports)
            .where(eq(schema.imports.batchId, importRow.batchId))
        ).find(
          (candidate) =>
            candidate.parser === 'pdf_inspector' &&
            candidate.status === 'review' &&
            candidate.dependsOnImportId === importId &&
            candidate.closingBalanceCents === importRow.closingBalanceCents &&
            candidate.balanceAsOf === importRow.balanceAsOf,
        )
      : null
  const checkpointImportId = checkpointControlImport?.id ?? importId
  const checkpointSource = checkpointControlImport
    ? ('pdf' as const)
    : importRow.parser === 'ofx'
      ? ('ofx' as const)
      : importRow.parser === 'csv'
        ? ('csv' as const)
        : ('pdf' as const)
  const dependentImports = importRow.batchId
    ? (
        await db
          .select()
          .from(schema.imports)
          .where(eq(schema.imports.batchId, importRow.batchId))
      ).filter(
        (candidate) =>
          candidate.status === 'review' &&
          candidate.dependsOnImportId === importId,
      )
    : []
  const dependentStaged = dependentImports.length
    ? await db
        .select()
        .from(schema.stagedTransactions)
        .where(
          inArray(
            schema.stagedTransactions.importId,
            dependentImports.map((candidate) => candidate.id),
          ),
        )
    : []
  const prepared: Array<typeof schema.transactions.$inferInsert> = []
  const createdTransactionByStagedId = new Map<string, string>()
  const detectedInstallments: Array<
    typeof schema.installmentPlans.$inferInsert
  > = []
  const sourceOccurrences = new Map<string, number>()
  for (const [index, item] of staged.entries()) {
    if (duplicateReasons[index]) continue
    let baseAmountCents: number | null = item.amountCents
    let exchangeRateMicros: number | null = 1_000_000
    if (item.currency === 'USD') {
      exchangeRateMicros = await fetchPtax(item.postedAt.slice(0, 10))
      baseAmountCents = exchangeRateMicros
        ? convertMinorUnitsAtRate(
            item.amountCents,
            item.currency,
            'BRL',
            exchangeRateMicros,
          )
        : null
    } else if (item.currency !== 'BRL') {
      baseAmountCents = null
      exchangeRateMicros = null
    }
    const transactionId = randomUUID()
    const occurrence = (sourceOccurrences.get(item.fingerprint) ?? 0) + 1
    sourceOccurrences.set(item.fingerprint, occurrence)
    const targetKey = importRow.accountId
      ? `account:${importRow.accountId}`
      : `card:${importRow.creditCardId}`
    const sourceKey = item.externalId
      ? `${targetKey}:external:${item.externalId}`
      : `${targetKey}:file:${source[0].sha256}:${item.fingerprint}:${occurrence}`
    prepared.push({
      id: transactionId,
      importId,
      accountId: importRow.accountId,
      creditCardId: importRow.creditCardId,
      categoryId: item.suggestedCategoryId,
      counterpartyAccountId: item.counterpartyAccountId,
      externalId: item.externalId,
      sourceKey,
      fingerprint: item.fingerprint,
      postedAt: item.postedAt,
      description: item.description,
      normalizedDescription: item.normalizedDescription,
      amountCents: item.amountCents,
      currency: item.currency,
      baseAmountCents,
      exchangeRateMicros,
      status:
        importRow.creditCardId && importRow.closingBalanceCents === null
          ? 'pending'
          : 'confirmed',
    })
    createdTransactionByStagedId.set(item.id, transactionId)
    const installment =
      importRow.creditCardId && item.amountCents < 0
        ? parseInstallmentDescription(item.description)
        : null
    if (importRow.creditCardId && installment) {
      detectedInstallments.push({
        id: randomUUID(),
        creditCardId: importRow.creditCardId,
        sourceTransactionId: transactionId,
        description: installment.cleanDescription,
        categoryId: item.suggestedCategoryId,
        installmentAmountCents: Math.abs(item.amountCents),
        totalInstallments: installment.totalInstallments,
        currentInstallment: installment.currentInstallment,
        firstChargeDate: item.postedAt,
        autoDetected: true,
      })
    }
  }

  const claimedExternalIds = new Map(
    [...existingTransactions, ...prepared].flatMap((candidate) =>
      candidate.externalId
        ? [[candidate.externalId, candidate.id] as const]
        : [],
    ),
  )
  const externalIdByTransactionId = new Map(
    [...existingTransactions, ...prepared].flatMap((candidate) =>
      candidate.externalId
        ? [[candidate.id, candidate.externalId] as const]
        : [],
    ),
  )

  db.transaction((transaction) => {
    if (
      importRow.creditCardId &&
      importRow.closingBalanceCents !== null &&
      importRow.periodStart &&
      importRow.periodEnd &&
      (importRow.periodSource === 'metadata' ||
        importRow.periodSource === 'filename' ||
        importRow.periodSource === 'user')
    ) {
      transaction
        .insert(schema.cardStatementCycles)
        .values({
          id: randomUUID(),
          creditCardId: importRow.creditCardId,
          importId: checkpointImportId,
          periodStart: importRow.periodStart,
          periodEnd: importRow.periodEnd,
          closingDate: importRow.balanceAsOf,
          dueDate: importRow.statementDueDate,
          totalCents: importRow.closingBalanceCents,
          status: audit.status === 'reconciled' ? 'reconciled' : 'closed',
        })
        .onConflictDoUpdate({
          target: [
            schema.cardStatementCycles.creditCardId,
            schema.cardStatementCycles.periodStart,
            schema.cardStatementCycles.periodEnd,
          ],
          set: {
            importId: checkpointImportId,
            closingDate: importRow.balanceAsOf,
            dueDate: importRow.statementDueDate,
            totalCents: importRow.closingBalanceCents,
            status: audit.status === 'reconciled' ? 'reconciled' : 'closed',
          },
        })
        .run()
    }
    if (importRow.accountId) {
      for (const item of staged) {
        if (
          item.suggestedCategoryId !== 'transfer' ||
          !item.counterpartyAccountId ||
          item.counterpartyAccountId === importRow.accountId
        ) {
          continue
        }
        const direction = item.amountCents < 0 ? 'outgoing' : 'incoming'
        transaction
          .insert(schema.categorizationRules)
          .values({
            id: randomUUID(),
            pattern: item.normalizedDescription,
            accountId: importRow.accountId,
            counterpartyAccountId: item.counterpartyAccountId,
            direction,
            categoryId: 'transfer',
            priority: 5,
          })
          .onConflictDoUpdate({
            target: [
              schema.categorizationRules.pattern,
              schema.categorizationRules.accountId,
              schema.categorizationRules.direction,
            ],
            set: {
              counterpartyAccountId: item.counterpartyAccountId,
              categoryId: 'transfer',
              priority: 5,
              active: true,
            },
          })
          .run()
      }
    }
    for (const [index, item] of staged.entries()) {
      transaction
        .update(schema.stagedTransactions)
        .set({
          duplicate: duplicateReasons[index] !== null,
          duplicateReason: duplicateReasons[index],
        })
        .where(eq(schema.stagedTransactions.id, item.id))
        .run()
    }
    if (prepared.length) {
      transaction.insert(schema.transactions).values(prepared).run()
    }
    const preassigned = new Map(
      [...closedCycleAssignments.entries()].map(([stagedId, assignment]) => [
        stagedId,
        assignment.transactionId,
      ]),
    )
    for (const assignment of closedCycleAssignments.values()) {
      if (!assignment.externalId) continue
      transaction
        .update(schema.transactions)
        .set({ externalId: assignment.externalId })
        .where(
          and(
            eq(schema.transactions.id, assignment.transactionId),
            sql`${schema.transactions.externalId} is null`,
          ),
        )
        .run()
    }
    const evidenceAssignments = resolveCanonicalAssignments({
      observations: staged,
      transactions: effectiveExistingTransactions,
      duplicateReasons,
      preassigned,
    })
    const restoredTransactionIds = [
      ...new Set(
        [...evidenceAssignments.values()].filter((transactionId) =>
          existingTransactions.some(
            (candidate) =>
              candidate.id === transactionId && candidate.status === 'excluded',
          ),
        ),
      ),
    ]
    if (restoredTransactionIds.length) {
      const restoredObservations = staged.filter(
        (item) =>
          evidenceAssignments.get(item.id) &&
          restoredTransactionIds.includes(evidenceAssignments.get(item.id)!),
      )
      const affectedFrom = restoredObservations
        .map((item) => item.postedAt)
        .sort()
        .at(0)!
      const activeExclusions = transaction
        .select()
        .from(schema.statementExclusions)
        .where(
          and(
            inArray(
              schema.statementExclusions.transactionId,
              restoredTransactionIds,
            ),
            sql`${schema.statementExclusions.reversedAt} is null`,
          ),
        )
        .all()
      if (activeExclusions.length) {
        transaction
          .update(schema.statementExclusions)
          .set({
            reversedAt: new Date(),
            reason: sql`${schema.statementExclusions.reason} || ' Reaberta automaticamente porque uma importação posterior comprovou a movimentação.'`,
          })
          .where(
            inArray(
              schema.statementExclusions.id,
              activeExclusions.map((exclusion) => exclusion.id),
            ),
          )
          .run()
        transaction
          .update(schema.imports)
          .set({
            validationStatus: 'warning',
            validationMessage:
              'Uma movimentação antes marcada como autorização ausente apareceu em uma importação posterior. O fechamento e os saldos seguintes foram reabertos para conferência.',
          })
          .where(
            inArray(schema.imports.id, [
              ...new Set(activeExclusions.map((item) => item.importId)),
            ]),
          )
          .run()
      }
      transaction
        .update(schema.transactions)
        .set({
          status:
            importRow.creditCardId && importRow.closingBalanceCents === null
              ? 'pending'
              : 'confirmed',
        })
        .where(inArray(schema.transactions.id, restoredTransactionIds))
        .run()
      const affectedGroupIds = transaction
        .select({ groupId: schema.reconciliationLinks.groupId })
        .from(schema.reconciliationLinks)
        .where(
          inArray(
            schema.reconciliationLinks.transactionId,
            restoredTransactionIds,
          ),
        )
        .all()
      const linkedGroups = affectedGroupIds.length
        ? transaction
            .select({
              groupId: schema.reconciliationLinks.groupId,
              transactionId: schema.reconciliationLinks.transactionId,
              previousCategoryId: schema.reconciliationLinks.previousCategoryId,
              status: schema.reconciliationGroups.status,
            })
            .from(schema.reconciliationLinks)
            .innerJoin(
              schema.reconciliationGroups,
              eq(
                schema.reconciliationGroups.id,
                schema.reconciliationLinks.groupId,
              ),
            )
            .where(
              inArray(schema.reconciliationLinks.groupId, [
                ...new Set(affectedGroupIds.map((item) => item.groupId)),
              ]),
            )
            .all()
        : []
      for (const link of linkedGroups) {
        if (link.status !== 'confirmed') continue
        transaction
          .update(schema.transactions)
          .set({ categoryId: link.previousCategoryId })
          .where(eq(schema.transactions.id, link.transactionId))
          .run()
      }
      if (linkedGroups.length) {
        transaction
          .update(schema.reconciliationGroups)
          .set({
            status: 'suggested',
            aiValidation: null,
            aiConfidence: null,
            aiReason: null,
            aiValidatedAt: null,
            reason:
              'Reaberta porque uma movimentação antes excluída reapareceu em uma importação posterior.',
          })
          .where(
            inArray(schema.reconciliationGroups.id, [
              ...new Set(linkedGroups.map((link) => link.groupId)),
            ]),
          )
          .run()
      }
      if (importRow.creditCardId) {
        transaction
          .update(schema.cardStatementCycles)
          .set({ status: 'closed' })
          .where(
            and(
              eq(
                schema.cardStatementCycles.creditCardId,
                importRow.creditCardId,
              ),
              gte(schema.cardStatementCycles.periodEnd, affectedFrom),
            ),
          )
          .run()
      }
      const target = importRow.accountId
        ? {
            targetType: 'account' as const,
            targetId: importRow.accountId,
            balanceType: 'posted' as const,
          }
        : {
            targetType: 'card' as const,
            targetId: importRow.creditCardId!,
            balanceType: 'card_statement' as const,
          }
      invalidateCheckpointChain(transaction, {
        ...target,
        from: affectedFrom,
        reason:
          'Uma movimentação antes excluída reapareceu em uma importação posterior.',
      })
      refreshStatementAnchor(transaction, target)
    }
    for (const [index, item] of staged.entries()) {
      const duplicateReason = duplicateReasons[index]
      const transactionId = duplicateReason
        ? evidenceAssignments.get(item.id)
        : createdTransactionByStagedId.get(item.id)
      if (!transactionId) continue
      linkCanonicalObservation(transaction, {
        stagedTransactionId: item.id,
        transactionId,
        matchKind: canonicalEvidenceKind({
          controlled: closedCycleAssignments.has(item.id),
          duplicateReason,
        }),
        externalId:
          duplicateReason === 'fingerprint_overlap' ? item.externalId : null,
      })
    }
    const canonicalObservations = staged.flatMap((item, index) => {
      const transactionId = duplicateReasons[index]
        ? evidenceAssignments.get(item.id)
        : createdTransactionByStagedId.get(item.id)
      return transactionId ? [{ item, transactionId }] : []
    })
    for (const dependentImport of dependentImports) {
      const available = new Map<string, string[]>()
      for (const canonical of canonicalObservations) {
        const signature = statementValueSignature(canonical.item)
        const transactionIds = available.get(signature) ?? []
        transactionIds.push(canonical.transactionId)
        available.set(signature, transactionIds)
      }
      const observations = dependentStaged.filter(
        (item) => item.importId === dependentImport.id,
      )
      for (const observation of observations) {
        const transactionId = available
          .get(statementValueSignature(observation))
          ?.shift()
        if (!transactionId) {
          throw new Error(
            'O arquivo dependente deixou de corresponder ao documento principal. Nenhuma alteração foi aplicada; refaça o lote.',
          )
        }
        if (observation.externalId) {
          const conflictingOwner = claimedExternalIds.get(
            observation.externalId,
          )
          const currentExternalId = externalIdByTransactionId.get(transactionId)
          if (
            (conflictingOwner && conflictingOwner !== transactionId) ||
            (currentExternalId && currentExternalId !== observation.externalId)
          ) {
            throw new Error(
              'O identificador bancário do arquivo relacionado já pertence a outro lançamento. Nenhuma alteração foi aplicada; revise o lote.',
            )
          }
          transaction
            .update(schema.transactions)
            .set({ externalId: observation.externalId })
            .where(
              and(
                eq(schema.transactions.id, transactionId),
                sql`${schema.transactions.externalId} is null`,
              ),
            )
            .run()
          claimedExternalIds.set(observation.externalId, transactionId)
          externalIdByTransactionId.set(transactionId, observation.externalId)
        }
        linkCanonicalObservation(transaction, {
          stagedTransactionId: observation.id,
          transactionId,
          matchKind: 'statement_control',
          duplicate: true,
          duplicateReason: null,
        })
      }
      const dependentStatusUpdate = transaction
        .update(schema.imports)
        .set({
          status: 'evidence',
          committedAt: new Date(),
          validationMessage:
            'Arquivo preservado como evidência do documento principal consolidado, sem criar lançamentos duplicados.',
        })
        .where(
          and(
            eq(schema.imports.id, dependentImport.id),
            eq(schema.imports.status, 'review'),
          ),
        )
        .run()
      if (dependentStatusUpdate.changes !== 1) {
        throw new Error(
          'Um arquivo relacionado saiu da revisão durante a consolidação. Nenhuma alteração foi aplicada; atualize a página.',
        )
      }
    }
    if (detectedInstallments.length) {
      transaction
        .insert(schema.installmentPlans)
        .values(detectedInstallments)
        .onConflictDoNothing()
        .run()
    }
    const importStatusUpdate = transaction
      .update(schema.imports)
      .set({
        status: prepared.length ? 'committed' : 'evidence',
        committedAt: new Date(),
        validationStatus: audit.status,
        validationMessage: audit.message,
        expectedBalanceCents: audit.expectedBalanceCents,
        balanceDifferenceCents: audit.balanceDifferenceCents,
      })
      .where(
        and(
          eq(schema.imports.id, importId),
          eq(schema.imports.status, 'review'),
        ),
      )
      .run()
    if (importStatusUpdate.changes !== 1) {
      throw new Error(
        'A importação saiu da revisão enquanto era consolidada. Nenhum lançamento foi alterado; atualize a página.',
      )
    }
    if (
      importRow.accountId &&
      importRow.closingBalanceCents !== null &&
      importRow.balanceAsOf
    ) {
      const account = transaction
        .select({
          statementBalanceAt: schema.accounts.statementBalanceAt,
          coverageStart: schema.accounts.coverageStart,
        })
        .from(schema.accounts)
        .where(eq(schema.accounts.id, importRow.accountId))
        .get()
      if (
        importRow.closingBalanceType !== 'available' &&
        (!account?.statementBalanceAt ||
          account.statementBalanceAt < importRow.balanceAsOf)
      ) {
        transaction
          .update(schema.accounts)
          .set({
            statementBalanceCents: importRow.closingBalanceCents,
            statementBalanceAt: importRow.balanceAsOf,
            coverageStart:
              account?.coverageStart ??
              importRow.periodStart ??
              importRow.balanceAsOf,
          })
          .where(eq(schema.accounts.id, importRow.accountId))
          .run()
      }
      if (checkpointAtDate.status === 'none') {
        const isAvailableBalance = importRow.closingBalanceType === 'available'
        addBalanceCheckpoint(transaction, {
          accountId: importRow.accountId,
          importId: checkpointImportId,
          kind: 'statement_closing',
          balanceType: isAvailableBalance ? 'available' : 'posted',
          source: checkpointSource,
          reviewState:
            !isAvailableBalance && audit.status === 'reconciled'
              ? 'verified'
              : 'observed',
          balanceCents: importRow.closingBalanceCents,
          asOf: importRow.balanceAsOf,
          verified: !isAvailableBalance && audit.status === 'reconciled',
          differenceCents: isAvailableBalance
            ? null
            : audit.balanceDifferenceCents,
        })
      }
    }
    if (
      importRow.creditCardId &&
      importRow.closingBalanceCents !== null &&
      importRow.balanceAsOf
    ) {
      const card = transaction
        .select({
          coverageStart: schema.creditCards.coverageStart,
          dueDay: schema.creditCards.dueDay,
          statementBalanceAt: schema.creditCards.statementBalanceAt,
        })
        .from(schema.creditCards)
        .where(eq(schema.creditCards.id, importRow.creditCardId))
        .get()
      if (
        !card?.statementBalanceAt ||
        card.statementBalanceAt < importRow.balanceAsOf
      ) {
        transaction
          .update(schema.creditCards)
          .set({
            statementBalanceCents: importRow.closingBalanceCents,
            statementBalanceAt: importRow.balanceAsOf,
            coverageStart:
              card?.coverageStart ??
              importRow.periodStart ??
              importRow.balanceAsOf,
            dueDay:
              card?.dueDay ??
              (importRow.statementDueDate
                ? Number(importRow.statementDueDate.slice(-2))
                : null),
          })
          .where(eq(schema.creditCards.id, importRow.creditCardId))
          .run()
      }
      if (checkpointAtDate.status === 'none') {
        addBalanceCheckpoint(transaction, {
          creditCardId: importRow.creditCardId,
          importId: checkpointImportId,
          kind: 'statement_closing',
          balanceType: 'card_statement',
          source: checkpointSource,
          reviewState: audit.status === 'reconciled' ? 'verified' : 'observed',
          balanceCents: importRow.closingBalanceCents,
          asOf: importRow.balanceAsOf,
          verified: audit.status === 'reconciled',
          differenceCents: audit.balanceDifferenceCents,
        })
      }
      transaction
        .update(schema.transactions)
        .set({ status: 'confirmed' })
        .where(
          and(
            eq(schema.transactions.creditCardId, importRow.creditCardId),
            eq(schema.transactions.status, 'pending'),
            ...(importRow.periodStart
              ? [gte(schema.transactions.postedAt, importRow.periodStart)]
              : []),
            lte(schema.transactions.postedAt, importRow.balanceAsOf),
          ),
        )
        .run()
    }
  })
  const postCommit = await finalizeImportAfterCommit(importRow.batchId)
  return {
    committed: prepared.length,
    reused: false,
    postCommit,
  }
}

export async function retryImportFinalization(importId: string) {
  await ensureDatabase()
  const importRow = await db
    .select({ status: schema.imports.status, batchId: schema.imports.batchId })
    .from(schema.imports)
    .where(eq(schema.imports.id, importId))
    .limit(1)
  const current = importRow.at(0)
  if (!current) throw new Error('Importação não encontrada.')
  if (current.status !== 'committed' && current.status !== 'evidence') {
    throw new Error('A importação ainda não foi consolidada.')
  }
  return finalizeImportAfterCommit(current.batchId)
}

export async function rejectImport(importId: string) {
  await ensureDatabase()
  const importRow = await db
    .select({ batchId: schema.imports.batchId, status: schema.imports.status })
    .from(schema.imports)
    .where(eq(schema.imports.id, importId))
    .limit(1)
  if (!importRow[0]) throw new Error('Importação não encontrada.')
  const dependentSiblings = importRow[0].batchId
    ? (
        await db
          .select()
          .from(schema.imports)
          .where(eq(schema.imports.batchId, importRow[0].batchId))
      ).filter(
        (candidate) =>
          candidate.status === 'review' &&
          candidate.dependsOnImportId === importId,
      )
    : []
  db.transaction((transaction) => {
    const result = transaction
      .update(schema.imports)
      .set({ status: 'rejected' })
      .where(
        and(
          eq(schema.imports.id, importId),
          eq(schema.imports.status, 'review'),
        ),
      )
      .run()
    if (result.changes !== 1) {
      throw new Error(
        'Apenas uma importação ainda em revisão pode ser rejeitada. Atualize a página para ver o estado atual.',
      )
    }
    for (const sibling of dependentSiblings) {
      const released = transaction
        .update(schema.imports)
        .set({
          dependsOnImportId: null,
          warning: null,
          validationStatus:
            sibling.parser === 'pdf_inspector'
              ? sibling.validationStatus
              : 'imported',
          validationMessage:
            sibling.parser === 'pdf_inspector'
              ? 'O arquivo principal foi rejeitado. Este PDF agora pode ser revisado e consolidado sozinho.'
              : 'O arquivo principal foi rejeitado. Este arquivo estruturado agora pode ser revisado e consolidado sozinho.',
        })
        .where(
          and(
            eq(schema.imports.id, sibling.id),
            eq(schema.imports.status, 'review'),
          ),
        )
        .run()
      if (released.changes !== 1) {
        throw new Error(
          'Um arquivo relacionado saiu da revisão durante a rejeição. Nenhuma alteração foi aplicada; atualize a página.',
        )
      }
    }
  })
  if (importRow[0].batchId) {
    await finishImportBatchIfComplete(importRow[0].batchId)
  }
  return { success: true }
}

export async function replaceConflictingCheckpoint(importId: string) {
  const result = await replaceCheckpointChainForImport(importId)
  const reconciliationRefresh = await refreshReconciliationAfterCommit()
  return { ...result, reconciliationRefresh }
}
export async function confirmImportCoverage(input: {
  importId: string
  periodStart: string
  periodEnd: string
}) {
  const confirmation = await confirmCoveragePeriod(input)
  await reconcileCsvWithPdfControl({
    importIds: confirmation.relatedImportIds,
    targetType: confirmation.targetType,
    targetId: confirmation.targetId,
  })
  if (confirmation.batchId) {
    await refreshImportBatchCoverage({
      batchId: confirmation.batchId,
      mode: 'staged',
    })
  }
  return { success: true }
}

export async function clearTransactionData() {
  await ensureDatabase()
  const storedFiles = await db
    .select({ storagePath: schema.sourceFiles.storagePath })
    .from(schema.sourceFiles)
  const transactionCount = (
    await db.select({ id: schema.transactions.id }).from(schema.transactions)
  ).length
  const importCount = (
    await db.select({ id: schema.imports.id }).from(schema.imports)
  ).length

  db.transaction((transaction) => {
    transaction
      .update(schema.goalContributions)
      .set({ transactionId: null })
      .run()
    transaction.delete(schema.reconciliationLinks).run()
    transaction.delete(schema.reconciliationGroups).run()
    transaction.delete(schema.cardStatementCycles).run()
    transaction.delete(schema.transactionSplits).run()
    transaction.delete(schema.transactionEvidence).run()
    transaction.delete(schema.transactionCorrections).run()
    transaction.delete(schema.transactions).run()
    transaction.delete(schema.balanceCheckpoints).run()
    transaction.delete(schema.stagedTransactions).run()
    transaction.delete(schema.coverageIntervals).run()
    transaction.delete(schema.imports).run()
    transaction.delete(schema.importBatches).run()
    transaction.delete(schema.sourceFiles).run()
    transaction.delete(schema.monthlyBudgets).run()
    transaction
      .update(schema.accounts)
      .set({
        statementBalanceCents: null,
        statementBalanceAt: null,
        coverageStart: null,
      })
      .run()
    transaction
      .update(schema.creditCards)
      .set({
        statementBalanceCents: null,
        statementBalanceAt: null,
        coverageStart: null,
      })
      .run()
  })

  const importsDirectory = resolve(process.cwd(), 'data', 'imports')
  await Promise.allSettled(
    storedFiles.map(async ({ storagePath }) => {
      const absolutePath = resolve(storagePath)
      if (!absolutePath.startsWith(`${importsDirectory}${sep}`)) return
      await unlink(absolutePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
    }),
  )

  return { transactionCount, importCount }
}

export async function getStoredSource(importId: string) {
  await ensureDatabase()
  const rows = await db
    .select({ storagePath: schema.sourceFiles.storagePath })
    .from(schema.imports)
    .innerJoin(
      schema.sourceFiles,
      eq(schema.imports.sourceFileId, schema.sourceFiles.id),
    )
    .where(eq(schema.imports.id, importId))
    .limit(1)
  if (!rows[0]) throw new Error('Arquivo não encontrado.')
  return readFile(rows[0].storagePath)
}
