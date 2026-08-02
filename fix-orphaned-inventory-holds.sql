-- One-time cleanup: recalculates quantity_on_hold for every tracked catalog
-- item from scratch, based on what's actually still open right now (draft/
-- sent invoices, and draft/sent/accepted-but-not-yet-converted quotes).
-- Fixes any item whose running hold counter drifted from reality -- e.g. a
-- quote/invoice that was voided or declined before the release-holds fix
-- was deployed, which never got its reservation released and has been
-- stuck ever since. Safe to re-run any time.
UPDATE catalog_items ci
SET quantity_on_hold = COALESCE((
  SELECT ROUND(SUM(qty))::integer
  FROM (
    SELECT ili.quantity AS qty
    FROM invoice_line_items ili
    JOIN invoices i ON i.id = ili.invoice_id
    WHERE i.status IN ('draft', 'sent') AND ili.catalog_item_id = ci.id

    UNION ALL

    SELECT qli.quantity AS qty
    FROM quote_line_items qli
    JOIN quotes q ON q.id = qli.quote_id
    WHERE q.status IN ('draft', 'sent', 'accepted') AND q.converted_invoice_id IS NULL AND qli.catalog_item_id = ci.id
  ) sub
), 0)
WHERE ci.track_inventory = true;
