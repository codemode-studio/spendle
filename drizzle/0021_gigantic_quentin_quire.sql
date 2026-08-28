ALTER TABLE `recurrences` ADD `schedule_anchor` text DEFAULT '1970-01-01' NOT NULL;--> statement-breakpoint
UPDATE `recurrences`
SET `schedule_anchor` = `next_date`
WHERE `schedule_anchor` = '1970-01-01';--> statement-breakpoint
WITH `target_groups` AS (
	SELECT DISTINCT `group_row`.`id`
	FROM `reconciliation_groups` AS `group_row`
	WHERE
		`group_row`.`type` = 'transfer'
		AND `group_row`.`status` = 'confirmed'
		AND `group_row`.`reason` = 'Contas vinculadas por uma confirmação manual anterior.'
		AND EXISTS (
			SELECT 1
			FROM `reconciliation_links` AS `company_link`
			JOIN `transactions` AS `company_transaction` ON `company_transaction`.`id` = `company_link`.`transaction_id`
			LEFT JOIN `accounts` AS `company_account` ON `company_account`.`id` = `company_transaction`.`account_id`
			LEFT JOIN `credit_cards` AS `company_card` ON `company_card`.`id` = `company_transaction`.`credit_card_id`
			JOIN `ownership_scopes` AS `company_scope` ON `company_scope`.`id` = coalesce(`company_account`.`ownership_scope_id`, `company_card`.`ownership_scope_id`)
			WHERE `company_link`.`group_id` = `group_row`.`id`
				AND `company_scope`.`type` IN ('company_br', 'company_us')
		)
		AND EXISTS (
			SELECT 1
			FROM `reconciliation_links` AS `family_link`
			JOIN `transactions` AS `family_transaction` ON `family_transaction`.`id` = `family_link`.`transaction_id`
			LEFT JOIN `accounts` AS `family_account` ON `family_account`.`id` = `family_transaction`.`account_id`
			LEFT JOIN `credit_cards` AS `family_card` ON `family_card`.`id` = `family_transaction`.`credit_card_id`
			JOIN `ownership_scopes` AS `family_scope` ON `family_scope`.`id` = coalesce(`family_account`.`ownership_scope_id`, `family_card`.`ownership_scope_id`)
			WHERE `family_link`.`group_id` = `group_row`.`id`
				AND `family_scope`.`type` IN ('household', 'person')
		)
)
UPDATE `transactions`
SET `category_id` = (
	SELECT `link`.`previous_category_id`
	FROM `reconciliation_links` AS `link`
	WHERE `link`.`transaction_id` = `transactions`.`id`
		AND `link`.`group_id` IN (SELECT `id` FROM `target_groups`)
	LIMIT 1
)
WHERE `id` IN (
	SELECT `link`.`transaction_id`
	FROM `reconciliation_links` AS `link`
	WHERE `link`.`group_id` IN (SELECT `id` FROM `target_groups`)
);--> statement-breakpoint
WITH `target_groups` AS (
	SELECT DISTINCT `group_row`.`id`
	FROM `reconciliation_groups` AS `group_row`
	WHERE
		`group_row`.`type` = 'transfer'
		AND `group_row`.`status` = 'confirmed'
		AND `group_row`.`reason` = 'Contas vinculadas por uma confirmação manual anterior.'
		AND EXISTS (
			SELECT 1
			FROM `reconciliation_links` AS `company_link`
			JOIN `transactions` AS `company_transaction` ON `company_transaction`.`id` = `company_link`.`transaction_id`
			LEFT JOIN `accounts` AS `company_account` ON `company_account`.`id` = `company_transaction`.`account_id`
			LEFT JOIN `credit_cards` AS `company_card` ON `company_card`.`id` = `company_transaction`.`credit_card_id`
			JOIN `ownership_scopes` AS `company_scope` ON `company_scope`.`id` = coalesce(`company_account`.`ownership_scope_id`, `company_card`.`ownership_scope_id`)
			WHERE `company_link`.`group_id` = `group_row`.`id`
				AND `company_scope`.`type` IN ('company_br', 'company_us')
		)
		AND EXISTS (
			SELECT 1
			FROM `reconciliation_links` AS `family_link`
			JOIN `transactions` AS `family_transaction` ON `family_transaction`.`id` = `family_link`.`transaction_id`
			LEFT JOIN `accounts` AS `family_account` ON `family_account`.`id` = `family_transaction`.`account_id`
			LEFT JOIN `credit_cards` AS `family_card` ON `family_card`.`id` = `family_transaction`.`credit_card_id`
			JOIN `ownership_scopes` AS `family_scope` ON `family_scope`.`id` = coalesce(`family_account`.`ownership_scope_id`, `family_card`.`ownership_scope_id`)
			WHERE `family_link`.`group_id` = `group_row`.`id`
				AND `family_scope`.`type` IN ('household', 'person')
		)
)
UPDATE `reconciliation_groups`
SET
	`type` = 'profit_distribution',
	`status` = 'suggested',
	`confidence` = 97,
	`reason` = 'Contas PJ e PF já relacionadas; confirme se esta movimentação é distribuição de lucros.'
WHERE `id` IN (SELECT `id` FROM `target_groups`);
