UPDATE `transactions`
SET `category_id` = 'delivery'
WHERE `category_id` IN ('food', 'leisure', 'other_expense', 'uncategorized')
	AND (
		`normalized_description` LIKE 'ifd*%'
		OR `normalized_description` LIKE '%ifood%'
		OR `normalized_description` LIKE '%rappi%'
		OR `normalized_description` LIKE '%delivery%'
	);--> statement-breakpoint
UPDATE `staged_transactions`
SET `suggested_category_id` = 'delivery'
WHERE `suggested_category_id` IN ('food', 'leisure', 'other_expense', 'uncategorized')
	AND (
		`normalized_description` LIKE 'ifd*%'
		OR `normalized_description` LIKE '%ifood%'
		OR `normalized_description` LIKE '%rappi%'
		OR `normalized_description` LIKE '%delivery%'
	);
