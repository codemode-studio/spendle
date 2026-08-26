DROP INDEX `transactions_target_fingerprint_idx`;--> statement-breakpoint
CREATE INDEX `transactions_target_fingerprint_idx` ON `transactions` (`account_id`,`credit_card_id`,`fingerprint`);--> statement-breakpoint
ALTER TABLE `imports` ADD `source_transaction_count` integer;--> statement-breakpoint
ALTER TABLE `imports` ADD `parsed_transaction_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `imports` ADD `invalid_transaction_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `imports` ADD `period_start` text;--> statement-breakpoint
ALTER TABLE `imports` ADD `period_end` text;--> statement-breakpoint
ALTER TABLE `imports` ADD `total_credits_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `imports` ADD `total_debits_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `imports` ADD `net_movement_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `imports` ADD `expected_balance_cents` integer;--> statement-breakpoint
ALTER TABLE `imports` ADD `balance_difference_cents` integer;--> statement-breakpoint
ALTER TABLE `imports` ADD `validation_status` text DEFAULT 'warning' NOT NULL;--> statement-breakpoint
ALTER TABLE `imports` ADD `validation_message` text;--> statement-breakpoint
ALTER TABLE `staged_transactions` ADD `duplicate_reason` text;--> statement-breakpoint
UPDATE `staged_transactions`
SET `duplicate_reason` = 'fingerprint_overlap'
WHERE `duplicate` = true;--> statement-breakpoint
UPDATE `imports`
SET
	`parsed_transaction_count` = (SELECT count(*) FROM `staged_transactions` WHERE `staged_transactions`.`import_id` = `imports`.`id`),
	`invalid_transaction_count` = 0,
	`period_start` = (SELECT min(`posted_at`) FROM `staged_transactions` WHERE `staged_transactions`.`import_id` = `imports`.`id`),
	`period_end` = (SELECT max(`posted_at`) FROM `staged_transactions` WHERE `staged_transactions`.`import_id` = `imports`.`id`),
	`total_credits_cents` = coalesce((SELECT sum(`amount_cents`) FROM `staged_transactions` WHERE `staged_transactions`.`import_id` = `imports`.`id` AND `amount_cents` > 0), 0),
	`total_debits_cents` = coalesce((SELECT sum(abs(`amount_cents`)) FROM `staged_transactions` WHERE `staged_transactions`.`import_id` = `imports`.`id` AND `amount_cents` < 0), 0),
	`net_movement_cents` = coalesce((SELECT sum(`amount_cents`) FROM `staged_transactions` WHERE `staged_transactions`.`import_id` = `imports`.`id`), 0),
	`validation_message` = 'Importação anterior à auditoria automática; confira os totais com o arquivo original.';
