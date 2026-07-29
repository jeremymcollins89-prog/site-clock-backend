-- Adds optional inventory tracking to catalog items, and links quote/invoice
-- line items back to the catalog item they were added from (previously
-- picking an item from the catalog just copied its name/price as plain text
-- with no lasting connection -- inventory holds need that connection to know
-- which item's stock to adjust).
--
-- track_inventory is opt-in per catalog item (false by default) since many
-- catalog items are services/labor with no physical stock to count.
--
-- quantity_on_hand: total units currently owned (only meaningful once
--   track_inventory is turned on).
-- quantity_on_hold: units reserved by a not-yet-paid quote or invoice.
--   "Available" for display purposes is always quantity_on_hand -
--   quantity_on_hold, computed at read time rather than stored.
-- unit_cost: what the item costs the business (distinct from unit_price,
--   which is what's charged to the customer) -- used for the total
--   inventory value bubbles.
-- low_stock_threshold: per-item alert level, set in the Inventory tab's
--   Settings view. Null means no alert configured for that item.
-- low_stock_alert_sent: tracks whether the low-stock push has already gone
--   out for the item's current dip below threshold, so it doesn't re-fire
--   on every single hold/consume -- reset back to false once available
--   quantity rises back above the threshold (e.g. after a restock).

ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS track_inventory BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS quantity_on_hand INTEGER NOT NULL DEFAULT 0;
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS quantity_on_hold INTEGER NOT NULL DEFAULT 0;
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(10,2);
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS low_stock_threshold INTEGER;
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS low_stock_alert_sent BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE quote_line_items ADD COLUMN IF NOT EXISTS catalog_item_id UUID REFERENCES catalog_items(id) ON DELETE SET NULL;
ALTER TABLE invoice_line_items ADD COLUMN IF NOT EXISTS catalog_item_id UUID REFERENCES catalog_items(id) ON DELETE SET NULL;
