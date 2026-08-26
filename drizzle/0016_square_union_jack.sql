ALTER TABLE `imports` ADD `depends_on_import_id` text REFERENCES imports(id) ON DELETE SET NULL;
