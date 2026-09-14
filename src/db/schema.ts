import { sql } from 'drizzle-orm'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

import type { ImportAuditReasonCode } from '../domain/import-audit'

const createdAt = integer('created_at', { mode: 'timestamp' })
  .notNull()
  .default(sql`(unixepoch())`)

export const ownershipScopes = sqliteTable('ownership_scopes', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type', {
    enum: ['household', 'person', 'company_br', 'company_us'],
  }).notNull(),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt,
})

export const institutions = sqliteTable('institutions', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  country: text('country').notNull().default('BR'),
  createdAt,
})

export const accounts = sqliteTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    ownershipScopeId: text('ownership_scope_id')
      .notNull()
      .references(() => ownershipScopes.id),
    institutionId: text('institution_id').references(() => institutions.id),
    name: text('name').notNull(),
    kind: text('kind', {
      enum: ['checking', 'savings', 'cash', 'investment'],
    })
      .notNull()
      .default('checking'),
    purpose: text('purpose', {
      enum: ['operating', 'reserve', 'investment'],
    })
      .notNull()
      .default('operating'),
    currency: text('currency').notNull().default('BRL'),
    externalId: text('external_id'),
    initialBalanceCents: integer('initial_balance_cents').notNull().default(0),
    statementBalanceCents: integer('statement_balance_cents'),
    statementBalanceAt: text('statement_balance_at'),
    coverageStart: text('coverage_start'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt,
  },
  (table) => [index('accounts_scope_idx').on(table.ownershipScopeId)],
)

