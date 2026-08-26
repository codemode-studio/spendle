ALTER TABLE `accounts` ADD `statement_balance_cents` integer;--> statement-breakpoint
ALTER TABLE `accounts` ADD `statement_balance_at` text;--> statement-breakpoint
ALTER TABLE `imports` ADD `closing_balance_cents` integer;--> statement-breakpoint
ALTER TABLE `imports` ADD `balance_as_of` text;