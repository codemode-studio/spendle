-- The schema and seed rows of the last V1 database (V1 Drizzle migrations
-- 0000 to 0043 applied to an empty file), frozen for the V1 import tests.
-- V1 is retired: this file never changes.
--> statement-breakpoint
CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`ownership_scope_id` text NOT NULL,
	`institution_id` text,
	`name` text NOT NULL,
	`kind` text DEFAULT 'checking' NOT NULL,
	`purpose` text DEFAULT 'operating' NOT NULL,
	`currency` text DEFAULT 'BRL' NOT NULL,
	`external_id` text,
	`initial_balance_cents` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL, `statement_balance_cents` integer, `statement_balance_at` text, `coverage_start` text,
	FOREIGN KEY (`ownership_scope_id`) REFERENCES `ownership_scopes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `app_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`base_currency` text DEFAULT 'BRL' NOT NULL,
	`monthly_income_target_cents` integer DEFAULT 6000000 NOT NULL,
	`reserve_months` integer DEFAULT 6 NOT NULL,
	`ai_classification_consent` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
, `keep_reserve_contributions` integer DEFAULT false NOT NULL);
--> statement-breakpoint
CREATE TABLE `budget_strategies` (
	`id` text PRIMARY KEY NOT NULL,
	`template` text NOT NULL,
	`name` text NOT NULL,
	`essential_bps` integer NOT NULL,
	`lifestyle_bps` integer NOT NULL,
	`investment_bps` integer NOT NULL,
	`reserve_bps` integer NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_id` text,
	`name` text NOT NULL,
	`bucket` text NOT NULL,
	`color` text DEFAULT '#64748b' NOT NULL,
	`icon` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
, `income_base_eligible` integer DEFAULT false NOT NULL);
--> statement-breakpoint
CREATE TABLE `categorization_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`pattern` text NOT NULL,
	`account_id` text,
	`category_id` text NOT NULL,
	`min_amount_cents` integer,
	`max_amount_cents` integer,
	`priority` integer DEFAULT 100 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL, `counterparty_account_id` text REFERENCES accounts(id), `direction` text,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `exchange_rates` (
	`id` text PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	`from_currency` text NOT NULL,
	`to_currency` text NOT NULL,
	`rate_micros` integer NOT NULL,
	`source` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `goal_contributions` (
	`id` text PRIMARY KEY NOT NULL,
	`goal_id` text NOT NULL,
	`transaction_id` text,
	`amount_cents` integer NOT NULL,
	`contributed_at` text NOT NULL,
	`notes` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`goal_id`) REFERENCES `investment_goals`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `installment_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`credit_card_id` text NOT NULL,
	`description` text NOT NULL,
	`category_id` text,
	`installment_amount_cents` integer NOT NULL,
	`total_installments` integer NOT NULL,
	`current_installment` integer NOT NULL,
	`first_charge_date` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL, `source_transaction_id` text REFERENCES transactions(id), `auto_detected` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`credit_card_id`) REFERENCES `credit_cards`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `institutions` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`country` text DEFAULT 'BR' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `investment_goals` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`target_cents` integer NOT NULL,
	`current_cents` integer DEFAULT 0 NOT NULL,
	`target_date` text,
	`priority` integer DEFAULT 100 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `monthly_budgets` (
	`id` text PRIMARY KEY NOT NULL,
	`month` text NOT NULL,
	`strategy_id` text NOT NULL,
	`base_income_cents` integer NOT NULL,
	`essential_bps` integer NOT NULL,
	`lifestyle_bps` integer NOT NULL,
	`investment_bps` integer NOT NULL,
	`reserve_bps` integer NOT NULL,
	`effective_investment_bps` integer NOT NULL,
	`effective_reserve_bps` integer NOT NULL,
	`reserve_redirected` integer DEFAULT false NOT NULL,
	`closed` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL, `eligible_income_cents` integer, `closed_at` integer,
	FOREIGN KEY (`strategy_id`) REFERENCES `budget_strategies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `ownership_scopes` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reconciliation_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`status` text DEFAULT 'suggested' NOT NULL,
	`confidence` integer NOT NULL,
	`exchange_rate_micros` integer,
	`reason` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
, `pair_key` text, `ai_validation` text, `ai_confidence` integer, `ai_reason` text, `ai_validated_at` integer);
--> statement-breakpoint
CREATE TABLE `reconciliation_links` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`transaction_id` text NOT NULL,
	`role` text NOT NULL, `previous_category_id` text REFERENCES categories(id),
	FOREIGN KEY (`group_id`) REFERENCES `reconciliation_groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `source_files` (
	`id` text PRIMARY KEY NOT NULL,
	`sha256` text NOT NULL,
	`original_name` text NOT NULL,
	`media_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`storage_path` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `staged_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`import_id` text NOT NULL,
	`external_id` text,
	`fingerprint` text NOT NULL,
	`posted_at` text NOT NULL,
	`description` text NOT NULL,
	`normalized_description` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`currency` text NOT NULL,
	`suggested_category_id` text,
	`suggestion_confidence` integer DEFAULT 0,
	`duplicate` integer DEFAULT false NOT NULL,
	`raw_json` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL, `suggestion_source` text DEFAULT 'none' NOT NULL, `duplicate_reason` text, `source_page` integer, `source_bounds_json` text, `counterparty_account_id` text REFERENCES accounts(id),
	FOREIGN KEY (`import_id`) REFERENCES `imports`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`suggested_category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `transaction_splits` (
	`id` text PRIMARY KEY NOT NULL,
	`transaction_id` text NOT NULL,
	`category_id` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`notes` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `balance_checkpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text,
	`credit_card_id` text,
	`import_id` text,
	`kind` text NOT NULL,
	`balance_cents` integer NOT NULL,
	`as_of` text NOT NULL,
	`verified` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL, `balance_type` text DEFAULT 'posted' NOT NULL, `source` text DEFAULT 'legacy' NOT NULL, `review_state` text DEFAULT 'observed' NOT NULL, `evidence_json` text, `difference_cents` integer, `invalidated_at` integer, `invalidated_reason` text,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`credit_card_id`) REFERENCES `credit_cards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`import_id`) REFERENCES `imports`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "balance_checkpoints_target_xor" CHECK(("balance_checkpoints"."account_id" is not null) != ("balance_checkpoints"."credit_card_id" is not null))
);
--> statement-breakpoint
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
CREATE TABLE "credit_cards" (
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
CREATE TABLE "imports" (
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
	`created_at` integer DEFAULT (unixepoch()) NOT NULL, `statement_due_date` text, `activity_start` text, `activity_end` text, `period_source` text DEFAULT 'unknown' NOT NULL, `coverage_confidence` text DEFAULT 'unknown' NOT NULL, `closing_balance_type` text, `depends_on_import_id` text REFERENCES imports(id) ON DELETE SET NULL, `validation_reason` text,
	FOREIGN KEY (`source_file_id`) REFERENCES `source_files`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`batch_id`) REFERENCES `import_batches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`credit_card_id`) REFERENCES `credit_cards`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "imports_target_xor" CHECK(("imports"."account_id" is not null) != ("imports"."credit_card_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "transactions" (
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
	`created_at` integer DEFAULT (unixepoch()) NOT NULL, `counterparty_account_id` text REFERENCES accounts(id),
	FOREIGN KEY (`import_id`) REFERENCES `imports`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`credit_card_id`) REFERENCES `credit_cards`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "transactions_target_xor" CHECK(("transactions"."account_id" is not null) != ("transactions"."credit_card_id" is not null))
);
--> statement-breakpoint
CREATE TABLE `coverage_intervals` (
	`id` text PRIMARY KEY NOT NULL,
	`import_id` text NOT NULL,
	`account_id` text,
	`credit_card_id` text,
	`start` text NOT NULL,
	`end` text NOT NULL,
	`source` text NOT NULL,
	`confidence` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`import_id`) REFERENCES `imports`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`credit_card_id`) REFERENCES `credit_cards`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "coverage_intervals_target_xor" CHECK(("coverage_intervals"."account_id" is not null) != ("coverage_intervals"."credit_card_id" is not null)),
	CONSTRAINT "coverage_intervals_range" CHECK("coverage_intervals"."start" <= "coverage_intervals"."end")
);
--> statement-breakpoint
CREATE TABLE `transaction_corrections` (
	`id` text PRIMARY KEY NOT NULL,
	`staged_transaction_id` text NOT NULL,
	`transaction_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`previous_json` text NOT NULL,
	`proposed_json` text NOT NULL,
	`resolved_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`staged_transaction_id`) REFERENCES `staged_transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `transaction_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`staged_transaction_id` text NOT NULL,
	`transaction_id` text NOT NULL,
	`match_kind` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`staged_transaction_id`) REFERENCES `staged_transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `card_statement_cycles` (
	`id` text PRIMARY KEY NOT NULL,
	`credit_card_id` text NOT NULL,
	`import_id` text,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`closing_date` text,
	`issued_at` text,
	`due_date` text,
	`total_cents` integer,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`credit_card_id`) REFERENCES `credit_cards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`import_id`) REFERENCES `imports`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `filename_coverage_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`template` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `statement_exclusions` (
	`id` text PRIMARY KEY NOT NULL,
	`import_id` text NOT NULL,
	`transaction_id` text NOT NULL,
	`previous_status` text DEFAULT 'pending' NOT NULL,
	`reason` text NOT NULL,
	`reversed_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`import_id`) REFERENCES `imports`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `recurrence_matches` (
	`id` text PRIMARY KEY NOT NULL,
	`occurrence_id` text NOT NULL,
	`transaction_id` text NOT NULL,
	`status` text DEFAULT 'suggested' NOT NULL,
	`score` integer NOT NULL,
	`reason` text NOT NULL,
	`evidence_json` text DEFAULT '{}' NOT NULL,
	`previous_category_id` text,
	`category_applied_by_match` integer DEFAULT false NOT NULL,
	`category_conflict` integer DEFAULT false NOT NULL,
	`confirmed_at` integer,
	`resolved_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`occurrence_id`) REFERENCES `recurrence_occurrences`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`previous_category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `recurrence_occurrences` (
	`id` text PRIMARY KEY NOT NULL,
	`recurrence_id` text NOT NULL,
	`expected_date` text NOT NULL,
	`expected_amount_cents` integer NOT NULL,
	`currency` text NOT NULL,
	`direction` text NOT NULL,
	`category_id` text NOT NULL,
	`status` text DEFAULT 'expected' NOT NULL,
	`resolved_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`recurrence_id`) REFERENCES `recurrences`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE "recurrences" (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`account_id` text,
	`credit_card_id` text,
	`category_id` text,
	`amount_cents` integer NOT NULL,
	`currency` text DEFAULT 'BRL' NOT NULL,
	`direction` text DEFAULT 'expense' NOT NULL,
	`amount_mode` text DEFAULT 'fixed' NOT NULL,
	`destination_mode` text DEFAULT 'automatic' NOT NULL,
	`frequency` text NOT NULL,
	`starts_on` text DEFAULT '1970-01-01' NOT NULL,
	`next_date` text NOT NULL,
	`date_tolerance_days` integer DEFAULT 15 NOT NULL,
	`amount_tolerance_bps` integer DEFAULT 500 NOT NULL,
	`auto_match_enabled` integer DEFAULT true NOT NULL,
	`minimum_confirmations` integer DEFAULT 3 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL, `schedule_anchor` text DEFAULT '1970-01-01' NOT NULL, `group_id` text REFERENCES recurrence_groups(id) ON DELETE SET NULL, `participant_label` text, `match_mode` text DEFAULT 'single' NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`credit_card_id`) REFERENCES `credit_cards`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "recurrences_destination_mode_check" CHECK(("recurrences"."account_id" is null or "recurrences"."credit_card_id" is null) and ("recurrences"."destination_mode" != 'fixed' or (("recurrences"."account_id" is not null) != ("recurrences"."credit_card_id" is not null))))
);
--> statement-breakpoint
CREATE TABLE `recurrence_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `recurrence_detection_ignores` (
	`id` text PRIMARY KEY NOT NULL,
	`signature` text NOT NULL,
	`direction` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `knowledge_base` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`signature` text NOT NULL,
	`direction` text NOT NULL,
	`category_id` text,
	`recurrence_id` text,
	`sample_description` text NOT NULL,
	`source` text NOT NULL,
	`confirmations` integer DEFAULT 1 NOT NULL,
	`corrections` integer DEFAULT 0 NOT NULL,
	`last_learned_at` integer DEFAULT (unixepoch()) NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL, `pattern` text DEFAULT '' NOT NULL, `match_mode` text DEFAULT 'exact' NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recurrence_id`) REFERENCES `recurrences`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "knowledge_base_kind_payload" CHECK(("knowledge_base"."kind" = 'category' and "knowledge_base"."category_id" is not null and "knowledge_base"."recurrence_id" is null) or ("knowledge_base"."kind" = 'recurrence' and "knowledge_base"."recurrence_id" is not null and "knowledge_base"."category_id" is null))
);
--> statement-breakpoint
CREATE TABLE `monthly_reports` (
  `month` text PRIMARY KEY NOT NULL,
  `report` text NOT NULL,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL,
  FOREIGN KEY (`month`) REFERENCES `monthly_budgets`(`month`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `initial_analysis` (
  `id` text PRIMARY KEY NOT NULL,
  `month` text NOT NULL,
  `report` text NOT NULL,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `card_statement_payments` (
  `id` text PRIMARY KEY NOT NULL,
  `credit_card_id` text NOT NULL,
  `due_date` text NOT NULL,
  `transaction_id` text NOT NULL,
  `previous_category_id` text,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL, `partial` integer DEFAULT false NOT NULL,
  FOREIGN KEY (`credit_card_id`) REFERENCES `credit_cards`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`previous_category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `investment_asset_classes` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`sort_order` integer DEFAULT 100 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `investment_positions` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`asset_class_id` text NOT NULL,
	`goal_id` text,
	`name` text NOT NULL,
	`symbol` text,
	`currency` text NOT NULL,
	`initial_amount_minor` integer DEFAULT 0 NOT NULL,
	`initial_base_cents` integer,
	`manual_current_amount_minor` integer,
	`manual_current_at` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`asset_class_id`) REFERENCES `investment_asset_classes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`goal_id`) REFERENCES `investment_goals`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `investment_position_movements` (
	`id` text PRIMARY KEY NOT NULL,
	`position_id` text NOT NULL,
	`transaction_id` text NOT NULL,
	`kind` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`base_amount_cents` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`position_id`) REFERENCES `investment_positions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `accounts_scope_idx` ON `accounts` (`ownership_scope_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `exchange_rate_unique_idx` ON `exchange_rates` (`date`,`from_currency`,`to_currency`,`source`);
--> statement-breakpoint
CREATE UNIQUE INDEX `monthly_budget_month_idx` ON `monthly_budgets` (`month`);
--> statement-breakpoint
CREATE UNIQUE INDEX `reconciliation_group_transaction_idx` ON `reconciliation_links` (`group_id`,`transaction_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_files_sha256_unique` ON `source_files` (`sha256`);
--> statement-breakpoint
CREATE INDEX `staged_import_idx` ON `staged_transactions` (`import_id`);
--> statement-breakpoint
CREATE INDEX `staged_fingerprint_idx` ON `staged_transactions` (`fingerprint`);
--> statement-breakpoint
CREATE UNIQUE INDEX `installment_plans_source_transaction_id_unique` ON `installment_plans` (`source_transaction_id`);
--> statement-breakpoint
CREATE INDEX `installment_card_idx` ON `installment_plans` (`credit_card_id`);
--> statement-breakpoint
CREATE INDEX `balance_checkpoint_account_idx` ON `balance_checkpoints` (`account_id`,`as_of`);
--> statement-breakpoint
CREATE INDEX `balance_checkpoint_card_idx` ON `balance_checkpoints` (`credit_card_id`,`as_of`);
--> statement-breakpoint
CREATE UNIQUE INDEX `card_instrument_unique_idx` ON `credit_card_instruments` (`credit_card_id`,`last_four`);
--> statement-breakpoint
CREATE INDEX `import_batches_status_idx` ON `import_batches` (`status`);
--> statement-breakpoint
CREATE INDEX `cards_scope_idx` ON `credit_cards` (`ownership_scope_id`);
--> statement-breakpoint
CREATE INDEX `imports_status_idx` ON `imports` (`status`);
--> statement-breakpoint
CREATE INDEX `imports_batch_idx` ON `imports` (`batch_id`);
--> statement-breakpoint
CREATE INDEX `transactions_target_fingerprint_idx` ON `transactions` (`account_id`,`credit_card_id`,`fingerprint`);
--> statement-breakpoint
CREATE INDEX `transactions_date_idx` ON `transactions` (`posted_at`);
--> statement-breakpoint
CREATE INDEX `transactions_category_idx` ON `transactions` (`category_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_source_key_idx` ON `transactions` (`source_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `categorization_transfer_rule_idx` ON `categorization_rules` (`pattern`,`account_id`,`direction`);
--> statement-breakpoint
CREATE UNIQUE INDEX `coverage_intervals_import_id_unique` ON `coverage_intervals` (`import_id`);
--> statement-breakpoint
CREATE INDEX `coverage_interval_account_idx` ON `coverage_intervals` (`account_id`,`start`);
--> statement-breakpoint
CREATE INDEX `coverage_interval_card_idx` ON `coverage_intervals` (`credit_card_id`,`start`);
--> statement-breakpoint
CREATE UNIQUE INDEX `transaction_corrections_staged_transaction_id_unique` ON `transaction_corrections` (`staged_transaction_id`);
--> statement-breakpoint
CREATE INDEX `transaction_corrections_status_idx` ON `transaction_corrections` (`status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `transaction_evidence_staged_transaction_id_unique` ON `transaction_evidence` (`staged_transaction_id`);
--> statement-breakpoint
CREATE INDEX `transaction_evidence_transaction_idx` ON `transaction_evidence` (`transaction_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `card_statement_cycle_period_idx` ON `card_statement_cycles` (`credit_card_id`,`period_start`,`period_end`);
--> statement-breakpoint
CREATE UNIQUE INDEX `filename_coverage_rules_template_unique` ON `filename_coverage_rules` (`template`);
--> statement-breakpoint
CREATE UNIQUE INDEX `statement_exclusion_import_transaction_idx` ON `statement_exclusions` (`import_id`,`transaction_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `recurrence_match_pair_idx` ON `recurrence_matches` (`occurrence_id`,`transaction_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `recurrence_match_accepted_transaction_idx` ON `recurrence_matches` (`transaction_id`) WHERE "recurrence_matches"."status" in ('confirmed', 'auto_confirmed');
--> statement-breakpoint
CREATE UNIQUE INDEX `recurrence_occurrence_unique_idx` ON `recurrence_occurrences` (`recurrence_id`,`expected_date`);
--> statement-breakpoint
CREATE INDEX `recurrence_occurrence_date_status_idx` ON `recurrence_occurrences` (`expected_date`,`status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `recurrence_group_normalized_name_idx` ON `recurrence_groups` (`normalized_name`);
--> statement-breakpoint
CREATE UNIQUE INDEX `recurrence_detection_ignore_idx` ON `recurrence_detection_ignores` (`signature`,`direction`);
--> statement-breakpoint
CREATE INDEX `knowledge_base_recurrence_idx` ON `knowledge_base` (`recurrence_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_base_pattern_idx` ON `knowledge_base` (`kind`,`pattern`,`match_mode`,`direction`);
--> statement-breakpoint
CREATE UNIQUE INDEX `card_statement_payment_transaction_idx` ON `card_statement_payments` (`transaction_id`);
--> statement-breakpoint
CREATE INDEX `card_statement_payment_card_idx` ON `card_statement_payments` (`credit_card_id`,`due_date`);
--> statement-breakpoint
CREATE UNIQUE INDEX `investment_asset_classes_name_unique` ON `investment_asset_classes` (`name`);
--> statement-breakpoint
CREATE INDEX `investment_positions_account_idx` ON `investment_positions` (`account_id`);
--> statement-breakpoint
CREATE INDEX `investment_positions_class_idx` ON `investment_positions` (`asset_class_id`);
--> statement-breakpoint
CREATE INDEX `investment_positions_goal_idx` ON `investment_positions` (`goal_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `investment_position_movements_transaction_id_unique` ON `investment_position_movements` (`transaction_id`);
--> statement-breakpoint
CREATE INDEX `investment_position_movements_position_idx` ON `investment_position_movements` (`position_id`);
--> statement-breakpoint
INSERT INTO "categories" ("id", "parent_id", "name", "bucket", "color", "icon", "active", "created_at", "income_base_eligible") VALUES ('groceries', NULL, 'Mercado', 'essential', '#0d9488', NULL, 1, 1791177447, 0);
--> statement-breakpoint
INSERT INTO "categories" ("id", "parent_id", "name", "bucket", "color", "icon", "active", "created_at", "income_base_eligible") VALUES ('restaurants', NULL, 'Restaurantes', 'lifestyle', '#d97706', NULL, 1, 1791177447, 0);
--> statement-breakpoint
INSERT INTO "recurrence_groups" ("id", "name", "normalized_name", "created_at") VALUES ('recurrence-group-academia', 'Academia', 'academia', 1791177447);
--> statement-breakpoint
INSERT INTO "recurrence_groups" ("id", "name", "normalized_name", "created_at") VALUES ('recurrence-group-psiquiatra', 'Psiquiatra', 'psiquiatra', 1791177447);
--> statement-breakpoint
INSERT INTO "recurrence_groups" ("id", "name", "normalized_name", "created_at") VALUES ('recurrence-group-terapeuta', 'Terapeuta', 'terapeuta', 1791177447);
--> statement-breakpoint
INSERT INTO "investment_asset_classes" ("id", "name", "color", "sort_order", "active", "created_at") VALUES ('fixed-income', 'Renda fixa', '#0f766e', 10, 1, 1791177447);
--> statement-breakpoint
INSERT INTO "investment_asset_classes" ("id", "name", "color", "sort_order", "active", "created_at") VALUES ('stocks', 'Ações', '#b7791f', 20, 1, 1791177447);
--> statement-breakpoint
INSERT INTO "investment_asset_classes" ("id", "name", "color", "sort_order", "active", "created_at") VALUES ('crypto', 'Criptomoedas', '#c2413b', 30, 1, 1791177447);
--> statement-breakpoint
INSERT INTO "investment_asset_classes" ("id", "name", "color", "sort_order", "active", "created_at") VALUES ('unclassified', 'Não classificado', '#64748b', 999, 1, 1791177447);