export const creditCards = sqliteTable(
  'credit_cards',
  {
    id: text('id').primaryKey(),
    ownershipScopeId: text('ownership_scope_id')
      .notNull()
      .references(() => ownershipScopes.id),
    institutionId: text('institution_id').references(() => institutions.id),
    name: text('name').notNull(),
    currency: text('currency').notNull().default('BRL'),
    lastFour: text('last_four'),
    limitCents: integer('limit_cents').notNull().default(0),
    closingDay: integer('closing_day').notNull().default(1),
    dueDay: integer('due_day'),
    statementBalanceCents: integer('statement_balance_cents'),
    statementBalanceAt: text('statement_balance_at'),
    coverageStart: text('coverage_start'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt,
  },
  (table) => [index('cards_scope_idx').on(table.ownershipScopeId)],
)

export const creditCardInstruments = sqliteTable(
  'credit_card_instruments',
  {
    id: text('id').primaryKey(),
    creditCardId: text('credit_card_id')
      .notNull()
      .references(() => creditCards.id, { onDelete: 'cascade' }),
    lastFour: text('last_four').notNull(),
    kind: text('kind', { enum: ['physical', 'virtual', 'additional'] })
      .notNull()
      .default('virtual'),
    label: text('label'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt,
  },
  (table) => [
    uniqueIndex('card_instrument_unique_idx').on(
      table.creditCardId,
      table.lastFour,
    ),
  ],
)

export const categories = sqliteTable('categories', {
  id: text('id').primaryKey(),
  parentId: text('parent_id'),
  name: text('name').notNull(),
  bucket: text('bucket', {
    enum: [
      'essential',
      'lifestyle',
      'investment',
      'reserve',
      'income',
      'business',
      'tax',
      'excluded',
    ],
  }).notNull(),
  incomeBaseEligible: integer('income_base_eligible', { mode: 'boolean' })
    .notNull()
    .default(false),
  color: text('color').notNull().default('#64748b'),
  icon: text('icon'),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt,
})

export const sourceFiles = sqliteTable('source_files', {
  id: text('id').primaryKey(),
  sha256: text('sha256').notNull().unique(),
  originalName: text('original_name').notNull(),
  mediaType: text('media_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  storagePath: text('storage_path').notNull(),
  createdAt,
})

export const importBatches = sqliteTable(
  'import_batches',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').references(() => accounts.id),
    creditCardId: text('credit_card_id').references(() => creditCards.id),
    status: text('status', {
      enum: ['processing', 'review', 'committed', 'failed'],
    })
      .notNull()
      .default('processing'),
    coverageStart: text('coverage_start'),
    coverageEnd: text('coverage_end'),
    gapSummaryJson: text('gap_summary_json'),
    createdAt,
  },
  (table) => [
    index('import_batches_status_idx').on(table.status),
    check(
      'import_batches_target_xor',
      sql`(${table.accountId} is not null) != (${table.creditCardId} is not null)`,
    ),
  ],
)

export const imports = sqliteTable(
  'imports',
  {
    id: text('id').primaryKey(),
    sourceFileId: text('source_file_id')
      .notNull()
      .references(() => sourceFiles.id),
    batchId: text('batch_id').references(() => importBatches.id, {
      onDelete: 'cascade',
    }),
    dependsOnImportId: text('depends_on_import_id').references(
      (): AnySQLiteColumn => imports.id,
      { onDelete: 'set null' },
    ),
    accountId: text('account_id').references(() => accounts.id),
    creditCardId: text('credit_card_id').references(() => creditCards.id),
    parser: text('parser', {
      enum: ['ofx', 'csv', 'pdf_inspector', 'pdf_local', 'pdf_ai'],
    }).notNull(),
    documentKind: text('document_kind', {
      enum: ['bank_statement', 'card_statement', 'unknown'],
    })
      .notNull()
      .default('unknown'),
    detectedInstitution: text('detected_institution'),
    detectedLastFour: text('detected_last_four'),
    detectedCurrency: text('detected_currency'),
    pdfType: text('pdf_type'),
    pdfConfidenceBps: integer('pdf_confidence_bps'),
    pageCount: integer('page_count'),
    pagesNeedingOcrJson: text('pages_needing_ocr_json'),
    markdown: text('markdown'),
    positionedTextJson: text('positioned_text_json'),
    extractionDiagnosticsJson: text('extraction_diagnostics_json'),
    openingBalanceCents: integer('opening_balance_cents'),
    openingBalanceAt: text('opening_balance_at'),
    closingBalanceCents: integer('closing_balance_cents'),
    closingBalanceType: text('closing_balance_type', {
      enum: ['posted', 'available', 'card_statement'],
    }),
    balanceAsOf: text('balance_as_of'),
    sourceTransactionCount: integer('source_transaction_count'),
    parsedTransactionCount: integer('parsed_transaction_count')
      .notNull()
      .default(0),
    invalidTransactionCount: integer('invalid_transaction_count')
      .notNull()
      .default(0),
    activityStart: text('activity_start'),
    activityEnd: text('activity_end'),
    periodStart: text('period_start'),
    periodEnd: text('period_end'),
    periodSource: text('period_source', {
      enum: ['metadata', 'filename', 'user', 'activity', 'unknown'],
    })
      .notNull()
      .default('unknown'),
    coverageConfidence: text('coverage_confidence', {
      enum: ['high', 'medium', 'low', 'unknown'],
    })
      .notNull()
      .default('unknown'),
    statementDueDate: text('statement_due_date'),
    totalCreditsCents: integer('total_credits_cents').notNull().default(0),
    totalDebitsCents: integer('total_debits_cents').notNull().default(0),
    netMovementCents: integer('net_movement_cents').notNull().default(0),
    expectedBalanceCents: integer('expected_balance_cents'),
    balanceDifferenceCents: integer('balance_difference_cents'),
    validationStatus: text('validation_status', {
      enum: ['imported', 'reconciled', 'warning', 'divergent'],
    })
      .notNull()
      .default('warning'),
    validationReason: text('validation_reason').$type<ImportAuditReasonCode>(),
    validationMessage: text('validation_message'),
    status: text('status', {
      enum: ['review', 'committed', 'evidence', 'rejected', 'failed'],
    })
      .notNull()
      .default('review'),
    aiConsent: integer('ai_consent', { mode: 'boolean' })
      .notNull()
      .default(false),
    warning: text('warning'),
    committedAt: integer('committed_at', { mode: 'timestamp' }),
    createdAt,
  },
  (table) => [
    index('imports_status_idx').on(table.status),
    index('imports_batch_idx').on(table.batchId),
    check(
      'imports_target_xor',
      sql`(${table.accountId} is not null) != (${table.creditCardId} is not null)`,
    ),
  ],
)

export const coverageIntervals = sqliteTable(
  'coverage_intervals',
  {
    id: text('id').primaryKey(),
    importId: text('import_id')
      .notNull()
      .unique()
      .references(() => imports.id, { onDelete: 'cascade' }),
    accountId: text('account_id').references(() => accounts.id, {
      onDelete: 'cascade',
    }),
    creditCardId: text('credit_card_id').references(() => creditCards.id, {
      onDelete: 'cascade',
    }),
    start: text('start').notNull(),
    end: text('end').notNull(),
    source: text('source', {
      enum: ['metadata', 'filename', 'user'],
    }).notNull(),
    confidence: text('confidence', {
      enum: ['high', 'medium', 'low'],
    }).notNull(),
    createdAt,
  },
  (table) => [
    index('coverage_interval_account_idx').on(table.accountId, table.start),
    index('coverage_interval_card_idx').on(table.creditCardId, table.start),
    check(
      'coverage_intervals_target_xor',
      sql`(${table.accountId} is not null) != (${table.creditCardId} is not null)`,
    ),
    check('coverage_intervals_range', sql`${table.start} <= ${table.end}`),
  ],
)

export const filenameCoverageRules = sqliteTable('filename_coverage_rules', {
  id: text('id').primaryKey(),
  template: text('template').notNull().unique(),
  createdAt,
})

export const cardStatementCycles = sqliteTable(
  'card_statement_cycles',
  {
    id: text('id').primaryKey(),
    creditCardId: text('credit_card_id')
      .notNull()
      .references(() => creditCards.id, { onDelete: 'cascade' }),
    importId: text('import_id').references(() => imports.id, {
      onDelete: 'set null',
    }),
    periodStart: text('period_start').notNull(),
    periodEnd: text('period_end').notNull(),
    closingDate: text('closing_date'),
    issuedAt: text('issued_at'),
    dueDate: text('due_date'),
    totalCents: integer('total_cents'),
    status: text('status', {
      enum: ['open', 'closed', 'reconciled'],
    })
      .notNull()
      .default('open'),
    createdAt,
  },
  (table) => [
    uniqueIndex('card_statement_cycle_period_idx').on(
      table.creditCardId,
      table.periodStart,
      table.periodEnd,
    ),
  ],
)

export const stagedTransactions = sqliteTable(
  'staged_transactions',
  {
    id: text('id').primaryKey(),
    importId: text('import_id')
      .notNull()
      .references(() => imports.id, { onDelete: 'cascade' }),
    externalId: text('external_id'),
    fingerprint: text('fingerprint').notNull(),
    postedAt: text('posted_at').notNull(),
    description: text('description').notNull(),
    normalizedDescription: text('normalized_description').notNull(),
    amountCents: integer('amount_cents').notNull(),
    currency: text('currency').notNull(),
    suggestedCategoryId: text('suggested_category_id').references(
      () => categories.id,
    ),
    counterpartyAccountId: text('counterparty_account_id').references(
      () => accounts.id,
    ),
    suggestionConfidence: integer('suggestion_confidence').default(0),
    suggestionSource: text('suggestion_source', {
      enum: [
        'none',
        'rule',
        'knowledge',
        'history',
        'heuristic',
        'ai',
        'system',
        'manual',
      ],
    })
      .notNull()
      .default('none'),
    duplicate: integer('duplicate', { mode: 'boolean' })
      .notNull()
      .default(false),
    duplicateReason: text('duplicate_reason', {
      enum: ['external_id', 'fingerprint_overlap'],
    }),
    rawJson: text('raw_json'),
    sourcePage: integer('source_page'),
    sourceBoundsJson: text('source_bounds_json'),
    createdAt,
  },
  (table) => [
    index('staged_import_idx').on(table.importId),
    index('staged_fingerprint_idx').on(table.fingerprint),
  ],
)

export const transactions = sqliteTable(
  'transactions',
  {
    id: text('id').primaryKey(),
    importId: text('import_id').references(() => imports.id),
    accountId: text('account_id').references(() => accounts.id),
    creditCardId: text('credit_card_id').references(() => creditCards.id),
    categoryId: text('category_id').references(() => categories.id),
    counterpartyAccountId: text('counterparty_account_id').references(
      () => accounts.id,
    ),
    externalId: text('external_id'),
    sourceKey: text('source_key'),
    fingerprint: text('fingerprint').notNull(),
    postedAt: text('posted_at').notNull(),
    description: text('description').notNull(),
    normalizedDescription: text('normalized_description').notNull(),
    amountCents: integer('amount_cents').notNull(),
    currency: text('currency').notNull(),
    baseAmountCents: integer('base_amount_cents'),
    baseCurrency: text('base_currency').notNull().default('BRL'),
    exchangeRateMicros: integer('exchange_rate_micros'),
    status: text('status', {
      enum: ['pending', 'confirmed', 'excluded'],
    })
      .notNull()
      .default('confirmed'),
    notes: text('notes'),
    createdAt,
  },
  (table) => [
    index('transactions_target_fingerprint_idx').on(
      table.accountId,
      table.creditCardId,
      table.fingerprint,
    ),
    index('transactions_date_idx').on(table.postedAt),
    index('transactions_category_idx').on(table.categoryId),
    uniqueIndex('transactions_source_key_idx').on(table.sourceKey),
    check(
      'transactions_target_xor',
      sql`(${table.accountId} is not null) != (${table.creditCardId} is not null)`,
    ),
  ],
)

export const openFinanceConnections = sqliteTable(
  'open_finance_connections',
  {
    id: text('id').primaryKey(),
    ownershipScopeId: text('ownership_scope_id')
      .notNull()
      .references(() => ownershipScopes.id),
    providerItemId: text('provider_item_id').unique(),
    clientUserId: text('client_user_id').notNull().unique(),
    connectorId: integer('connector_id'),
    connectorName: text('connector_name'),
    connectorImageUrl: text('connector_image_url'),
    status: text('status', {
      enum: [
        'pending',
        'updating',
        'updated',
        'waiting_user_input',
        'waiting_user_action',
        'login_error',
        'outdated',
        'error',
        'disconnected',
      ],
    })
      .notNull()
      .default('pending'),
    executionStatus: text('execution_status'),
    lastSyncedAt: integer('last_synced_at', { mode: 'timestamp' }),
    nextSyncAt: integer('next_sync_at', { mode: 'timestamp' }),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    paused: integer('paused', { mode: 'boolean' }).notNull().default(false),
    disconnectedAt: integer('disconnected_at', { mode: 'timestamp' }),
    createdAt,
  },
  (table) => [
    index('open_finance_connections_scope_idx').on(table.ownershipScopeId),
    index('open_finance_connections_status_idx').on(table.status),
  ],
)

export const openFinanceAccounts = sqliteTable(
  'open_finance_accounts',
  {
    id: text('id').primaryKey(),
    connectionId: text('connection_id')
      .notNull()
      .references(() => openFinanceConnections.id, { onDelete: 'cascade' }),
    providerAccountId: text('provider_account_id').notNull().unique(),
    type: text('type', { enum: ['BANK', 'CREDIT'] }).notNull(),
    subtype: text('subtype').notNull(),
    name: text('name').notNull(),
    currency: text('currency').notNull(),
    lastFour: text('last_four'),
    observedBalanceCents: integer('observed_balance_cents'),
    observedAvailableBalanceCents: integer('observed_available_balance_cents'),
    observedCreditLimitCents: integer('observed_credit_limit_cents'),
    observedAvailableCreditCents: integer('observed_available_credit_cents'),
    observedClosingDate: text('observed_closing_date'),
    observedDueDate: text('observed_due_date'),
    observedAt: integer('observed_at', { mode: 'timestamp' }),
    accountId: text('account_id').references(() => accounts.id, {
      onDelete: 'set null',
    }),
    creditCardId: text('credit_card_id').references(() => creditCards.id, {
      onDelete: 'set null',
    }),
    createdAt,
  },
  (table) => [
    index('open_finance_accounts_connection_idx').on(table.connectionId),
    uniqueIndex('open_finance_accounts_local_account_idx')
      .on(table.accountId)
      .where(sql`${table.accountId} is not null`),
    uniqueIndex('open_finance_accounts_local_card_idx')
      .on(table.creditCardId)
      .where(sql`${table.creditCardId} is not null`),
    check(
      'open_finance_accounts_target_at_most_one',
      sql`not (${table.accountId} is not null and ${table.creditCardId} is not null)`,
    ),
  ],
)

export const openFinanceTransactionObservations = sqliteTable(
  'open_finance_transaction_observations',
  {
    id: text('id').primaryKey(),
    openFinanceAccountId: text('open_finance_account_id')
      .notNull()
      .references(() => openFinanceAccounts.id, { onDelete: 'cascade' }),
    providerTransactionId: text('provider_transaction_id').notNull(),
    contentHash: text('content_hash').notNull(),
    providerStatus: text('provider_status', {
      enum: ['PENDING', 'POSTED', 'DELETED'],
    }).notNull(),
    postedAt: text('posted_at'),
    description: text('description'),
    normalizedDescription: text('normalized_description'),
    amountCents: integer('amount_cents'),
    currency: text('currency'),
    providerCategory: text('provider_category'),
    sanitizedMetadataJson: text('sanitized_metadata_json').notNull(),
    canonicalTransactionId: text('canonical_transaction_id').references(
      () => transactions.id,
      { onDelete: 'set null' },
    ),
    resolution: text('resolution', {
      enum: [
        'evidence',
        'created',
        'correction_pending',
        'accepted',
        'rejected',
        'deleted',
        'preserved',
      ],
    }).notNull(),
    resolvedAt: integer('resolved_at', { mode: 'timestamp' }),
    observedAt: integer('observed_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex('open_finance_observation_version_idx').on(
      table.openFinanceAccountId,
      table.providerTransactionId,
      table.contentHash,
    ),
    index('open_finance_observation_transaction_idx').on(
      table.canonicalTransactionId,
    ),
    index('open_finance_observation_resolution_idx').on(table.resolution),
  ],
)

export const pluggyWebhookEvents = sqliteTable(
  'pluggy_webhook_events',
  {
    eventId: text('event_id').primaryKey(),
    event: text('event').notNull(),
    providerItemId: text('provider_item_id'),
    providerAccountId: text('provider_account_id'),
    payloadJson: text('payload_json').notNull(),
    state: text('state', {
      enum: ['pending', 'processing', 'processed', 'failed'],
    })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    claimedAt: integer('claimed_at', { mode: 'timestamp' }),
    processedAt: integer('processed_at', { mode: 'timestamp' }),
    errorMessage: text('error_message'),
    receivedAt: integer('received_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    index('pluggy_webhook_events_state_idx').on(table.state, table.receivedAt),
    index('pluggy_webhook_events_item_idx').on(table.providerItemId),
  ],
)

export const openFinanceSyncRuns = sqliteTable(
  'open_finance_sync_runs',
  {
    id: text('id').primaryKey(),
    connectionId: text('connection_id')
      .notNull()
      .references(() => openFinanceConnections.id, { onDelete: 'cascade' }),
    trigger: text('trigger', {
      enum: ['bootstrap', 'manual', 'webhook', 'recovery'],
    }).notNull(),
    status: text('status', {
      enum: ['running', 'completed', 'partial', 'failed', 'paused'],
    })
      .notNull()
      .default('running'),
    accountsFetched: integer('accounts_fetched').notNull().default(0),
    transactionsFetched: integer('transactions_fetched').notNull().default(0),
    transactionsCreated: integer('transactions_created').notNull().default(0),
    evidenceAdded: integer('evidence_added').notNull().default(0),
    correctionsPending: integer('corrections_pending').notNull().default(0),
    transactionsDeleted: integer('transactions_deleted').notNull().default(0),
    errorMessage: text('error_message'),
    startedAt: integer('started_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    finishedAt: integer('finished_at', { mode: 'timestamp' }),
  },
  (table) => [
    index('open_finance_sync_runs_connection_idx').on(
      table.connectionId,
      table.startedAt,
    ),
  ],
)

export const transactionEvidence = sqliteTable(
  'transaction_evidence',
  {
    id: text('id').primaryKey(),
    stagedTransactionId: text('staged_transaction_id')
      .notNull()
      .unique()
      .references(() => stagedTransactions.id, { onDelete: 'cascade' }),
    transactionId: text('transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    matchKind: text('match_kind', {
      enum: [
        'created',
        'external_id',
        'exact_overlap',
        'manual_correction',
        'rejected_correction',
        'statement_control',
      ],
    }).notNull(),
    createdAt,
  },
  (table) => [
    index('transaction_evidence_transaction_idx').on(table.transactionId),
  ],
)

export const transactionCorrections = sqliteTable(
  'transaction_corrections',
  {
    id: text('id').primaryKey(),
    stagedTransactionId: text('staged_transaction_id')
      .notNull()
      .unique()
      .references(() => stagedTransactions.id, { onDelete: 'cascade' }),
    transactionId: text('transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    status: text('status', {
      enum: ['pending', 'accepted', 'rejected'],
    })
      .notNull()
      .default('pending'),
    previousJson: text('previous_json').notNull(),
    proposedJson: text('proposed_json').notNull(),
    resolvedAt: integer('resolved_at', { mode: 'timestamp' }),
    createdAt,
  },
  (table) => [index('transaction_corrections_status_idx').on(table.status)],
)

export const statementExclusions = sqliteTable(
  'statement_exclusions',
  {
    id: text('id').primaryKey(),
    importId: text('import_id')
      .notNull()
      .references(() => imports.id, { onDelete: 'cascade' }),
    transactionId: text('transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    previousStatus: text('previous_status', { enum: ['pending'] })
      .notNull()
      .default('pending'),
    reason: text('reason').notNull(),
    reversedAt: integer('reversed_at', { mode: 'timestamp' }),
    createdAt,
  },
  (table) => [
    uniqueIndex('statement_exclusion_import_transaction_idx').on(
      table.importId,
      table.transactionId,
    ),
  ],
)

export const balanceCheckpoints = sqliteTable(
  'balance_checkpoints',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').references(() => accounts.id, {
      onDelete: 'cascade',
    }),
    creditCardId: text('credit_card_id').references(() => creditCards.id, {
      onDelete: 'cascade',
    }),
    importId: text('import_id').references(() => imports.id, {
      onDelete: 'cascade',
    }),
    kind: text('kind', {
      enum: ['opening', 'statement_closing', 'manual'],
    }).notNull(),
    balanceType: text('balance_type', {
      enum: ['posted', 'available', 'card_statement'],
    })
      .notNull()
      .default('posted'),
    source: text('source', {
      enum: ['manual', 'ofx', 'csv', 'pdf', 'integration', 'legacy'],
    })
      .notNull()
      .default('legacy'),
    reviewState: text('review_state', {
      enum: ['verified', 'observed', 'invalidated'],
    })
      .notNull()
      .default('observed'),
    balanceCents: integer('balance_cents').notNull(),
    asOf: text('as_of').notNull(),
    verified: integer('verified', { mode: 'boolean' }).notNull().default(true),
    evidenceJson: text('evidence_json'),
    differenceCents: integer('difference_cents'),
    invalidatedAt: integer('invalidated_at', { mode: 'timestamp' }),
    invalidatedReason: text('invalidated_reason'),
    createdAt,
  },
  (table) => [
    index('balance_checkpoint_account_idx').on(table.accountId, table.asOf),
    index('balance_checkpoint_card_idx').on(table.creditCardId, table.asOf),
    check(
      'balance_checkpoints_target_xor',
      sql`(${table.accountId} is not null) != (${table.creditCardId} is not null)`,
    ),
  ],
)

