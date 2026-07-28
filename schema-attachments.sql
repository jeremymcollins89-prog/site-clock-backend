-- File attachments for jobs (Schedule) and invoices -- photos, PDFs,
-- contracts, whatever an admin wants on file for a specific job or
-- invoice. Stored directly in Postgres as bytea, same approach already
-- used for the company logo (see schema-company-logo.sql) -- these are
-- individually capped at 10MB client- and server-side, and this avoids
-- introducing S3/blob-storage infrastructure. entity_type/entity_id is a
-- simple polymorphic reference (no DB-level FK, since it can point at
-- either jobs or invoices) -- ownership is always double-checked against
-- company_id in the route handlers before any read/write.

CREATE TABLE IF NOT EXISTS attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('job', 'invoice')),
  entity_id UUID NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  file_data BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_attachments_entity ON attachments (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_attachments_company ON attachments (company_id);
