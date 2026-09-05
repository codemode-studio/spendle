-- Reclassificação de comida (plans/reclassificacao-comida-e-kb.md, Entrega 1).
-- Alimentação (food) fica inativa; Mercado e Restaurantes nascem aqui.
-- Listas de estabelecimentos aprovadas em 2026-09-05; a prévia está em
-- scripts/preview-food-reclassification.ts. Depende de merchant_signature.
INSERT OR IGNORE INTO `categories` (`id`, `name`, `bucket`, `income_base_eligible`, `color`, `active`)
VALUES ('groceries', 'Mercado', 'essential', 0, '#0d9488', 1);
--> statement-breakpoint
INSERT OR IGNORE INTO `categories` (`id`, `name`, `bucket`, `income_base_eligible`, `color`, `active`)
VALUES ('restaurants', 'Restaurantes', 'lifestyle', 0, '#d97706', 1);
--> statement-breakpoint
UPDATE `categories` SET `active` = 0 WHERE `id` = 'food';
--> statement-breakpoint
CREATE TEMP TABLE IF NOT EXISTS `food_reclass` (`transaction_id` text PRIMARY KEY NOT NULL, `category_id` text NOT NULL);
--> statement-breakpoint
DELETE FROM `food_reclass`;
--> statement-breakpoint
INSERT OR IGNORE INTO `food_reclass` (`transaction_id`, `category_id`)
SELECT `id`, 'groceries' FROM `transactions`
WHERE `category_id` IN ('food')
	AND (
		`normalized_description` LIKE 'angeloni%'
		OR `normalized_description` LIKE 'supermercados imperatr%'
		OR `normalized_description` LIKE 'festval%'
		OR `normalized_description` LIKE 'assai atacadista%'
		OR `normalized_description` LIKE 'koch supermercados%'
		OR `normalized_description` LIKE 'acougue gimenis%'
	);
--> statement-breakpoint
INSERT OR IGNORE INTO `food_reclass` (`transaction_id`, `category_id`)
SELECT `id`, 'shopping' FROM `transactions`
WHERE `category_id` IN ('food')
	AND (
		`normalized_description` LIKE 'mercadolivre*%'
	);
--> statement-breakpoint
INSERT OR IGNORE INTO `food_reclass` (`transaction_id`, `category_id`)
SELECT `id`, 'delivery' FROM `transactions`
WHERE `category_id` IN ('leisure')
	AND (
		`normalized_description` LIKE 'easy food%'
	);
--> statement-breakpoint
INSERT OR IGNORE INTO `food_reclass` (`transaction_id`, `category_id`)
SELECT `id`, 'leisure' FROM `transactions`
WHERE `category_id` IN ('food')
	AND (
		`normalized_description` LIKE 'rede pratique%'
	);
--> statement-breakpoint
INSERT OR IGNORE INTO `food_reclass` (`transaction_id`, `category_id`)
SELECT `id`, 'personal_care' FROM `transactions`
WHERE `category_id` IN ('food')
	AND (
		`normalized_description` LIKE 'lovea express%'
	);
--> statement-breakpoint
INSERT OR IGNORE INTO `food_reclass` (`transaction_id`, `category_id`)
SELECT `id`, 'restaurants' FROM `transactions`
WHERE `category_id` IN ('food', 'leisure')
	AND (
		`normalized_description` LIKE 'batel grill%'
		OR `normalized_description` LIKE 'restaurante kharina%'
		OR `normalized_description` LIKE 'braz sushi%'
		OR `normalized_description` LIKE 'nyx bar%'
		OR `normalized_description` LIKE 'ponto restaurante%'
		OR `normalized_description` LIKE 'restaurante casagrande%'
		OR `normalized_description` LIKE 'bier hoff%'
		OR `normalized_description` LIKE 'nice restaurante%'
		OR `normalized_description` LIKE 'pauli doces%'
		OR `normalized_description` LIKE 'la crepioca%'
		OR `normalized_description` LIKE 'ciadosorvete%'
		OR `normalized_description` LIKE 'famdpizzaria%'
		OR `normalized_description` LIKE 'mr cheney%'
		OR `normalized_description` LIKE 'lindt%'
		OR `normalized_description` LIKE 'tio zico%'
		OR `normalized_description` LIKE 'cafe cultura%'
		OR `normalized_description` LIKE 'nkmb coffee%'
		OR `normalized_description` LIKE 'o original na brasa%'
		OR `normalized_description` LIKE 'kontainer beer%'
		OR `normalized_description` LIKE 'flor de brasa%'
		OR `normalized_description` LIKE 'oliva cheese%'
		OR `normalized_description` LIKE 'b2rm bar%'
		OR `normalized_description` LIKE 'jurere on cafeteria%'
		OR `normalized_description` LIKE 'noma jurere%'
		OR `normalized_description` LIKE 'stb*carbone%'
		OR `normalized_description` LIKE 'alimentare baldovino%'
		OR `normalized_description` LIKE 'saint claire bakery%'
		OR `normalized_description` LIKE 'prestinaria%'
		OR `normalized_description` LIKE 'ivasp comercio%'
		OR `normalized_description` LIKE 'breadbox%'
		OR `normalized_description` LIKE 'grife de boteco%'
		OR `normalized_description` LIKE 'fronteira%hamburg%'
		OR `normalized_description` LIKE 'r2 bar%'
		OR `normalized_description` LIKE 'better comercio%'
		OR `normalized_description` LIKE 'benvenuta bar%'
		OR `normalized_description` LIKE 'santocrepe%'
		OR `normalized_description` LIKE 'htm*besties%'
		OR `normalized_description` LIKE 'brasil berry%'
		OR `normalized_description` LIKE 'cacau show%'
		OR `normalized_description` LIKE 'barra beach%'
		OR `normalized_description` LIKE 'bunker22%'
		OR `normalized_description` LIKE 'green island%'
		OR `normalized_description` LIKE 'v a c u n o%'
	);