export const transactionSplits = sqliteTable('transaction_splits', {
  id: text('id').primaryKey(),
  transactionId: text('transaction_id')
    .notNull()
    .references(() => transactions.id, { onDelete: 'cascade' }),
  categoryId: text('category_id')
    .notNull()
    .references(() => categories.id),
  amountCents: integer('amount_cents').notNull(),
  notes: text('notes'),
  createdAt,
})

export const categorizationRules = sqliteTable(
  'categorization_rules',
  {
    id: text('id').primaryKey(),
    pattern: text('pattern').notNull(),
    accountId: text('account_id').references(() => accounts.id),
    counterpartyAccountId: text('counterparty_account_id').references(
      () => accounts.id,
    ),
    direction: text('direction', { enum: ['incoming', 'outgoing'] }),
    categoryId: text('category_id')
      .notNull()
      .references(() => categories.id),
    minAmountCents: integer('min_amount_cents'),
    maxAmountCents: integer('max_amount_cents'),
    priority: integer('priority').notNull().default(100),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt,
  },
  (table) => [
    uniqueIndex('categorization_transfer_rule_idx').on(
      table.pattern,
      table.accountId,
      table.direction,
    ),
  ],
)

export const reconciliationGroups = sqliteTable('reconciliation_groups', {
  id: text('id').primaryKey(),
  type: text('type', {
    enum: [
      'transfer',
      'fx_transfer',
      'card_payment',
      'refund',
      'profit_distribution',
    ],
  }).notNull(),
  status: text('status', {
    enum: ['suggested', 'confirmed', 'rejected'],
  })
    .notNull()
    .default('suggested'),
  confidence: integer('confidence').notNull(),
  exchangeRateMicros: integer('exchange_rate_micros'),
  pairKey: text('pair_key'),
  reason: text('reason'),
  aiValidation: text('ai_validation', {
    enum: ['confirmed', 'rejected', 'uncertain'],
  }),
  aiConfidence: integer('ai_confidence'),
  aiReason: text('ai_reason'),
  aiValidatedAt: integer('ai_validated_at', { mode: 'timestamp' }),
  createdAt,
})

