CREATE TABLE `__invalid_legacy_recurrence_occurrences` AS
SELECT `occurrence`.`id`
FROM `recurrence_occurrences` AS `occurrence`
JOIN `recurrences` AS `recurrence` ON `recurrence`.`id` = `occurrence`.`recurrence_id`
WHERE
	`occurrence`.`status` = 'expected'
	AND (
		(
			`recurrence`.`frequency` = 'monthly'
			AND cast(strftime('%d', `occurrence`.`expected_date`) AS integer) != min(
				cast(strftime('%d', `recurrence`.`schedule_anchor`) AS integer),
				cast(strftime('%d', date(`occurrence`.`expected_date`, 'start of month', '+1 month', '-1 day')) AS integer)
			)
		)
		OR (
			`recurrence`.`frequency` = 'yearly'
			AND (
				strftime('%m', `occurrence`.`expected_date`) != strftime('%m', `recurrence`.`schedule_anchor`)
				OR cast(strftime('%d', `occurrence`.`expected_date`) AS integer) != min(
					cast(strftime('%d', `recurrence`.`schedule_anchor`) AS integer),
					cast(strftime('%d', date(`occurrence`.`expected_date`, 'start of month', '+1 month', '-1 day')) AS integer)
				)
			)
		)
	);--> statement-breakpoint
UPDATE `recurrence_matches`
SET
	`status` = 'rejected',
	`resolved_at` = unixepoch()
WHERE
	`status` = 'suggested'
	AND `occurrence_id` IN (
		SELECT `id` FROM `__invalid_legacy_recurrence_occurrences`
	);--> statement-breakpoint
UPDATE `recurrence_occurrences`
SET
	`status` = 'cancelled',
	`resolved_at` = unixepoch()
WHERE `id` IN (
	SELECT `id` FROM `__invalid_legacy_recurrence_occurrences`
);--> statement-breakpoint
DROP TABLE `__invalid_legacy_recurrence_occurrences`;
