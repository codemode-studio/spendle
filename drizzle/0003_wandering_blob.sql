ALTER TABLE `installment_plans` ADD `source_transaction_id` text REFERENCES transactions(id);--> statement-breakpoint
ALTER TABLE `installment_plans` ADD `auto_detected` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `installment_plans_source_transaction_id_unique` ON `installment_plans` (`source_transaction_id`);--> statement-breakpoint
CREATE INDEX `installment_card_idx` ON `installment_plans` (`credit_card_id`);