export const reconciliationLinks = sqliteTable(
  'reconciliation_links',
  {
    id: text('id').primaryKey(),
    groupId: text('group_id')
      .notNull()
      .references(() => reconciliationGroups.id, { onDelete: 'cascade' }),
    transactionId: text('transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    previousCategoryId: text('previous_category_id').references(
      () => categories.id,
    ),
  },
  (table) => [
    uniqueIndex('reconciliation_group_transaction_idx').on(
      table.groupId,
      table.transactionId,
    ),
  ],
)

export const exchangeRates = sqliteTable(
  'exchange_rates',
  {
    id: text('id').primaryKey(),
    date: text('date').notNull(),
    fromCurrency: text('from_currency').notNull(),
    toCurrency: text('to_currency').notNull(),
    rateMicros: integer('rate_micros').notNull(),
    source: text('source', {
      enum: ['statement', 'matched_transfer', 'bcb_ptax', 'manual'],
    }).notNull(),
    createdAt,
  },
  (table) => [
    uniqueIndex('exchange_rate_unique_idx').on(
      table.date,
      table.fromCurrency,
      table.toCurrency,
      table.source,
    ),
  ],
)

export const recurrenceGroups = sqliteTable(
  'recurrence_groups',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    normalizedName: text('normalized_name').notNull(),
    createdAt,
  },
  (table) => [
    uniqueIndex('recurrence_group_normalized_name_idx').on(
      table.normalizedName,
    ),
  ],
)

