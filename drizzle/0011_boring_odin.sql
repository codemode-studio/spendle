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
CREATE UNIQUE INDEX `coverage_intervals_import_id_unique` ON `coverage_intervals` (`import_id`);--> statement-breakpoint
CREATE INDEX `coverage_interval_account_idx` ON `coverage_intervals` (`account_id`,`start`);--> statement-breakpoint
CREATE INDEX `coverage_interval_card_idx` ON `coverage_intervals` (`credit_card_id`,`start`);--> statement-breakpoint
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
CREATE UNIQUE INDEX `transaction_corrections_staged_transaction_id_unique` ON `transaction_corrections` (`staged_transaction_id`);--> statement-breakpoint
CREATE INDEX `transaction_corrections_status_idx` ON `transaction_corrections` (`status`);--> statement-breakpoint
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
CREATE UNIQUE INDEX `transaction_evidence_staged_transaction_id_unique` ON `transaction_evidence` (`staged_transaction_id`);--> statement-breakpoint
CREATE INDEX `transaction_evidence_transaction_idx` ON `transaction_evidence` (`transaction_id`);--> statement-breakpoint
ALTER TABLE `balance_checkpoints` ADD `balance_type` text DEFAULT 'posted' NOT NULL;--> statement-breakpoint
ALTER TABLE `balance_checkpoints` ADD `source` text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE `balance_checkpoints` ADD `review_state` text DEFAULT 'observed' NOT NULL;--> statement-breakpoint
ALTER TABLE `balance_checkpoints` ADD `evidence_json` text;--> statement-breakpoint
ALTER TABLE `balance_checkpoints` ADD `difference_cents` integer;--> statement-breakpoint
ALTER TABLE `balance_checkpoints` ADD `invalidated_at` integer;--> statement-breakpoint
ALTER TABLE `balance_checkpoints` ADD `invalidated_reason` text;--> statement-breakpoint
ALTER TABLE `imports` ADD `activity_start` text;--> statement-breakpoint
ALTER TABLE `imports` ADD `activity_end` text;--> statement-breakpoint
ALTER TABLE `imports` ADD `period_source` text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `imports` ADD `coverage_confidence` text DEFAULT 'unknown' NOT NULL;