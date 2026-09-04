UPDATE `imports`
SET `validation_reason` = CASE
	WHEN `validation_message` = 'O mesmo arquivo já foi associado a outro destino. O lote foi bloqueado.'
		THEN 'identical_file'
	WHEN
		(`account_id` IS NOT NULL AND `document_kind` = 'card_statement')
		OR (`credit_card_id` IS NOT NULL AND `document_kind` = 'bank_statement')
		OR `validation_message` = 'O tipo de documento não corresponde ao destino selecionado.'
		OR `validation_message` LIKE 'O documento parece ser de %, mas o destino selecionado é %.'
		OR `validation_message` LIKE 'O documento termina em •%, diferente do destino selecionado.'
		OR `validation_message` LIKE 'O CSV termina em •%, mas o destino selecionado termina em •%.'
		THEN 'destination_conflict'
	WHEN
		`status` = 'failed'
		OR `parser` = 'pdf_ai'
		OR coalesce(`pages_needing_ocr_json`, '[]') NOT IN ('[]', 'null', '')
		OR (
			json_valid(`extraction_diagnostics_json`)
			AND (
				json_extract(`extraction_diagnostics_json`, '$.suspiciousTextLoss') = 1
				OR json_extract(`extraction_diagnostics_json`, '$.disagreesWithLegacy') = 1
				OR json_extract(`extraction_diagnostics_json`, '$.aiConfirmation.status') IN ('divergent', 'failed', 'fallback_unverified')
			)
		)
		THEN 'blocked'
	WHEN `invalid_transaction_count` > 0 THEN 'invalid_rows'
	WHEN coalesce(`balance_difference_cents`, 0) <> 0 THEN 'balance_mismatch'
	WHEN `validation_status` = 'reconciled' THEN 'ready'
	WHEN `validation_status` = 'imported' AND `closing_balance_cents` IS NULL THEN 'needs_balance'
	WHEN `validation_status` = 'imported' THEN 'ready'
	WHEN `validation_status` = 'warning' AND `closing_balance_cents` IS NULL THEN 'needs_balance'
	WHEN `validation_status` = 'warning' THEN 'needs_manual_review'
	ELSE NULL
END
WHERE `validation_reason` IS NULL;
