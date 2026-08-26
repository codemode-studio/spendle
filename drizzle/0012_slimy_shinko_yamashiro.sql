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
CREATE UNIQUE INDEX `card_statement_cycle_period_idx` ON `card_statement_cycles` (`credit_card_id`,`period_start`,`period_end`);