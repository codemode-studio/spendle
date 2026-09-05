-- Base de conhecimento por padrão (plans/reclassificacao-comida-e-kb.md, Entrega 2).
-- Depende das funções SQL knowledge_pattern e merchant_signature registradas em
-- connection.server.ts. Entradas de categoria passam a casar pelo padrão;
-- recorrências continuam pela assinatura completa.
ALTER TABLE `knowledge_base` ADD `pattern` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `knowledge_base` ADD `match_mode` text DEFAULT 'exact' NOT NULL;--> statement-breakpoint
UPDATE `knowledge_base`
SET `pattern` = CASE WHEN `kind` = 'category' THEN knowledge_pattern(`sample_description`) ELSE `signature` END;--> statement-breakpoint
UPDATE `knowledge_base` SET `pattern` = `signature` WHERE length(`pattern`) < 3;--> statement-breakpoint
-- Padrões que reuniriam categorias diferentes voltam à assinatura completa.
CREATE TEMP TABLE `kb_divergent` AS
SELECT `kind`, `pattern`, `match_mode`, `direction`
FROM `knowledge_base`
WHERE `kind` = 'category'
GROUP BY `kind`, `pattern`, `match_mode`, `direction`
HAVING count(DISTINCT `category_id`) > 1;--> statement-breakpoint
UPDATE `knowledge_base`
SET `pattern` = `signature`
WHERE `kind` = 'category'
	AND EXISTS (
		SELECT 1 FROM `kb_divergent` `d`
		WHERE `d`.`kind` = `knowledge_base`.`kind`
			AND `d`.`pattern` = `knowledge_base`.`pattern`
			AND `d`.`match_mode` = `knowledge_base`.`match_mode`
			AND `d`.`direction` = `knowledge_base`.`direction`
	);--> statement-breakpoint
-- Entradas da mesma categoria que colapsam no mesmo padrão se fundem na mais recente.
CREATE TEMP TABLE `kb_merge` AS
SELECT `kind`, `pattern`, `match_mode`, `direction`,
	sum(`confirmations`) AS `confirmations`, max(`corrections`) AS `corrections`
FROM `knowledge_base`
WHERE `kind` = 'category'
GROUP BY `kind`, `pattern`, `match_mode`, `direction`
HAVING count(*) > 1;--> statement-breakpoint
CREATE TEMP TABLE `kb_keep` AS
SELECT
	(
		SELECT `k`.`id` FROM `knowledge_base` `k`
		WHERE `k`.`kind` = `m`.`kind` AND `k`.`pattern` = `m`.`pattern`
			AND `k`.`match_mode` = `m`.`match_mode` AND `k`.`direction` = `m`.`direction`
		ORDER BY `k`.`last_learned_at` DESC, `k`.`rowid` DESC
		LIMIT 1
	) AS `id`,
	`m`.`confirmations`, `m`.`corrections`
FROM `kb_merge` `m`;--> statement-breakpoint
UPDATE `knowledge_base`
SET `confirmations` = (SELECT `confirmations` FROM `kb_keep` WHERE `kb_keep`.`id` = `knowledge_base`.`id`),
	`corrections` = (SELECT `corrections` FROM `kb_keep` WHERE `kb_keep`.`id` = `knowledge_base`.`id`)
WHERE `id` IN (SELECT `id` FROM `kb_keep`);--> statement-breakpoint
DELETE FROM `knowledge_base`
WHERE `kind` = 'category'
	AND `id` NOT IN (SELECT `id` FROM `kb_keep`)
	AND EXISTS (
		SELECT 1 FROM `kb_merge` `m`
		WHERE `m`.`kind` = `knowledge_base`.`kind`
			AND `m`.`pattern` = `knowledge_base`.`pattern`
			AND `m`.`match_mode` = `knowledge_base`.`match_mode`
			AND `m`.`direction` = `knowledge_base`.`direction`
	);--> statement-breakpoint
DROP TABLE `kb_keep`;--> statement-breakpoint
DROP TABLE `kb_merge`;--> statement-breakpoint
DROP TABLE `kb_divergent`;--> statement-breakpoint
DROP INDEX IF EXISTS `knowledge_base_key_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_base_pattern_idx` ON `knowledge_base` (`kind`,`pattern`,`match_mode`,`direction`);--> statement-breakpoint
-- Prefixos aprovados em 2026-09-05. Só entram quando a categoria já existe.
INSERT OR IGNORE INTO `knowledge_base` (
	`id`, `kind`, `signature`, `pattern`, `match_mode`, `direction`, `category_id`, `recurrence_id`,
	`sample_description`, `source`, `confirmations`, `corrections`, `last_learned_at`, `created_at`
)
SELECT lower(hex(randomblob(16))), 'category', 'ifd', 'ifd', 'prefix', 'expense', 'delivery', NULL,
	'IFD*', 'pattern_approval', 1, 0, unixepoch(), unixepoch()
WHERE EXISTS (SELECT 1 FROM `categories` WHERE `id` = 'delivery');--> statement-breakpoint
INSERT OR IGNORE INTO `knowledge_base` (
	`id`, `kind`, `signature`, `pattern`, `match_mode`, `direction`, `category_id`, `recurrence_id`,
	`sample_description`, `source`, `confirmations`, `corrections`, `last_learned_at`, `created_at`
)
SELECT lower(hex(randomblob(16))), 'category', 'mercadolivre', 'mercadolivre', 'prefix', 'expense', 'shopping', NULL,
	'MERCADOLIVRE*', 'pattern_approval', 1, 0, unixepoch(), unixepoch()
WHERE EXISTS (SELECT 1 FROM `categories` WHERE `id` = 'shopping');--> statement-breakpoint
INSERT OR IGNORE INTO `knowledge_base` (
	`id`, `kind`, `signature`, `pattern`, `match_mode`, `direction`, `category_id`, `recurrence_id`,
	`sample_description`, `source`, `confirmations`, `corrections`, `last_learned_at`, `created_at`
)
SELECT lower(hex(randomblob(16))), 'category', 'shopee', 'shopee', 'prefix', 'expense', 'shopping', NULL,
	'Shopee *', 'pattern_approval', 1, 0, unixepoch(), unixepoch()
WHERE EXISTS (SELECT 1 FROM `categories` WHERE `id` = 'shopping');