--> statement-breakpoint
UPDATE `staged_transactions`
SET `suggested_category_id` = (
	SELECT `r`.`category_id` FROM `food_reclass` `r`
	JOIN `transaction_evidence` `e` ON `e`.`transaction_id` = `r`.`transaction_id`
	WHERE `e`.`staged_transaction_id` = `staged_transactions`.`id`
	LIMIT 1
)
WHERE `id` IN (
	SELECT `e`.`staged_transaction_id` FROM `transaction_evidence` `e`
	JOIN `food_reclass` `r` ON `r`.`transaction_id` = `e`.`transaction_id`
);
--> statement-breakpoint
UPDATE `staged_transactions`
SET `suggested_category_id` = 'groceries'
WHERE `suggested_category_id` IN ('food')
	AND (
		`normalized_description` LIKE 'angeloni%'
		OR `normalized_description` LIKE 'supermercados imperatr%'
		OR `normalized_description` LIKE 'festval%'
		OR `normalized_description` LIKE 'assai atacadista%'
		OR `normalized_description` LIKE 'koch supermercados%'
		OR `normalized_description` LIKE 'acougue gimenis%'
	);
--> statement-breakpoint
UPDATE `staged_transactions`
SET `suggested_category_id` = 'shopping'
WHERE `suggested_category_id` IN ('food')
	AND (
		`normalized_description` LIKE 'mercadolivre*%'
	);
--> statement-breakpoint
UPDATE `staged_transactions`
SET `suggested_category_id` = 'delivery'
WHERE `suggested_category_id` IN ('leisure')
	AND (
		`normalized_description` LIKE 'easy food%'
	);
--> statement-breakpoint
UPDATE `staged_transactions`
SET `suggested_category_id` = 'leisure'
WHERE `suggested_category_id` IN ('food')
	AND (
		`normalized_description` LIKE 'rede pratique%'
	);
--> statement-breakpoint
UPDATE `staged_transactions`
SET `suggested_category_id` = 'personal_care'
WHERE `suggested_category_id` IN ('food')
	AND (
		`normalized_description` LIKE 'lovea express%'
	);
--> statement-breakpoint
UPDATE `staged_transactions`
SET `suggested_category_id` = 'restaurants'
WHERE `suggested_category_id` IN ('food', 'leisure')
	AND (
		`normalized_description` LIKE 'batel grill%'
		OR `normalized_description` LIKE 'restaurante kharina%'
		OR `normalized_description` LIKE 'braz sushi%'
		OR `normalized_description` LIKE 'nyx bar%'
		OR `normalized_description` LIKE 'ponto restaurante%'
		OR `normalized_description` LIKE 'restaurante casagrande%'
		OR `normalized_description` LIKE 'bier hoff%'
		OR `normalized_description` LIKE 'nice restaurante%'
		OR `normalized_description` LIKE 'pauli doces%'
		OR `normalized_description` LIKE 'la crepioca%'
		OR `normalized_description` LIKE 'ciadosorvete%'
		OR `normalized_description` LIKE 'famdpizzaria%'
		OR `normalized_description` LIKE 'mr cheney%'
		OR `normalized_description` LIKE 'lindt%'
		OR `normalized_description` LIKE 'tio zico%'
		OR `normalized_description` LIKE 'cafe cultura%'
		OR `normalized_description` LIKE 'nkmb coffee%'
		OR `normalized_description` LIKE 'o original na brasa%'
		OR `normalized_description` LIKE 'kontainer beer%'
		OR `normalized_description` LIKE 'flor de brasa%'
		OR `normalized_description` LIKE 'oliva cheese%'
		OR `normalized_description` LIKE 'b2rm bar%'
		OR `normalized_description` LIKE 'jurere on cafeteria%'
		OR `normalized_description` LIKE 'noma jurere%'
		OR `normalized_description` LIKE 'stb*carbone%'
		OR `normalized_description` LIKE 'alimentare baldovino%'
		OR `normalized_description` LIKE 'saint claire bakery%'
		OR `normalized_description` LIKE 'prestinaria%'
		OR `normalized_description` LIKE 'ivasp comercio%'
		OR `normalized_description` LIKE 'breadbox%'
		OR `normalized_description` LIKE 'grife de boteco%'
		OR `normalized_description` LIKE 'fronteira%hamburg%'
		OR `normalized_description` LIKE 'r2 bar%'
		OR `normalized_description` LIKE 'better comercio%'
		OR `normalized_description` LIKE 'benvenuta bar%'
		OR `normalized_description` LIKE 'santocrepe%'
		OR `normalized_description` LIKE 'htm*besties%'
		OR `normalized_description` LIKE 'brasil berry%'
		OR `normalized_description` LIKE 'cacau show%'
		OR `normalized_description` LIKE 'barra beach%'
		OR `normalized_description` LIKE 'bunker22%'
		OR `normalized_description` LIKE 'green island%'
		OR `normalized_description` LIKE 'v a c u n o%'
	);
