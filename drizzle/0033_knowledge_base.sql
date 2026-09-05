CREATE TABLE `knowledge_base` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`signature` text NOT NULL,
	`direction` text NOT NULL,
	`category_id` text,
	`recurrence_id` text,
	`sample_description` text NOT NULL,
	`source` text NOT NULL,
	`confirmations` integer DEFAULT 1 NOT NULL,
	`corrections` integer DEFAULT 0 NOT NULL,
	`last_learned_at` integer DEFAULT (unixepoch()) NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recurrence_id`) REFERENCES `recurrences`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "knowledge_base_kind_payload" CHECK(("knowledge_base"."kind" = 'category' and "knowledge_base"."category_id" is not null and "knowledge_base"."recurrence_id" is null) or ("knowledge_base"."kind" = 'recurrence' and "knowledge_base"."recurrence_id" is not null and "knowledge_base"."category_id" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_base_key_idx` ON `knowledge_base` (`kind`,`signature`,`direction`);--> statement-breakpoint
CREATE INDEX `knowledge_base_recurrence_idx` ON `knowledge_base` (`recurrence_id`);