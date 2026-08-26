ALTER TABLE `categorization_rules` ADD `counterparty_account_id` text REFERENCES accounts(id);--> statement-breakpoint
ALTER TABLE `categorization_rules` ADD `direction` text;--> statement-breakpoint
CREATE UNIQUE INDEX `categorization_transfer_rule_idx` ON `categorization_rules` (`pattern`,`account_id`,`direction`);--> statement-breakpoint
ALTER TABLE `staged_transactions` ADD `counterparty_account_id` text REFERENCES accounts(id);--> statement-breakpoint
ALTER TABLE `transactions` ADD `counterparty_account_id` text REFERENCES accounts(id);