--> statement-breakpoint
UPDATE `installment_plans`
SET `category_id` = (SELECT `r`.`category_id` FROM `food_reclass` `r` WHERE `r`.`transaction_id` = `installment_plans`.`source_transaction_id`)
WHERE `source_transaction_id` IN (SELECT `transaction_id` FROM `food_reclass`)
	AND `category_id` IN ('food', 'leisure');
--> statement-breakpoint
UPDATE `transaction_splits`
SET `category_id` = (SELECT `r`.`category_id` FROM `food_reclass` `r` WHERE `r`.`transaction_id` = `transaction_splits`.`transaction_id`)
WHERE `transaction_id` IN (SELECT `transaction_id` FROM `food_reclass`)
	AND `category_id` IN ('food', 'leisure');
--> statement-breakpoint
UPDATE `recurrence_matches`
SET `previous_category_id` = (SELECT `r`.`category_id` FROM `food_reclass` `r` WHERE `r`.`transaction_id` = `recurrence_matches`.`transaction_id`)
WHERE `transaction_id` IN (SELECT `transaction_id` FROM `food_reclass`)
	AND `previous_category_id` IN ('food', 'leisure');
--> statement-breakpoint
UPDATE `reconciliation_links`
SET `previous_category_id` = (SELECT `r`.`category_id` FROM `food_reclass` `r` WHERE `r`.`transaction_id` = `reconciliation_links`.`transaction_id`)
WHERE `transaction_id` IN (SELECT `transaction_id` FROM `food_reclass`)
	AND `previous_category_id` IN ('food', 'leisure');
--> statement-breakpoint
UPDATE `transactions`
SET `category_id` = (SELECT `r`.`category_id` FROM `food_reclass` `r` WHERE `r`.`transaction_id` = `transactions`.`id`)
WHERE `id` IN (SELECT `transaction_id` FROM `food_reclass`);
--> statement-breakpoint
UPDATE `recurrences` SET `category_id` = 'groceries' WHERE `category_id` = 'food';
--> statement-breakpoint
UPDATE `recurrence_occurrences` SET `category_id` = 'groceries' WHERE `category_id` = 'food';
--> statement-breakpoint
UPDATE `categorization_rules` SET `category_id` = 'groceries' WHERE `category_id` = 'food';
--> statement-breakpoint
UPDATE `knowledge_base`
SET `category_id` = (
	SELECT `t`.`category_id` FROM `transactions` `t`
	JOIN `food_reclass` `r` ON `r`.`transaction_id` = `t`.`id`
	WHERE merchant_signature(`t`.`description`) = `knowledge_base`.`signature`
		AND (CASE WHEN `t`.`amount_cents` < 0 THEN 'expense' ELSE 'income' END) = `knowledge_base`.`direction`
	ORDER BY `t`.`created_at` DESC
	LIMIT 1
)
WHERE `kind` = 'category'
	AND EXISTS (
		SELECT 1 FROM `transactions` `t`
		JOIN `food_reclass` `r` ON `r`.`transaction_id` = `t`.`id`
		WHERE merchant_signature(`t`.`description`) = `knowledge_base`.`signature`
			AND (CASE WHEN `t`.`amount_cents` < 0 THEN 'expense' ELSE 'income' END) = `knowledge_base`.`direction`
	);
--> statement-breakpoint
-- Aprendizados que apontariam para a categoria inativa deixam de existir.
DELETE FROM `knowledge_base` WHERE `kind` = 'category' AND `category_id` = 'food';
--> statement-breakpoint
DELETE FROM `knowledge_base` WHERE `kind` = 'category' AND `signature` = 'em conta';
--> statement-breakpoint
DROP TABLE `food_reclass`;
