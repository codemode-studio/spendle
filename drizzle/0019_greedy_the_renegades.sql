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
CREATE UNIQUE INDEX `recurrence_match_pair_idx` ON `recurrence_matches` (`occurrence_id`,`transaction_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `recurrence_match_accepted_occurrence_idx` ON `recurrence_matches` (`occurrence_id`) WHERE "recurrence_matches"."status" in ('confirmed', 'auto_confirmed');--> statement-breakpoint
CREATE UNIQUE INDEX `recurrence_match_accepted_transaction_idx` ON `recurrence_matches` (`transaction_id`) WHERE "recurrence_matches"."status" in ('confirmed', 'auto_confirmed');--> statement-breakpoint
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
CREATE UNIQUE INDEX `recurrence_occurrence_unique_idx` ON `recurrence_occurrences` (`recurrence_id`,`expected_date`);--> statement-breakpoint
CREATE INDEX `recurrence_occurrence_date_status_idx` ON `recurrence_occurrences` (`expected_date`,`status`);--> statement-breakpoint
ALTER TABLE `categories` ADD `income_base_eligible` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `monthly_budgets` ADD `eligible_income_cents` integer;--> statement-breakpoint
ALTER TABLE `monthly_budgets` ADD `closed_at` integer;--> statement-breakpoint
ALTER TABLE `recurrences` ADD `direction` text DEFAULT 'expense' NOT NULL;--> statement-breakpoint
ALTER TABLE `recurrences` ADD `amount_mode` text DEFAULT 'fixed' NOT NULL;--> statement-breakpoint
ALTER TABLE `recurrences` ADD `destination_mode` text DEFAULT 'automatic' NOT NULL;--> statement-breakpoint
ALTER TABLE `recurrences` ADD `starts_on` text DEFAULT '1970-01-01' NOT NULL;--> statement-breakpoint
ALTER TABLE `recurrences` ADD `date_tolerance_days` integer DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE `recurrences` ADD `amount_tolerance_bps` integer DEFAULT 500 NOT NULL;--> statement-breakpoint
ALTER TABLE `recurrences` ADD `auto_match_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `recurrences` ADD `minimum_confirmations` integer DEFAULT 3 NOT NULL;--> statement-breakpoint
UPDATE `categories`
SET `income_base_eligible` = CASE
	WHEN `id` IN ('salary', 'profit_distribution_income', 'services_income', 'rental_income') THEN true
	ELSE false
END;--> statement-breakpoint
UPDATE `recurrences`
SET
	`direction` = CASE
		WHEN `category_id` IN (SELECT `id` FROM `categories` WHERE `bucket` = 'income') THEN 'income'
		ELSE 'expense'
	END,
	`amount_cents` = abs(`amount_cents`),
	`destination_mode` = 'automatic',
	`starts_on` = CASE
		WHEN `frequency` = 'yearly' THEN date(
			`next_date`,
			'start of month',
			'-1 year',
			'+' || (min(
				cast(strftime('%d', `next_date`) AS integer),
				cast(strftime('%d', date(`next_date`, 'start of month', '-1 year', '+1 month', '-1 day')) AS integer)
			) - 1) || ' days'
		)
		ELSE date(
			`next_date`,
			'start of month',
			'-1 month',
			'+' || (min(
				cast(strftime('%d', `next_date`) AS integer),
				cast(strftime('%d', date(`next_date`, 'start of month', '-1 day')) AS integer)
			) - 1) || ' days'
		)
	END;
