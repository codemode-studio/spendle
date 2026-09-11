CREATE TABLE `monthly_reports` (
  `month` text PRIMARY KEY NOT NULL,
  `report` text NOT NULL,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL,
  FOREIGN KEY (`month`) REFERENCES `monthly_budgets`(`month`) ON DELETE CASCADE
);
