-- Optional company logo, shown on generated invoice PDFs. Stored directly
-- in Postgres as bytea rather than a separate file-storage service -- these
-- are small images (validated client- and server-side to a few MB) and this
-- avoids introducing S3/blob-storage infrastructure for a single small
-- asset per company.

ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo_data BYTEA;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo_mime_type TEXT;
