DROP INDEX `open_finance_observation_version_idx`;--> statement-breakpoint
CREATE INDEX `open_finance_observation_version_idx` ON `open_finance_transaction_observations` (`open_finance_account_id`,`provider_transaction_id`,`content_hash`);
