CREATE TABLE `initial_analysis` (
  `id` text PRIMARY KEY NOT NULL,
  `month` text NOT NULL,
  `report` text NOT NULL,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL
);
