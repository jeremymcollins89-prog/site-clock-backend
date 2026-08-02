-- One-time reconciliation after changing what actually holds inventory.
-- Old rule: a quote held stock the moment it was saved.
-- New rule: a quote never holds anything on its own -- only a pull sheet
-- (built from a quote, an invoice, or standalone/manual) or an invoice
-- itself places a hold.
--
-- Existing quantity_on_hold values were built up under the OLD rule, so
-- every quote that's currently draft/sent/accepted (with no pull sheet)
-- is still counted as "on hold" even though the new code will never release
-- it (nothing in the new code path expects a quote to have held anything).
-- This recalculates quantity_on_hold from scratch, from what's actually
-- live right now under the NEW rule, so it matches going forward.
UPDATE catalog_items ci
SET quantity_on_hold = COALESCE((
  SELECT ROUND(SUM(qty))::integer
  FROM (
    -- Invoices still hold their own line items while draft/sent.
    SELECT ili.quantity AS qty
    FROM invoice_line_items ili
    JOIN invoices i ON i.id = ili.invoice_id
    WHERE i.status IN ('draft', 'sent') AND ili.catalog_item_id = ci.id
    UNION ALL
    -- Pull sheets hold their own items, but only when built from a quote or
    -- standalone/manual -- one built from an invoice doesn't hold anything
    -- extra (the invoice's own hold above already covers it).
    SELECT psi.quantity AS qty
    FROM pull_sheet_items psi
    JOIN pull_sheets ps ON ps.id = psi.pull_sheet_id
    WHERE ps.status != 'fulfilled' AND ps.source_type IN ('quote', 'manual') AND psi.catalog_item_id = ci.id
  ) sub
), 0)
WHERE ci.track_inventory = true;
