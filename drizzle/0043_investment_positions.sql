CREATE TABLE `investment_asset_classes` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`sort_order` integer DEFAULT 100 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `investment_asset_classes_name_unique` ON `investment_asset_classes` (`name`);
--> statement-breakpoint
CREATE TABLE `investment_positions` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`asset_class_id` text NOT NULL,
	`goal_id` text,
	`name` text NOT NULL,
	`symbol` text,
	`currency` text NOT NULL,
	`initial_amount_minor` integer DEFAULT 0 NOT NULL,
	`initial_base_cents` integer,
	`manual_current_amount_minor` integer,
	`manual_current_at` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`asset_class_id`) REFERENCES `investment_asset_classes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`goal_id`) REFERENCES `investment_goals`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `investment_positions_account_idx` ON `investment_positions` (`account_id`);
--> statement-breakpoint
CREATE INDEX `investment_positions_class_idx` ON `investment_positions` (`asset_class_id`);
--> statement-breakpoint
CREATE INDEX `investment_positions_goal_idx` ON `investment_positions` (`goal_id`);
--> statement-breakpoint
CREATE TABLE `investment_position_movements` (
	`id` text PRIMARY KEY NOT NULL,
	`position_id` text NOT NULL,
	`transaction_id` text NOT NULL,
	`kind` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`base_amount_cents` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`position_id`) REFERENCES `investment_positions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `investment_position_movements_transaction_id_unique` ON `investment_position_movements` (`transaction_id`);
--> statement-breakpoint
CREATE INDEX `investment_position_movements_position_idx` ON `investment_position_movements` (`position_id`);
--> statement-breakpoint
INSERT INTO `investment_asset_classes` (`id`, `name`, `color`, `sort_order`) VALUES
	('fixed-income', 'Renda fixa', '#0f766e', 10),
	('stocks', 'Ações', '#b7791f', 20),
	('crypto', 'Criptomoedas', '#c2413b', 30),
	('unclassified', 'Não classificado', '#64748b', 999);
