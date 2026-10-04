ALTER TABLE `reconciliation_groups` ADD `confirmation_source` text;
--> statement-breakpoint
UPDATE `reconciliation_groups` SET `confirmation_source` = 'automatic' WHERE `status` = 'confirmed' AND `reason` IN ('Pagamento de fatura com valor e data correspondentes, sem outro candidato.', 'Contas vinculadas por uma confirmação manual anterior.');
--> statement-breakpoint
UPDATE `reconciliation_groups` SET `confirmation_source` = 'person' WHERE `status` = 'confirmed' AND `confirmation_source` IS NULL;
