CREATE TABLE `open_finance_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`ownership_scope_id` text NOT NULL,
	`provider_item_id` text,
	`client_user_id` text NOT NULL,
	`connector_id` integer,
	`connector_name` text,
	`connector_image_url` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`execution_status` text,
	`last_synced_at` integer,
	`next_sync_at` integer,
	`error_code` text,
	`error_message` text,
	`paused` integer DEFAULT false NOT NULL,
	`disconnected_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`ownership_scope_id`) REFERENCES `ownership_scopes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `open_finance_connections_provider_item_id_unique` ON `open_finance_connections` (`provider_item_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `open_finance_connections_client_user_id_unique` ON `open_finance_connections` (`client_user_id`);--> statement-breakpoint
CREATE INDEX `open_finance_connections_scope_idx` ON `open_finance_connections` (`ownership_scope_id`);--> statement-breakpoint
CREATE INDEX `open_finance_connections_status_idx` ON `open_finance_connections` (`status`);--> statement-breakpoint
CREATE TABLE `open_finance_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`provider_account_id` text NOT NULL,
	`type` text NOT NULL,
	`subtype` text NOT NULL,
	`name` text NOT NULL,
	`currency` text NOT NULL,
	`last_four` text,
	`observed_balance_cents` integer,
	`observed_available_balance_cents` integer,
	`observed_credit_limit_cents` integer,
	`observed_available_credit_cents` integer,
	`observed_closing_date` text,
	`observed_due_date` text,
	`observed_at` integer,
	`history_start` text,
	`account_id` text,
	`credit_card_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `open_finance_connections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`credit_card_id`) REFERENCES `credit_cards`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "open_finance_accounts_target_at_most_one" CHECK(not (`account_id` is not null and `credit_card_id` is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `open_finance_accounts_provider_account_id_unique` ON `open_finance_accounts` (`provider_account_id`);--> statement-breakpoint
CREATE INDEX `open_finance_accounts_connection_idx` ON `open_finance_accounts` (`connection_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `open_finance_accounts_local_account_idx` ON `open_finance_accounts` (`account_id`) WHERE `account_id` is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `open_finance_accounts_local_card_idx` ON `open_finance_accounts` (`credit_card_id`) WHERE `credit_card_id` is not null;--> statement-breakpoint
CREATE TABLE `open_finance_sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`trigger` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`accounts_fetched` integer DEFAULT 0 NOT NULL,
	`transactions_fetched` integer DEFAULT 0 NOT NULL,
	`transactions_created` integer DEFAULT 0 NOT NULL,
	`evidence_added` integer DEFAULT 0 NOT NULL,
	`corrections_pending` integer DEFAULT 0 NOT NULL,
	`transactions_deleted` integer DEFAULT 0 NOT NULL,
	`error_message` text,
	`started_at` integer DEFAULT (unixepoch()) NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`connection_id`) REFERENCES `open_finance_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `open_finance_sync_runs_connection_idx` ON `open_finance_sync_runs` (`connection_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `open_finance_transaction_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`open_finance_account_id` text NOT NULL,
	`provider_transaction_id` text NOT NULL,
	`content_hash` text NOT NULL,
	`provider_status` text NOT NULL,
	`posted_at` text,
	`description` text,
	`normalized_description` text,
	`amount_cents` integer,
	`currency` text,
	`provider_category` text,
	`sanitized_metadata_json` text NOT NULL,
	`canonical_transaction_id` text,
	`resolution` text NOT NULL,
	`resolved_at` integer,
	`observed_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`open_finance_account_id`) REFERENCES `open_finance_accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`canonical_transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `open_finance_observation_version_idx` ON `open_finance_transaction_observations` (`open_finance_account_id`,`provider_transaction_id`,`content_hash`);--> statement-breakpoint
CREATE INDEX `open_finance_observation_transaction_idx` ON `open_finance_transaction_observations` (`canonical_transaction_id`);--> statement-breakpoint
CREATE INDEX `open_finance_observation_resolution_idx` ON `open_finance_transaction_observations` (`resolution`);--> statement-breakpoint
CREATE TABLE `pluggy_webhook_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`event` text NOT NULL,
	`provider_item_id` text,
	`provider_account_id` text,
	`payload_json` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`claimed_at` integer,
	`processed_at` integer,
	`error_message` text,
	`received_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pluggy_webhook_events_state_idx` ON `pluggy_webhook_events` (`state`,`received_at`);--> statement-breakpoint
CREATE INDEX `pluggy_webhook_events_item_idx` ON `pluggy_webhook_events` (`provider_item_id`);
