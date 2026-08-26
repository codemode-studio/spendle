UPDATE `transactions`
SET `category_id` = 'profit_distribution_income'
WHERE `category_id` = 'profit_distribution_company';--> statement-breakpoint
UPDATE `staged_transactions`
SET `suggested_category_id` = 'profit_distribution_income'
WHERE `suggested_category_id` = 'profit_distribution_company';--> statement-breakpoint
UPDATE `transaction_splits`
SET `category_id` = 'profit_distribution_income'
WHERE `category_id` = 'profit_distribution_company';--> statement-breakpoint
UPDATE `categorization_rules`
SET `category_id` = 'profit_distribution_income'
WHERE `category_id` = 'profit_distribution_company';--> statement-breakpoint
UPDATE `reconciliation_links`
SET `previous_category_id` = 'profit_distribution_income'
WHERE `previous_category_id` = 'profit_distribution_company';--> statement-breakpoint
UPDATE `recurrences`
SET `category_id` = 'profit_distribution_income'
WHERE `category_id` = 'profit_distribution_company';--> statement-breakpoint
UPDATE `installment_plans`
SET `category_id` = 'profit_distribution_income'
WHERE `category_id` = 'profit_distribution_company';--> statement-breakpoint
DELETE FROM `categories`
WHERE `id` = 'profit_distribution_company';
