INSERT INTO `recurrences` (
	`id`, `name`, `group_id`, `participant_label`, `account_id`,
	`credit_card_id`, `category_id`, `amount_cents`, `currency`, `direction`,
	`amount_mode`, `destination_mode`, `frequency`, `starts_on`,
	`schedule_anchor`, `next_date`, `date_tolerance_days`,
	`amount_tolerance_bps`, `auto_match_enabled`, `minimum_confirmations`,
	`active`, `created_at`
)
SELECT
	'recurrence-academia-dayane', r.`name`, r.`group_id`, 'Dayane', r.`account_id`,
	r.`credit_card_id`, r.`category_id`, 25000, r.`currency`, r.`direction`,
	r.`amount_mode`, r.`destination_mode`, r.`frequency`, r.`starts_on`,
	r.`schedule_anchor`, r.`next_date`, r.`date_tolerance_days`,
	r.`amount_tolerance_bps`, r.`auto_match_enabled`, r.`minimum_confirmations`,
	r.`active`, r.`created_at`
FROM `recurrences` r
JOIN `recurrence_groups` g ON g.`id` = r.`group_id`
WHERE g.`normalized_name` = 'academia' AND r.`participant_label` = 'Família'
LIMIT 1;--> statement-breakpoint
INSERT INTO `recurrences` (
	`id`, `name`, `group_id`, `participant_label`, `account_id`,
	`credit_card_id`, `category_id`, `amount_cents`, `currency`, `direction`,
	`amount_mode`, `destination_mode`, `frequency`, `starts_on`,
	`schedule_anchor`, `next_date`, `date_tolerance_days`,
	`amount_tolerance_bps`, `auto_match_enabled`, `minimum_confirmations`,
	`active`, `created_at`
)
SELECT
	'recurrence-psiquiatra-dayane', r.`name`, r.`group_id`, 'Dayane', r.`account_id`,
	r.`credit_card_id`, r.`category_id`, 70000, r.`currency`, r.`direction`,
	r.`amount_mode`, r.`destination_mode`, r.`frequency`, r.`starts_on`,
	r.`schedule_anchor`, r.`next_date`, r.`date_tolerance_days`,
	r.`amount_tolerance_bps`, r.`auto_match_enabled`, r.`minimum_confirmations`,
	r.`active`, r.`created_at`
FROM `recurrences` r
JOIN `recurrence_groups` g ON g.`id` = r.`group_id`
WHERE g.`normalized_name` = 'psiquiatra' AND r.`participant_label` = 'Família'
LIMIT 1;--> statement-breakpoint
INSERT INTO `recurrences` (
	`id`, `name`, `group_id`, `participant_label`, `account_id`,
	`credit_card_id`, `category_id`, `amount_cents`, `currency`, `direction`,
	`amount_mode`, `destination_mode`, `frequency`, `starts_on`,
	`schedule_anchor`, `next_date`, `date_tolerance_days`,
	`amount_tolerance_bps`, `auto_match_enabled`, `minimum_confirmations`,
	`active`, `created_at`
)
SELECT
	'recurrence-terapeuta-dayane', r.`name`, r.`group_id`, 'Dayane', r.`account_id`,
	r.`credit_card_id`, r.`category_id`, 150000, r.`currency`, r.`direction`,
	r.`amount_mode`, r.`destination_mode`, r.`frequency`, r.`starts_on`,
	r.`schedule_anchor`, r.`next_date`, r.`date_tolerance_days`,
	r.`amount_tolerance_bps`, r.`auto_match_enabled`, r.`minimum_confirmations`,
	r.`active`, r.`created_at`
FROM `recurrences` r
JOIN `recurrence_groups` g ON g.`id` = r.`group_id`
WHERE g.`normalized_name` = 'terapeuta' AND r.`participant_label` = 'Família'
LIMIT 1;--> statement-breakpoint
INSERT INTO `recurrence_occurrences` (
	`id`, `recurrence_id`, `expected_date`, `expected_amount_cents`, `currency`,
	`direction`, `category_id`, `status`, `resolved_at`, `created_at`
)
SELECT
	'split-dayane-' || o.`id`,
	CASE g.`normalized_name`
		WHEN 'academia' THEN 'recurrence-academia-dayane'
		WHEN 'psiquiatra' THEN 'recurrence-psiquiatra-dayane'
		WHEN 'terapeuta' THEN 'recurrence-terapeuta-dayane'
	END,
	o.`expected_date`,
	CASE g.`normalized_name`
		WHEN 'academia' THEN 25000
		WHEN 'psiquiatra' THEN 70000
		WHEN 'terapeuta' THEN 150000
	END,
	o.`currency`, o.`direction`, o.`category_id`, o.`status`, o.`resolved_at`, o.`created_at`
FROM `recurrence_occurrences` o
JOIN `recurrences` r ON r.`id` = o.`recurrence_id`
JOIN `recurrence_groups` g ON g.`id` = r.`group_id`
WHERE
	r.`participant_label` = 'Família'
	AND g.`normalized_name` IN ('academia', 'psiquiatra', 'terapeuta')
	AND o.`status` = 'expected';--> statement-breakpoint
UPDATE `recurrence_matches`
SET `status` = 'rejected', `resolved_at` = unixepoch()
WHERE
	`status` = 'suggested'
	AND `occurrence_id` IN (
		SELECT o.`id`
		FROM `recurrence_occurrences` o
		JOIN `recurrences` r ON r.`id` = o.`recurrence_id`
		JOIN `recurrence_groups` g ON g.`id` = r.`group_id`
		WHERE
			r.`participant_label` = 'Família'
			AND g.`normalized_name` IN ('academia', 'psiquiatra', 'terapeuta')
	);--> statement-breakpoint
UPDATE `recurrence_occurrences`
SET `expected_amount_cents` = CASE (
	SELECT g.`normalized_name`
	FROM `recurrences` r
	JOIN `recurrence_groups` g ON g.`id` = r.`group_id`
	WHERE r.`id` = `recurrence_occurrences`.`recurrence_id`
)
	WHEN 'academia' THEN 25000
	WHEN 'psiquiatra' THEN 60000
	WHEN 'terapeuta' THEN 150000
END
WHERE
	`status` = 'expected'
	AND `recurrence_id` IN (
		SELECT r.`id`
		FROM `recurrences` r
		JOIN `recurrence_groups` g ON g.`id` = r.`group_id`
		WHERE
			r.`participant_label` = 'Família'
			AND g.`normalized_name` IN ('academia', 'psiquiatra', 'terapeuta')
	);--> statement-breakpoint
UPDATE `recurrences`
SET
	`participant_label` = 'Donald',
	`amount_cents` = CASE (
		SELECT g.`normalized_name`
		FROM `recurrence_groups` g
		WHERE g.`id` = `recurrences`.`group_id`
	)
		WHEN 'academia' THEN 25000
		WHEN 'psiquiatra' THEN 60000
		WHEN 'terapeuta' THEN 150000
	END
WHERE
	`participant_label` = 'Família'
	AND `group_id` IN (
		SELECT `id` FROM `recurrence_groups`
		WHERE `normalized_name` IN ('academia', 'psiquiatra', 'terapeuta')
	);
