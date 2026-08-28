CREATE TABLE `recurrence_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recurrence_group_normalized_name_idx` ON `recurrence_groups` (`normalized_name`);--> statement-breakpoint
ALTER TABLE `recurrences` ADD `group_id` text REFERENCES recurrence_groups(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `recurrences` ADD `participant_label` text;--> statement-breakpoint
INSERT INTO `recurrence_groups` (`id`, `name`, `normalized_name`) VALUES
	('recurrence-group-academia', 'Academia', 'academia'),
	('recurrence-group-psiquiatra', 'Psiquiatra', 'psiquiatra'),
	('recurrence-group-terapeuta', 'Terapeuta', 'terapeuta');--> statement-breakpoint
UPDATE `recurrences`
SET
	`group_id` = CASE lower(trim(`name`))
		WHEN 'academia' THEN 'recurrence-group-academia'
		WHEN 'psiquiatra' THEN 'recurrence-group-psiquiatra'
		WHEN 'terapeuta' THEN 'recurrence-group-terapeuta'
	END,
	`participant_label` = coalesce(`participant_label`, 'Família')
WHERE lower(trim(`name`)) IN ('academia', 'psiquiatra', 'terapeuta');