export const recurrences = sqliteTable(
  'recurrences',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    groupId: text('group_id').references(() => recurrenceGroups.id, {
      onDelete: 'set null',
    }),
    participantLabel: text('participant_label'),
    accountId: text('account_id').references(() => accounts.id),
    creditCardId: text('credit_card_id').references(() => creditCards.id),
    categoryId: text('category_id').references(() => categories.id),
    amountCents: integer('amount_cents').notNull(),
    currency: text('currency').notNull().default('BRL'),
    direction: text('direction', { enum: ['income', 'expense'] })
      .notNull()
      .default('expense'),
    amountMode: text('amount_mode', { enum: ['fixed', 'variable'] })
      .notNull()
      .default('fixed'),
    /** `aggregate`: a ocorrência é um envelope somado por vários lançamentos. */
    matchMode: text('match_mode', { enum: ['single', 'aggregate'] })
      .notNull()
      .default('single'),
    destinationMode: text('destination_mode', {
      enum: ['automatic', 'fixed'],
    })
      .notNull()
      .default('automatic'),
    frequency: text('frequency', { enum: ['monthly', 'yearly'] }).notNull(),
    startsOn: text('starts_on').notNull().default('1970-01-01'),
    scheduleAnchor: text('schedule_anchor').notNull().default('1970-01-01'),
    nextDate: text('next_date').notNull(),
    dateToleranceDays: integer('date_tolerance_days').notNull().default(15),
    amountToleranceBps: integer('amount_tolerance_bps').notNull().default(500),
    autoMatchEnabled: integer('auto_match_enabled', { mode: 'boolean' })
      .notNull()
      .default(true),
    minimumConfirmations: integer('minimum_confirmations').notNull().default(3),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt,
  },
  (table) => [
    check(
      'recurrences_destination_mode_check',
      sql`(${table.accountId} is null or ${table.creditCardId} is null) and (${table.destinationMode} != 'fixed' or ((${table.accountId} is not null) != (${table.creditCardId} is not null)))`,
    ),
  ],
)

