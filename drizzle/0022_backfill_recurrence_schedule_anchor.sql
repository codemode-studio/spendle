UPDATE `recurrences`
SET `schedule_anchor` = `next_date`
WHERE `schedule_anchor` = '1970-01-01';
