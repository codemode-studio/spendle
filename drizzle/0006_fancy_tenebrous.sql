CREATE TABLE `balance_checkpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text,
	`credit_card_id` text,
	`import_id` text,
	`kind` text NOT NULL,
	`balance_cents` integer NOT NULL,
	`as_of` text NOT NULL,
	`verified` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`credit_card_id`) REFERENCES `credit_cards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`import_id`) REFERENCES `imports`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "balance_checkpoints_target_xor" CHECK(("balance_checkpoints"."account_id" is not null) != ("balance_checkpoints"."credit_card_id" is not null))
);
--> statement-breakpoint
CREATE INDEX `balance_checkpoint_account_idx` ON `balance_checkpoints` (`account_id`,`as_of`);--> statement-breakpoint
CREATE INDEX `balance_checkpoint_card_idx` ON `balance_checkpoints` (`credit_card_id`,`as_of`);--> statement-breakpoint
CREATE TABLE `credit_card_instruments` (
	`id` text PRIMARY KEY NOT NULL,
	`credit_card_id` text NOT NULL,
	`last_four` text NOT NULL,
	`kind` text DEFAULT 'virtual' NOT NULL,
	`label` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`credit_card_id`) REFERENCES `credit_cards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `card_instrument_unique_idx` ON `credit_card_instruments` (`credit_card_id`,`last_four`);--> statement-breakpoint
CREATE TABLE `import_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text,
	`credit_card_id` text,
	`status` text DEFAULT 'processing' NOT NULL,
	`coverage_start` text,
	`coverage_end` text,
	`gap_summary_json` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`credit_card_id`) REFERENCES `credit_cards`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "import_batches_target_xor" CHECK(("import_batches"."account_id" is not null) != ("import_batches"."credit_card_id" is not null))
);
--> statement-breakpoint
CREATE INDEX `import_batches_status_idx` ON `import_batches` (`status`);--> statement-breakpoint
CREATE TABLE `valuation_containers` (
	`id` text PRIMARY KEY NOT NULL,
	`ownership_scope_id` text NOT NULL,
	`institution_id` text,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`currency` text DEFAULT 'BRL' NOT NULL,
	`stale_after_days` integer DEFAULT 30 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`ownership_scope_id`) REFERENCES `ownership_scopes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `valuation_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`container_id` text NOT NULL,
	`value_cents` integer NOT NULL,
	`currency` text NOT NULL,
	`valued_at` text NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`container_id`) REFERENCES `valuation_containers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `valuation_snapshot_container_date_idx` ON `valuation_snapshots` (`container_id`,`valued_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_credit_cards` (
	`id` text PRIMARY KEY NOT NULL,
	`ownership_scope_id` text NOT NULL,
	`institution_id` text,
	`name` text NOT NULL,
	`currency` text DEFAULT 'BRL' NOT NULL,
	`last_four` text,
	`limit_cents` integer DEFAULT 0 NOT NULL,
	`closing_day` integer DEFAULT 1 NOT NULL,
	`due_day` integer,
	`statement_balance_cents` integer,
	`statement_balance_at` text,
	`coverage_start` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`ownership_scope_id`) REFERENCES `ownership_scopes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_credit_cards`("id", "ownership_scope_id", "institution_id", "name", "currency", "last_four", "limit_cents", "closing_day", "due_day", "statement_balance_cents", "statement_balance_at", "coverage_start", "active", "created_at") SELECT "id", "ownership_scope_id", "institution_id", "name", "currency", "last_four", "limit_cents", "closing_day", "due_day", NULL, NULL, NULL, "active", "created_at" FROM `credit_cards`;--> statement-breakpoint
DROP TABLE `credit_cards`;--> statement-breakpoint
ALTER TABLE `__new_credit_cards` RENAME TO `credit_cards`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `cards_scope_idx` ON `credit_cards` (`ownership_scope_id`);--> statement-breakpoint
CREATE TABLE `__new_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`source_file_id` text NOT NULL,
	`batch_id` text,
	`account_id` text,
	`credit_card_id` text,
	`parser` text NOT NULL,
	`document_kind` text DEFAULT 'unknown' NOT NULL,
	`detected_institution` text,
	`detected_last_four` text,
	`detected_currency` text,
	`pdf_type` text,
	`pdf_confidence_bps` integer,
	`page_count` integer,
	`pages_needing_ocr_json` text,
	`markdown` text,
	`positioned_text_json` text,
	`extraction_diagnostics_json` text,
	`opening_balance_cents` integer,
	`opening_balance_at` text,
	`closing_balance_cents` integer,
	`balance_as_of` text,
	`source_transaction_count` integer,
	`parsed_transaction_count` integer DEFAULT 0 NOT NULL,
	`invalid_transaction_count` integer DEFAULT 0 NOT NULL,
	`period_start` text,
	`period_end` text,
	`total_credits_cents` integer DEFAULT 0 NOT NULL,
	`total_debits_cents` integer DEFAULT 0 NOT NULL,
	`net_movement_cents` integer DEFAULT 0 NOT NULL,
	`expected_balance_cents` integer,
	`balance_difference_cents` integer,
	`validation_status` text DEFAULT 'warning' NOT NULL,
	`validation_message` text,
	`status` text DEFAULT 'review' NOT NULL,
	`ai_consent` integer DEFAULT false NOT NULL,
	`warning` text,
	`committed_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`source_file_id`) REFERENCES `source_files`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`batch_id`) REFERENCES `import_batches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`credit_card_id`) REFERENCES `credit_cards`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "imports_target_xor" CHECK(("__new_imports"."account_id" is not null) != ("__new_imports"."credit_card_id" is not null))
);
--> statement-breakpoint
INSERT INTO `__new_imports`("id", "source_file_id", "batch_id", "account_id", "credit_card_id", "parser", "document_kind", "detected_institution", "detected_last_four", "detected_currency", "pdf_type", "pdf_confidence_bps", "page_count", "pages_needing_ocr_json", "markdown", "positioned_text_json", "extraction_diagnostics_json", "opening_balance_cents", "opening_balance_at", "closing_balance_cents", "balance_as_of", "source_transaction_count", "parsed_transaction_count", "invalid_transaction_count", "period_start", "period_end", "total_credits_cents", "total_debits_cents", "net_movement_cents", "expected_balance_cents", "balance_difference_cents", "validation_status", "validation_message", "status", "ai_consent", "warning", "committed_at", "created_at") SELECT "id", "source_file_id", NULL, "account_id", "credit_card_id", "parser", 'unknown', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, "closing_balance_cents", "balance_as_of", "source_transaction_count", "parsed_transaction_count", "invalid_transaction_count", "period_start", "period_end", "total_credits_cents", "total_debits_cents", "net_movement_cents", "expected_balance_cents", "balance_difference_cents", "validation_status", "validation_message", "status", "ai_consent", "warning", "committed_at", "created_at" FROM `imports`;--> statement-breakpoint
DROP TABLE `imports`;--> statement-breakpoint
ALTER TABLE `__new_imports` RENAME TO `imports`;--> statement-breakpoint
CREATE INDEX `imports_status_idx` ON `imports` (`status`);--> statement-breakpoint
CREATE INDEX `imports_batch_idx` ON `imports` (`batch_id`);--> statement-breakpoint
ALTER TABLE `reconciliation_groups` ADD `pair_key` text;--> statement-breakpoint
ALTER TABLE `reconciliation_links` ADD `previous_category_id` text REFERENCES categories(id);--> statement-breakpoint
ALTER TABLE `staged_transactions` ADD `source_page` integer;--> statement-breakpoint
ALTER TABLE `staged_transactions` ADD `source_bounds_json` text;--> statement-breakpoint
CREATE TABLE `__new_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`import_id` text,
	`account_id` text,
	`credit_card_id` text,
	`category_id` text,
	`external_id` text,
	`source_key` text,
	`fingerprint` text NOT NULL,
	`posted_at` text NOT NULL,
	`description` text NOT NULL,
	`normalized_description` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`currency` text NOT NULL,
	`base_amount_cents` integer,
	`base_currency` text DEFAULT 'BRL' NOT NULL,
	`exchange_rate_micros` integer,
	`status` text DEFAULT 'confirmed' NOT NULL,
	`notes` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`import_id`) REFERENCES `imports`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`credit_card_id`) REFERENCES `credit_cards`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "transactions_target_xor" CHECK(("__new_transactions"."account_id" is not null) != ("__new_transactions"."credit_card_id" is not null))
);
--> statement-breakpoint
INSERT INTO `__new_transactions`("id", "import_id", "account_id", "credit_card_id", "category_id", "external_id", "source_key", "fingerprint", "posted_at", "description", "normalized_description", "amount_cents", "currency", "base_amount_cents", "base_currency", "exchange_rate_micros", "status", "notes", "created_at") SELECT "id", "import_id", "account_id", "credit_card_id", "category_id", "external_id", NULL, "fingerprint", "posted_at", "description", "normalized_description", "amount_cents", "currency", "base_amount_cents", "base_currency", "exchange_rate_micros", "status", "notes", "created_at" FROM `transactions`;--> statement-breakpoint
DROP TABLE `transactions`;--> statement-breakpoint
ALTER TABLE `__new_transactions` RENAME TO `transactions`;--> statement-breakpoint
CREATE INDEX `transactions_target_fingerprint_idx` ON `transactions` (`account_id`,`credit_card_id`,`fingerprint`);--> statement-breakpoint
CREATE INDEX `transactions_date_idx` ON `transactions` (`posted_at`);--> statement-breakpoint
CREATE INDEX `transactions_category_idx` ON `transactions` (`category_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_source_key_idx` ON `transactions` (`source_key`);