export const recurrenceOccurrences = sqliteTable(
  'recurrence_occurrences',
  {
    id: text('id').primaryKey(),
    recurrenceId: text('recurrence_id')
      .notNull()
      .references(() => recurrences.id, { onDelete: 'cascade' }),
    expectedDate: text('expected_date').notNull(),
    expectedAmountCents: integer('expected_amount_cents').notNull(),
    currency: text('currency').notNull(),
    direction: text('direction', { enum: ['income', 'expense'] }).notNull(),
    categoryId: text('category_id')
      .notNull()
      .references(() => categories.id),
    status: text('status', {
      enum: ['expected', 'matched', 'skipped', 'cancelled'],
    })
      .notNull()
      .default('expected'),
    resolvedAt: integer('resolved_at', { mode: 'timestamp' }),
    createdAt,
  },
  (table) => [
    uniqueIndex('recurrence_occurrence_unique_idx').on(
      table.recurrenceId,
      table.expectedDate,
    ),
    index('recurrence_occurrence_date_status_idx').on(
      table.expectedDate,
      table.status,
    ),
  ],
)

/** Candidatos de recorrência que a pessoa mandou ignorar na detecção. */
export const recurrenceDetectionIgnores = sqliteTable(
  'recurrence_detection_ignores',
  {
    id: text('id').primaryKey(),
    signature: text('signature').notNull(),
    direction: text('direction', { enum: ['income', 'expense'] }).notNull(),
    createdAt,
  },
  (table) => [
    uniqueIndex('recurrence_detection_ignore_idx').on(
      table.signature,
      table.direction,
    ),
  ],
)

