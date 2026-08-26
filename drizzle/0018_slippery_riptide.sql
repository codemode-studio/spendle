INSERT OR IGNORE INTO `accounts` (
  `id`,
  `ownership_scope_id`,
  `institution_id`,
  `name`,
  `kind`,
  `purpose`,
  `currency`,
  `initial_balance_cents`,
  `active`,
  `created_at`
)
SELECT
  CASE `id`
    WHEN 'valuation-btg-joint' THEN 'account-btg-joint-investment'
    WHEN 'valuation-inter-investments' THEN 'account-inter-investments'
    ELSE 'investment-account-' || `id`
  END,
  `ownership_scope_id`,
  `institution_id`,
  `name`,
  'investment',
  'investment',
  `currency`,
  0,
  `active`,
  `created_at`
FROM `valuation_containers`;--> statement-breakpoint
INSERT OR IGNORE INTO `balance_checkpoints` (
  `id`,
  `account_id`,
  `kind`,
  `balance_type`,
  `source`,
  `review_state`,
  `balance_cents`,
  `as_of`,
  `verified`,
  `evidence_json`,
  `created_at`
)
SELECT
  'valuation-checkpoint-' || snapshot.`id`,
  CASE container.`id`
    WHEN 'valuation-btg-joint' THEN 'account-btg-joint-investment'
    WHEN 'valuation-inter-investments' THEN 'account-inter-investments'
    ELSE 'investment-account-' || container.`id`
  END,
  'manual',
  'posted',
  'manual',
  'observed',
  snapshot.`value_cents`,
  snapshot.`valued_at`,
  1,
  json_object(
    'legacyValuationSnapshotId', snapshot.`id`,
    'note', snapshot.`note`
  ),
  snapshot.`created_at`
FROM `valuation_snapshots` snapshot
INNER JOIN `valuation_containers` container
  ON container.`id` = snapshot.`container_id`;--> statement-breakpoint
UPDATE `accounts`
SET
  `statement_balance_cents` = (
    SELECT snapshot.`value_cents`
    FROM `valuation_snapshots` snapshot
    INNER JOIN `valuation_containers` container
      ON container.`id` = snapshot.`container_id`
    WHERE `accounts`.`id` = CASE container.`id`
      WHEN 'valuation-btg-joint' THEN 'account-btg-joint-investment'
      WHEN 'valuation-inter-investments' THEN 'account-inter-investments'
      ELSE 'investment-account-' || container.`id`
    END
    ORDER BY snapshot.`valued_at` DESC, snapshot.`created_at` DESC
    LIMIT 1
  ),
  `statement_balance_at` = (
    SELECT snapshot.`valued_at`
    FROM `valuation_snapshots` snapshot
    INNER JOIN `valuation_containers` container
      ON container.`id` = snapshot.`container_id`
    WHERE `accounts`.`id` = CASE container.`id`
      WHEN 'valuation-btg-joint' THEN 'account-btg-joint-investment'
      WHEN 'valuation-inter-investments' THEN 'account-inter-investments'
      ELSE 'investment-account-' || container.`id`
    END
    ORDER BY snapshot.`valued_at` DESC, snapshot.`created_at` DESC
    LIMIT 1
  )
WHERE `accounts`.`id` IN (
  SELECT CASE container.`id`
    WHEN 'valuation-btg-joint' THEN 'account-btg-joint-investment'
    WHEN 'valuation-inter-investments' THEN 'account-inter-investments'
    ELSE 'investment-account-' || container.`id`
  END
  FROM `valuation_containers` container
  INNER JOIN `valuation_snapshots` snapshot
    ON snapshot.`container_id` = container.`id`
);--> statement-breakpoint
DROP TABLE `valuation_snapshots`;--> statement-breakpoint
DROP TABLE `valuation_containers`;
