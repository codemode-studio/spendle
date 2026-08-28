UPDATE `recurrences`
SET `starts_on` = CASE
	WHEN `frequency` = 'yearly' THEN date(
		`schedule_anchor`,
		'start of month',
		'-1 year',
		'+' || (min(
			cast(strftime('%d', `schedule_anchor`) AS integer),
			cast(strftime('%d', date(`schedule_anchor`, 'start of month', '-1 year', '+1 month', '-1 day')) AS integer)
		) - 1) || ' days'
	)
	ELSE date(
		`schedule_anchor`,
		'start of month',
		'-1 month',
		'+' || (min(
			cast(strftime('%d', `schedule_anchor`) AS integer),
			cast(strftime('%d', date(`schedule_anchor`, 'start of month', '-1 day')) AS integer)
		) - 1) || ' days'
	)
END
WHERE `starts_on` != `schedule_anchor`;
