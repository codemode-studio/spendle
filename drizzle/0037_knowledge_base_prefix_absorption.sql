-- Prefixos `mp` (Mercado Pago) e `nuv` (Nuvemshop) aprovados em 2026-09-05, e
-- absorção das entradas exatas já cobertas por um prefixo da mesma categoria.
-- Depende da função SQL knowledge_pattern.
UPDATE `knowledge_base`
SET `pattern` = knowledge_pattern(`sample_description`)
WHERE `kind` = 'category'
	AND `match_mode` = 'exact'
	AND (`signature` LIKE 'mp %' OR `signature` LIKE 'nuv %')
	AND length(knowledge_pattern(`sample_description`)) >= 3;--> statement-breakpoint
INSERT OR IGNORE INTO `knowledge_base` (
	`id`, `kind`, `signature`, `pattern`, `match_mode`, `direction`, `category_id`, `recurrence_id`,
	`sample_description`, `source`, `confirmations`, `corrections`, `last_learned_at`, `created_at`
)
SELECT lower(hex(randomblob(16))), 'category', 'mp', 'mp', 'prefix', 'expense', 'shopping', NULL,
	'MP *', 'pattern_approval', 1, 0, unixepoch(), unixepoch()
WHERE EXISTS (SELECT 1 FROM `categories` WHERE `id` = 'shopping');--> statement-breakpoint
INSERT OR IGNORE INTO `knowledge_base` (
	`id`, `kind`, `signature`, `pattern`, `match_mode`, `direction`, `category_id`, `recurrence_id`,
	`sample_description`, `source`, `confirmations`, `corrections`, `last_learned_at`, `created_at`
)
SELECT lower(hex(randomblob(16))), 'category', 'nuv', 'nuv', 'prefix', 'expense', 'shopping', NULL,
	'Nuv*', 'pattern_approval', 1, 0, unixepoch(), unixepoch()
WHERE EXISTS (SELECT 1 FROM `categories` WHERE `id` = 'shopping');--> statement-breakpoint
UPDATE `knowledge_base`
SET `confirmations` = `confirmations` + (
	SELECT coalesce(sum(`e`.`confirmations`), 0) FROM `knowledge_base` `e`
	WHERE `e`.`kind` = 'category' AND `e`.`match_mode` = 'exact'
		AND `e`.`direction` = `knowledge_base`.`direction`
		AND `e`.`category_id` = `knowledge_base`.`category_id`
		AND (`e`.`pattern` = `knowledge_base`.`pattern` OR `e`.`pattern` LIKE `knowledge_base`.`pattern` || ' %')
)
WHERE `kind` = 'category' AND `match_mode` = 'prefix';--> statement-breakpoint
DELETE FROM `knowledge_base`
WHERE `kind` = 'category' AND `match_mode` = 'exact'
	AND EXISTS (
		SELECT 1 FROM `knowledge_base` `p`
		WHERE `p`.`kind` = 'category' AND `p`.`match_mode` = 'prefix'
			AND `p`.`direction` = `knowledge_base`.`direction`
			AND `p`.`category_id` = `knowledge_base`.`category_id`
			AND (`knowledge_base`.`pattern` = `p`.`pattern` OR `knowledge_base`.`pattern` LIKE `p`.`pattern` || ' %')
	);