export const recurrenceMatches = sqliteTable(
  'recurrence_matches',
  {
    id: text('id').primaryKey(),
    occurrenceId: text('occurrence_id')
      .notNull()
      .references(() => recurrenceOccurrences.id, { onDelete: 'cascade' }),
    transactionId: text('transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    status: text('status', {
      enum: [
        'suggested',
        'confirmed',
        'rejected',
        'auto_confirmed',
        'unlinked',
      ],
    })
      .notNull()
      .default('suggested'),
    score: integer('score').notNull(),
    reason: text('reason').notNull(),
    evidenceJson: text('evidence_json').notNull().default('{}'),
    previousCategoryId: text('previous_category_id').references(
      () => categories.id,
    ),
    categoryAppliedByMatch: integer('category_applied_by_match', {
      mode: 'boolean',
    })
      .notNull()
      .default(false),
    categoryConflict: integer('category_conflict', { mode: 'boolean' })
      .notNull()
      .default(false),
    confirmedAt: integer('confirmed_at', { mode: 'timestamp' }),
    resolvedAt: integer('resolved_at', { mode: 'timestamp' }),
    createdAt,
  },
  (table) => [
    uniqueIndex('recurrence_match_pair_idx').on(
      table.occurrenceId,
      table.transactionId,
    ),
    uniqueIndex('recurrence_match_accepted_transaction_idx')
      .on(table.transactionId)
      .where(sql`${table.status} in ('confirmed', 'auto_confirmed')`),
  ],
)

/**
 * Base de conhecimento: decisões humanas sobre categoria e recorrência,
 * indexadas pela assinatura do estabelecimento (`merchantSignature`) e pela
 * direção do valor. Sobrevive a limpezas e reimportações do ledger e alimenta
 * as sugestões das próximas importações. Nunca aprende de heurística ou IA.
 */
export const knowledgeBase = sqliteTable(
  'knowledge_base',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: ['category', 'recurrence'] }).notNull(),
    /** Assinatura completa do último exemplo (`merchantSignature`). */
    signature: text('signature').notNull(),
    /**
     * Chave de casamento. Para categorias, `knowledgePattern` da descrição;
     * para recorrências, a própria assinatura. Editável na aba Conhecimento.
     */
    pattern: text('pattern').notNull(),
    /** `prefix` casa qualquer padrão que comece por este, no limite de token. Só para categorias. */
    matchMode: text('match_mode', { enum: ['exact', 'prefix'] })
      .notNull()
      .default('exact'),
    direction: text('direction', { enum: ['income', 'expense'] }).notNull(),
    categoryId: text('category_id').references(() => categories.id, {
      onDelete: 'cascade',
    }),
    recurrenceId: text('recurrence_id').references(() => recurrences.id, {
      onDelete: 'cascade',
    }),
    /** Última descrição original que ensinou esta entrada. */
    sampleDescription: text('sample_description').notNull(),
    source: text('source', {
      enum: [
        'transaction_review',
        'import_review',
        'recurrence_approval',
        'recurrence_link',
        'knowledge_review',
        'pattern_approval',
      ],
    }).notNull(),
    /** Vezes que a mesma decisão foi reafirmada. Reinicia quando a decisão muda. */
    confirmations: integer('confirmations').notNull().default(1),
    /** Vezes que a decisão anterior foi substituída por outra. */
    corrections: integer('corrections').notNull().default(0),
    lastLearnedAt: integer('last_learned_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    createdAt,
  },
  (table) => [
    uniqueIndex('knowledge_base_pattern_idx').on(
      table.kind,
      table.pattern,
      table.matchMode,
      table.direction,
    ),
    index('knowledge_base_recurrence_idx').on(table.recurrenceId),
    check(
      'knowledge_base_kind_payload',
      sql`(${table.kind} = 'category' and ${table.categoryId} is not null and ${table.recurrenceId} is null) or (${table.kind} = 'recurrence' and ${table.recurrenceId} is not null and ${table.categoryId} is null)`,
    ),
  ],
)

