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
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`ownership_scope_id`) REFERENCES `ownership_scopes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `accounts_scope_idx` ON `accounts` (`ownership_scope_id`);--> statement-breakpoint
CREATE TABLE `app_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`base_currency` text DEFAULT 'BRL' NOT NULL,
	`monthly_income_target_cents` integer DEFAULT 6000000 NOT NULL,
	`reserve_months` integer DEFAULT 6 NOT NULL,
	`ai_classification_consent` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
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
);
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
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `credit_cards` (
	`id` text PRIMARY KEY NOT NULL,
	`ownership_scope_id` text NOT NULL,
	`institution_id` text,
	`name` text NOT NULL,
	`currency` text DEFAULT 'BRL' NOT NULL,
	`last_four` text,
	`limit_cents` integer DEFAULT 0 NOT NULL,
	`closing_day` integer DEFAULT 1 NOT NULL,
	`due_day` integer DEFAULT 10 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`ownership_scope_id`) REFERENCES `ownership_scopes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `cards_scope_idx` ON `credit_cards` (`ownership_scope_id`);--> statement-breakpoint
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
CREATE UNIQUE INDEX `exchange_rate_unique_idx` ON `exchange_rates` (`date`,`from_currency`,`to_currency`,`source`);--> statement-breakpoint
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
CREATE TABLE `imports` (
	`id` text PRIMARY KEY NOT NULL,
	`source_file_id` text NOT NULL,
	`account_id` text,
	`credit_card_id` text,
	`parser` text NOT NULL,
	`status` text DEFAULT 'review' NOT NULL,
	`ai_consent` integer DEFAULT false NOT NULL,
	`warning` text,
	`committed_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`source_file_id`) REFERENCES `source_files`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`credit_card_id`) REFERENCES `credit_cards`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `imports_status_idx` ON `imports` (`status`);--> statement-breakpoint
CREATE TABLE `installment_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`credit_card_id` text NOT NULL,
	`description` text NOT NULL,
	`category_id` text,
	`installment_amount_cents` integer NOT NULL,
	`total_installments` integer NOT NULL,
	`current_installment` integer NOT NULL,
	`first_charge_date` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
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
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`strategy_id`) REFERENCES `budget_strategies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `monthly_budget_month_idx` ON `monthly_budgets` (`month`);--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE TABLE `reconciliation_links` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`transaction_id` text NOT NULL,
	`role` text NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `reconciliation_groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reconciliation_group_transaction_idx` ON `reconciliation_links` (`group_id`,`transaction_id`);--> statement-breakpoint
CREATE TABLE `recurrences` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`account_id` text,
	`credit_card_id` text,
	`category_id` text,
	`amount_cents` integer NOT NULL,
	`currency` text DEFAULT 'BRL' NOT NULL,
	`frequency` text NOT NULL,
	`next_date` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`credit_card_id`) REFERENCES `credit_cards`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
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
CREATE UNIQUE INDEX `source_files_sha256_unique` ON `source_files` (`sha256`);--> statement-breakpoint
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
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`import_id`) REFERENCES `imports`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`suggested_category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `staged_import_idx` ON `staged_transactions` (`import_id`);--> statement-breakpoint
CREATE INDEX `staged_fingerprint_idx` ON `staged_transactions` (`fingerprint`);--> statement-breakpoint
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
CREATE TABLE `transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`import_id` text,
	`account_id` text,
	`credit_card_id` text,
	`category_id` text,
	`external_id` text,
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
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_target_fingerprint_idx` ON `transactions` (`account_id`,`credit_card_id`,`fingerprint`);--> statement-breakpoint
CREATE INDEX `transactions_date_idx` ON `transactions` (`posted_at`);--> statement-breakpoint
CREATE INDEX `transactions_category_idx` ON `transactions` (`category_id`);