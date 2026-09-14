CREATE TABLE `card_statement_payments` (
  `id` text PRIMARY KEY NOT NULL,
  `credit_card_id` text NOT NULL,
  `due_date` text NOT NULL,
  `transaction_id` text NOT NULL,
  `previous_category_id` text,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL,
  FOREIGN KEY (`credit_card_id`) REFERENCES `credit_cards`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`previous_category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `card_statement_payment_transaction_idx` ON `card_statement_payments` (`transaction_id`);--> statement-breakpoint
CREATE INDEX `card_statement_payment_card_idx` ON `card_statement_payments` (`credit_card_id`,`due_date`);
