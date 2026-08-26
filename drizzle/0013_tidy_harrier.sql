CREATE TABLE `filename_coverage_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`template` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `filename_coverage_rules_template_unique` ON `filename_coverage_rules` (`template`);