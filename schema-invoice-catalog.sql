-- Reusable catalog of recurring invoice line items (e.g. "Cleanroom
-- certification", "Service call fee") so they don't need to be re-typed on
-- every invoice. Picking one from the catalog just pre-fills a normal line
-- item -- the invoice's copy is independent afterward, so editing an
-- invoice never changes the catalog and editing the catalog never changes
-- past invoices.

CREATE TABLE IF NOT EXISTS catalog_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  unit_price NUMERIC(10,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_catalog_items_company ON catalog_items (company_id);
