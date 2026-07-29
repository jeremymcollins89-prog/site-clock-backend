-- Pull sheets: a physical picking list for gathering inventory-tracked
-- materials off the shelf. Two ways to build one:
--   - From a specific quote or invoice (source_type 'quote'/'invoice',
--     source_id set) -- snapshots that job's inventory-tracked line items.
--   - "Solo" / standalone (source_type 'manual', source_id null) -- items
--     picked by hand, not tied to any job.
-- Building one is just a snapshot (no inventory change yet); marking it
-- "fulfilled" is what actually removes the pulled quantities from stock
-- (both quantity_on_hand and quantity_on_hold for job-based sheets, via the
-- same consumeInventoryForLineItems helper already used when an invoice is
-- paid; quantity_on_hand only for solo sheets, since there's no hold to
-- release when nothing was ever reserved for a job).
--
-- source_type/source_id point at the quote or invoice this sheet was built
-- from (no FK -- either table is valid, and the row should survive even if
-- the source is later deleted, since it's a record of real inventory
-- movement that already happened once fulfilled). source_label/customer_name
-- are snapshotted at build time so the sheet still reads sensibly if the
-- source is later deleted or renumbered. For solo sheets, source_label is
-- whatever the admin typed in as a description ("Restocking the van", etc).
--
-- Building a sheet against a job always computes each item's quantity as
-- (that line item's quantity minus whatever's already been pulled in a
-- previously-fulfilled sheet for the same source) -- so building a second
-- sheet for a job that was already partially pulled only asks for what's
-- left, and it's not possible to double-pull (and thus double-consume) the
-- same units no matter how many sheets get built for one job. See
-- getPulledQuantities / consumeRemainingAfterPulls in utils/inventory.js.
-- Solo sheets have no such tracking since they're not tied to any job.
--
-- A fulfilled sheet can never be deleted (only an open/not-yet-fulfilled one
-- can) -- deleting a fulfilled sheet would erase the record of inventory
-- already having been physically removed, causing it to be double-consumed
-- again whenever the invoice is later marked paid.

CREATE TABLE IF NOT EXISTS pull_sheets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('quote', 'invoice', 'manual')),
  source_id UUID,
  source_label TEXT,
  customer_name TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'fulfilled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  fulfilled_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS pull_sheet_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pull_sheet_id UUID NOT NULL REFERENCES pull_sheets(id) ON DELETE CASCADE,
  catalog_item_id UUID REFERENCES catalog_items(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  quantity INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pull_sheets_company ON pull_sheets (company_id);
CREATE INDEX IF NOT EXISTS idx_pull_sheets_source ON pull_sheets (source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_pull_sheet_items_sheet ON pull_sheet_items (pull_sheet_id);

-- Safe to re-run even if an earlier version of this table already exists
-- (source_id NOT NULL, source_type limited to quote/invoice, from before
-- solo pull sheets existed) -- widens it to match the shape above.
ALTER TABLE pull_sheets ALTER COLUMN source_id DROP NOT NULL;
ALTER TABLE pull_sheets DROP CONSTRAINT IF EXISTS pull_sheets_source_type_check;
ALTER TABLE pull_sheets ADD CONSTRAINT pull_sheets_source_type_check CHECK (source_type IN ('quote', 'invoice', 'manual'));
