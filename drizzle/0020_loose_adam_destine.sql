PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__recurrence_occurrences_backup` AS SELECT * FROM `recurrence_occurrences`;--> statement-breakpoint
CREATE TABLE `__recurrence_matches_backup` AS SELECT * FROM `recurrence_matches`;--> statement-breakpoint
DELETE FROM `recurrence_matches`;--> statement-breakpoint
DELETE FROM `recurrence_occurrences`;--> statement-breakpoint
CREATE TABLE `__new_recurrences` (
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
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`credit_card_id`) REFERENCES `credit_cards`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "recurrences_destination_mode_check" CHECK(("__new_recurrences"."account_id" is null or "__new_recurrences"."credit_card_id" is null) and ("__new_recurrences"."destination_mode" != 'fixed' or (("__new_recurrences"."account_id" is not null) != ("__new_recurrences"."credit_card_id" is not null))))
);
--> statement-breakpoint
INSERT INTO `__new_recurrences`("id", "name", "account_id", "credit_card_id", "category_id", "amount_cents", "currency", "direction", "amount_mode", "destination_mode", "frequency", "starts_on", "next_date", "date_tolerance_days", "amount_tolerance_bps", "auto_match_enabled", "minimum_confirmations", "active", "created_at") SELECT "id", "name", "account_id", "credit_card_id", "category_id", "amount_cents", "currency", "direction", "amount_mode", "destination_mode", "frequency", "starts_on", "next_date", "date_tolerance_days", "amount_tolerance_bps", "auto_match_enabled", "minimum_confirmations", "active", "created_at" FROM `recurrences`;--> statement-breakpoint
DROP TABLE `recurrences`;--> statement-breakpoint
ALTER TABLE `__new_recurrences` RENAME TO `recurrences`;--> statement-breakpoint
UPDATE `recurrences`
SET
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
	END
WHERE `starts_on` = '1970-01-01';--> statement-breakpoint
INSERT INTO `recurrence_occurrences` (`id`, `recurrence_id`, `expected_date`, `expected_amount_cents`, `currency`, `direction`, `category_id`, `status`, `resolved_at`, `created_at`)
SELECT `id`, `recurrence_id`, `expected_date`, `expected_amount_cents`, `currency`, `direction`, `category_id`, `status`, `resolved_at`, `created_at` FROM `__recurrence_occurrences_backup`;--> statement-breakpoint
INSERT INTO `recurrence_matches` (`id`, `occurrence_id`, `transaction_id`, `status`, `score`, `reason`, `evidence_json`, `previous_category_id`, `category_applied_by_match`, `category_conflict`, `confirmed_at`, `resolved_at`, `created_at`)
SELECT `id`, `occurrence_id`, `transaction_id`, `status`, `score`, `reason`, `evidence_json`, `previous_category_id`, `category_applied_by_match`, `category_conflict`, `confirmed_at`, `resolved_at`, `created_at` FROM `__recurrence_matches_backup`;--> statement-breakpoint
DROP TABLE `__recurrence_matches_backup`;--> statement-breakpoint
DROP TABLE `__recurrence_occurrences_backup`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
