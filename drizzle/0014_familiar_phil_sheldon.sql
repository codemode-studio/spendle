CREATE TABLE `statement_exclusions` (
	`id` text PRIMARY KEY NOT NULL,
	`import_id` text NOT NULL,
	`transaction_id` text NOT NULL,
	`previous_status` text DEFAULT 'pending' NOT NULL,
	`reason` text NOT NULL,
	`reversed_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`import_id`) REFERENCES `imports`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `statement_exclusion_import_transaction_idx` ON `statement_exclusions` (`import_id`,`transaction_id`);