ALTER TABLE `recurrences` ADD `match_mode` text DEFAULT 'single' NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS `recurrence_match_accepted_occurrence_idx`;
