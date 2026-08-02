-- Lets a catalog item be tagged with its UPC/EAN barcode so it can be found
-- instantly by scanning instead of searching by name -- the core of the
-- "scan to restock" flow (see GET /catalog-items/lookup-barcode/:barcode in
-- routes/admin.js). Nullable: plenty of items (service fees, custom-cut
-- materials) never have a barcode at all.
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS barcode TEXT;

-- Unique per company (not globally -- two different companies could each
-- legitimately stock something with the same manufacturer barcode), and only
-- enforced when a barcode is actually set, so the many items with barcode =
-- NULL don't collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS idx_catalog_items_company_barcode
  ON catalog_items (company_id, barcode) WHERE barcode IS NOT NULL;
