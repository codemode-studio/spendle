UPDATE `transactions`
SET `category_id` = 'other_expense'
WHERE `category_id` = 'gifts_donations';--> statement-breakpoint
UPDATE `staged_transactions`
SET `suggested_category_id` = 'other_expense'
WHERE `suggested_category_id` = 'gifts_donations';--> statement-breakpoint
UPDATE `transaction_splits`
SET `category_id` = 'other_expense'
WHERE `category_id` = 'gifts_donations';--> statement-breakpoint
UPDATE `categorization_rules`
SET `category_id` = 'other_expense'
WHERE `category_id` = 'gifts_donations';--> statement-breakpoint
UPDATE `reconciliation_links`
SET `previous_category_id` = 'other_expense'
WHERE `previous_category_id` = 'gifts_donations';--> statement-breakpoint
UPDATE `recurrences`
SET `category_id` = 'other_expense'
WHERE `category_id` = 'gifts_donations';--> statement-breakpoint
UPDATE `recurrence_occurrences`
SET `category_id` = 'other_expense'
WHERE `category_id` = 'gifts_donations';--> statement-breakpoint
UPDATE `recurrence_matches`
SET `previous_category_id` = 'other_expense'
WHERE `previous_category_id` = 'gifts_donations';--> statement-breakpoint
UPDATE `installment_plans`
SET `category_id` = 'other_expense'
WHERE `category_id` = 'gifts_donations';--> statement-breakpoint
DELETE FROM `categories`
WHERE `id` = 'gifts_donations';
