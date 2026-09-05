-- Backfill da base de conhecimento a partir das decisões humanas já registradas.
-- Depende da função SQL merchant_signature registrada em connection.server.ts.
INSERT INTO `knowledge_base` (
	`id`, `kind`, `signature`, `direction`, `category_id`, `recurrence_id`,
	`sample_description`, `source`, `confirmations`, `corrections`,
	`last_learned_at`, `created_at`
)
WITH `decisions` AS (
	-- Categoria escolhida na revisão de um lote.
	SELECT
		merchant_signature(`st`.`description`) AS `signature`,
		CASE WHEN `st`.`amount_cents` < 0 THEN 'expense' ELSE 'income' END AS `direction`,
		`st`.`suggested_category_id` AS `category_id`,
		`st`.`description` AS `description`,
		'import_review' AS `source`,
		`st`.`created_at` AS `decided_at`
	FROM `staged_transactions` `st`
	WHERE `st`.`suggestion_source` = 'manual'
		AND `st`.`amount_cents` <> 0
		AND `st`.`suggested_category_id` IS NOT NULL
	UNION ALL
	-- Lançamento importado cuja categoria final difere de uma sugestão concreta.
	SELECT
		merchant_signature(`t`.`description`),
		CASE WHEN `t`.`amount_cents` < 0 THEN 'expense' ELSE 'income' END,
		`t`.`category_id`,
		`t`.`description`,
		'transaction_review',
		`t`.`created_at`
	FROM `transactions` `t`
	JOIN `transaction_evidence` `te`
		ON `te`.`transaction_id` = `t`.`id` AND `te`.`match_kind` = 'created'
	JOIN `staged_transactions` `st` ON `st`.`id` = `te`.`staged_transaction_id`
	WHERE `t`.`amount_cents` <> 0
		AND `t`.`category_id` IS NOT NULL
		AND `st`.`suggested_category_id` IS NOT NULL
		AND `st`.`suggested_category_id` <> 'uncategorized'
		AND `t`.`category_id` <> `st`.`suggested_category_id`
	UNION ALL
	-- Lançamento manual criado já com categoria.
	SELECT
		merchant_signature(`t`.`description`),
		CASE WHEN `t`.`amount_cents` < 0 THEN 'expense' ELSE 'income' END,
		`t`.`category_id`,
		`t`.`description`,
		'transaction_review',
		`t`.`created_at`
	FROM `transactions` `t`
	WHERE `t`.`import_id` IS NULL
		AND `t`.`amount_cents` <> 0
		AND `t`.`category_id` IS NOT NULL
	UNION ALL
	-- Categoria da recorrência aplicada em vínculo confirmado pela pessoa.
	SELECT
		merchant_signature(`t`.`description`),
		CASE WHEN `t`.`amount_cents` < 0 THEN 'expense' ELSE 'income' END,
		`o`.`category_id`,
		`t`.`description`,
		'recurrence_link',
		coalesce(`m`.`confirmed_at`, `m`.`created_at`)
	FROM `recurrence_matches` `m`
	JOIN `recurrence_occurrences` `o` ON `o`.`id` = `m`.`occurrence_id`
	JOIN `transactions` `t` ON `t`.`id` = `m`.`transaction_id`
	WHERE `m`.`status` = 'confirmed'
		AND `t`.`amount_cents` <> 0
		AND `t`.`category_id` = `o`.`category_id`
),
`eligible` AS (
	SELECT * FROM `decisions`
	WHERE length(`signature`) >= 3
		AND `signature` GLOB '*[a-z]*'
		AND `category_id` NOT IN ('uncategorized', 'transfer', 'card_payment')
		AND `category_id` IN (SELECT `id` FROM `categories`)
),
`ranked` AS (
	SELECT *,
		row_number() OVER (PARTITION BY `signature`, `direction` ORDER BY `decided_at` DESC) AS `rank`
	FROM `eligible`
)
SELECT
	lower(hex(randomblob(16))),
	'category',
	`r`.`signature`,
	`r`.`direction`,
	`r`.`category_id`,
	NULL,
	`r`.`description`,
	`r`.`source`,
	(
		SELECT count(*) FROM `eligible` `e`
		WHERE `e`.`signature` = `r`.`signature`
			AND `e`.`direction` = `r`.`direction`
			AND `e`.`category_id` = `r`.`category_id`
	),
	(
		SELECT count(DISTINCT `e`.`category_id`) FROM `eligible` `e`
		WHERE `e`.`signature` = `r`.`signature`
			AND `e`.`direction` = `r`.`direction`
			AND `e`.`category_id` <> `r`.`category_id`
	),
	`r`.`decided_at`,
	unixepoch()
FROM `ranked` `r`
WHERE `r`.`rank` = 1
	AND NOT EXISTS (
		SELECT 1 FROM `knowledge_base` `k`
		WHERE `k`.`kind` = 'category'
			AND `k`.`signature` = `r`.`signature`
			AND `k`.`direction` = `r`.`direction`
	);--> statement-breakpoint
INSERT INTO `knowledge_base` (
	`id`, `kind`, `signature`, `direction`, `category_id`, `recurrence_id`,
	`sample_description`, `source`, `confirmations`, `corrections`,
	`last_learned_at`, `created_at`
)
WITH `links` AS (
	-- Estabelecimento vinculado a uma recorrência por confirmação da pessoa.
	SELECT
		merchant_signature(`t`.`description`) AS `signature`,
		CASE WHEN `t`.`amount_cents` < 0 THEN 'expense' ELSE 'income' END AS `direction`,
		`o`.`recurrence_id` AS `recurrence_id`,
		`t`.`description` AS `description`,
		coalesce(`m`.`confirmed_at`, `m`.`created_at`) AS `decided_at`
	FROM `recurrence_matches` `m`
	JOIN `recurrence_occurrences` `o` ON `o`.`id` = `m`.`occurrence_id`
	JOIN `transactions` `t` ON `t`.`id` = `m`.`transaction_id`
	WHERE `m`.`status` = 'confirmed' AND `t`.`amount_cents` <> 0
),
`eligible` AS (
	SELECT * FROM `links`
	WHERE length(`signature`) >= 3 AND `signature` GLOB '*[a-z]*'
),
`ranked` AS (
	SELECT *,
		row_number() OVER (PARTITION BY `signature`, `direction` ORDER BY `decided_at` DESC) AS `rank`
	FROM `eligible`
)
SELECT
	lower(hex(randomblob(16))),
	'recurrence',
	`r`.`signature`,
	`r`.`direction`,
	NULL,
	`r`.`recurrence_id`,
	`r`.`description`,
	'recurrence_link',
	(
		SELECT count(*) FROM `eligible` `e`
		WHERE `e`.`signature` = `r`.`signature`
			AND `e`.`direction` = `r`.`direction`
			AND `e`.`recurrence_id` = `r`.`recurrence_id`
	),
	(
		SELECT count(DISTINCT `e`.`recurrence_id`) FROM `eligible` `e`
		WHERE `e`.`signature` = `r`.`signature`
			AND `e`.`direction` = `r`.`direction`
			AND `e`.`recurrence_id` <> `r`.`recurrence_id`
	),
	`r`.`decided_at`,
	unixepoch()
FROM `ranked` `r`
WHERE `r`.`rank` = 1
	AND NOT EXISTS (
		SELECT 1 FROM `knowledge_base` `k`
		WHERE `k`.`kind` = 'recurrence'
			AND `k`.`signature` = `r`.`signature`
			AND `k`.`direction` = `r`.`direction`
	);
