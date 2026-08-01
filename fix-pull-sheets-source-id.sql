ALTER TABLE pull_sheets ALTER COLUMN source_id DROP NOT NULL;
ALTER TABLE pull_sheets DROP CONSTRAINT IF EXISTS pull_sheets_source_type_check;
ALTER TABLE pull_sheets ADD CONSTRAINT pull_sheets_source_type_check CHECK (source_type IN ('quote', 'invoice', 'manual'));
