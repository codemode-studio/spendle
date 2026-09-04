CREATE TABLE `recurrence_detection_ignores` (
	`id` text PRIMARY KEY NOT NULL,
	`signature` text NOT NULL,
	`direction` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recurrence_detection_ignore_idx` ON `recurrence_detection_ignores` (`signature`,`direction`);