export const installmentPlans = sqliteTable(
  'installment_plans',
  {
    id: text('id').primaryKey(),
    creditCardId: text('credit_card_id')
      .notNull()
      .references(() => creditCards.id),
    sourceTransactionId: text('source_transaction_id')
      .references(() => transactions.id, { onDelete: 'cascade' })
      .unique(),
    description: text('description').notNull(),
    categoryId: text('category_id').references(() => categories.id),
    installmentAmountCents: integer('installment_amount_cents').notNull(),
    totalInstallments: integer('total_installments').notNull(),
    currentInstallment: integer('current_installment').notNull(),
    firstChargeDate: text('first_charge_date').notNull(),
    autoDetected: integer('auto_detected', { mode: 'boolean' })
      .notNull()
      .default(false),
    createdAt,
  },
  (table) => [index('installment_card_idx').on(table.creditCardId)],
)

export const budgetStrategies = sqliteTable('budget_strategies', {
  id: text('id').primaryKey(),
  template: text('template', {
    enum: ['balanced', 'wealth', 'aggressive', 'independence'],
  }).notNull(),
  name: text('name').notNull(),
  essentialBps: integer('essential_bps').notNull(),
  lifestyleBps: integer('lifestyle_bps').notNull(),
  investmentBps: integer('investment_bps').notNull(),
  reserveBps: integer('reserve_bps').notNull(),
  isDefault: integer('is_default', { mode: 'boolean' })
    .notNull()
    .default(false),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt,
})

export const monthlyBudgets = sqliteTable(
  'monthly_budgets',
  {
    id: text('id').primaryKey(),
    month: text('month').notNull(),
    strategyId: text('strategy_id')
      .notNull()
      .references(() => budgetStrategies.id),
    baseIncomeCents: integer('base_income_cents').notNull(),
    eligibleIncomeCents: integer('eligible_income_cents'),
    essentialBps: integer('essential_bps').notNull(),
    lifestyleBps: integer('lifestyle_bps').notNull(),
    investmentBps: integer('investment_bps').notNull(),
    reserveBps: integer('reserve_bps').notNull(),
    effectiveInvestmentBps: integer('effective_investment_bps').notNull(),
    effectiveReserveBps: integer('effective_reserve_bps').notNull(),
    reserveRedirected: integer('reserve_redirected', { mode: 'boolean' })
      .notNull()
      .default(false),
    closed: integer('closed', { mode: 'boolean' }).notNull().default(false),
    closedAt: integer('closed_at', { mode: 'timestamp' }),
    createdAt,
  },
  (table) => [uniqueIndex('monthly_budget_month_idx').on(table.month)],
)

export const investmentGoals = sqliteTable('investment_goals', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type', {
    enum: ['emergency_reserve', 'medium_term', 'retirement', 'other'],
  }).notNull(),
  targetCents: integer('target_cents').notNull(),
  currentCents: integer('current_cents').notNull().default(0),
  targetDate: text('target_date'),
  priority: integer('priority').notNull().default(100),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt,
})

export const goalContributions = sqliteTable('goal_contributions', {
  id: text('id').primaryKey(),
  goalId: text('goal_id')
    .notNull()
    .references(() => investmentGoals.id, { onDelete: 'cascade' }),
  transactionId: text('transaction_id').references(() => transactions.id),
  amountCents: integer('amount_cents').notNull(),
  contributedAt: text('contributed_at').notNull(),
  notes: text('notes'),
  createdAt,
})

export const appSettings = sqliteTable('app_settings', {
  id: text('id').primaryKey(),
  baseCurrency: text('base_currency').notNull().default('BRL'),
  monthlyIncomeTargetCents: integer('monthly_income_target_cents')
    .notNull()
    .default(6_000_000),
  reserveMonths: integer('reserve_months').notNull().default(6),
  keepReserveContributions: integer('keep_reserve_contributions', {
    mode: 'boolean',
  })
    .notNull()
    .default(false),
  aiClassificationConsent: integer('ai_classification_consent', {
    mode: 'boolean',
  })
    .notNull()
    .default(false),
  createdAt,
})

/** Relatório preservado no fechamento; não muda com novas importações. */
export const monthlyReports = sqliteTable('monthly_reports', {
  month: text('month')
    .primaryKey()
    .references(() => monthlyBudgets.month, { onDelete: 'cascade' }),
  report: text('report').notNull(),
  createdAt,
})

/** Primeira orientação, independente de um fechamento de orçamento. */
export const initialAnalysis = sqliteTable('initial_analysis', {
  id: text('id').primaryKey(),
  month: text('month').notNull(),
  report: text('report').notNull(),
  createdAt,
})
