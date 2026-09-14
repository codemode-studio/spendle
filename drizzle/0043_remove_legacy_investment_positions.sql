DELETE FROM `investment_positions`
WHERE `id` LIKE 'legacy-%'
AND NOT EXISTS (
	SELECT 1
	FROM `investment_position_movements`
	WHERE `investment_position_movements`.`position_id` = `investment_positions`.`id`
);
