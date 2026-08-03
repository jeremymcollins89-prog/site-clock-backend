const db = require("../db");
const { sendPushToAdmin } = require("./webPush");

// Inventory holds/consumption, hung off the existing catalog_items table
// (see schema-inventory.sql). Only items with track_inventory = true are
// ever touched -- everything here is a no-op for line items that don't
// reference a catalog_item_id, or reference one that isn't being tracked.
//
// Model: quantity_on_hold is a running reservation counter. A quote on its
// own never holds anything -- it's just a proposal. The reservation gets
// placed the moment either (a) a pull sheet is built for the job (from a
// quote, from an invoice, or a standalone/manual sheet), or (b) a quote
// converts to an invoice with no pull sheet already covering it. Whichever
// of those happens first is "the" hold for that job; the other doesn't
// double it (see the callers in routes/admin.js -- convert-to-invoice only
// places a hold if no pull sheet already exists, and building a pull sheet
// from an already-holding invoice doesn't place a second one). It comes back
// down when that pull sheet/invoice is deleted, declined, voided, or
// cancelled (the reservation falls through), or when the pull sheet is
// fulfilled / the invoice is paid (the reservation is fulfilled and the
// stock is actually gone). "Available" for display is always
// quantity_on_hand - quantity_on_hold, computed at read time.

// Call after inserting a quote/invoice's line items. `lineItems` is the
// plain array of { catalog_item_id, quantity, ... } rows already written to
// quote_line_items/invoice_line_items.
async function placeHoldsForLineItems(lineItems, companyId) {
  for (const item of lineItems || []) {
    // quote_line_items/invoice_line_items.quantity is NUMERIC(10,2) (a line
    // item can bill a fractional amount, e.g. 2.5 hours), but
    // catalog_items.quantity_on_hold/quantity_on_hand are whole-unit INTEGER
    // columns -- you can't physically hold half a widget. Round to the
    // nearest whole unit before touching stock; a value that rounds to 0
    // (e.g. a 0.4-quantity line) reserves nothing.
    const qty = Math.round(Number(item.quantity));
    if (!item.catalog_item_id || !qty) continue;
    await db.query(
      `UPDATE catalog_items SET quantity_on_hold = quantity_on_hold + $1
       WHERE id = $2 AND company_id = $3 AND track_inventory = true`,
      [qty, item.catalog_item_id, companyId]
    );
    await checkLowStock(item.catalog_item_id, companyId);
  }
}

// Call when a quote/invoice that had holds is deleted, declined, or voided --
// releases the reservation back to available stock. Floored at 0 so a
// double-release (e.g. a bug, or manual data cleanup) can't push a hold
// negative.
async function releaseHoldsForLineItems(lineItems, companyId) {
  for (const item of lineItems || []) {
    const qty = Math.round(Number(item.quantity));
    if (!item.catalog_item_id || !qty) continue;
    await db.query(
      `UPDATE catalog_items SET quantity_on_hold = GREATEST(0, quantity_on_hold - $1)
       WHERE id = $2 AND company_id = $3 AND track_inventory = true`,
      [qty, item.catalog_item_id, companyId]
    );
    await checkLowStock(item.catalog_item_id, companyId);
  }
}

// Call once an invoice is marked paid (either the manual mark-paid route or
// the Stripe webhook path) -- permanently removes the reserved stock: both
// the on-hand total and the hold drop by the same quantity, since the goods
// are now gone for good rather than just reserved.
async function consumeInventoryForLineItems(lineItems, companyId) {
  for (const item of lineItems || []) {
    const qty = Math.round(Number(item.quantity));
    if (!item.catalog_item_id || !qty) continue;
    await db.query(
      `UPDATE catalog_items
       SET quantity_on_hand = GREATEST(0, quantity_on_hand - $1),
           quantity_on_hold = GREATEST(0, quantity_on_hold - $1)
       WHERE id = $2 AND company_id = $3 AND track_inventory = true`,
      [qty, item.catalog_item_id, companyId]
    );
    await checkLowStock(item.catalog_item_id, companyId);
  }
}

// Fires the low-stock push once available (on_hand - on_hold) drops to or
// below the item's own low_stock_threshold, and resets the sent-flag once
// it's back above threshold (e.g. after a restock) so a future dip can
// alert again. low_stock_alert_sent keeps this from re-firing on every
// single hold placed while already below threshold.
async function checkLowStock(catalogItemId, companyId) {
  const result = await db.query(
    `SELECT id, name, quantity_on_hand, quantity_on_hold, low_stock_threshold, low_stock_alert_sent
     FROM catalog_items WHERE id = $1 AND company_id = $2`,
    [catalogItemId, companyId]
  );
  const item = result.rows[0];
  if (!item || item.low_stock_threshold == null) return;

  const available = item.quantity_on_hand - item.quantity_on_hold;

  if (available <= item.low_stock_threshold && !item.low_stock_alert_sent) {
    try {
      await sendPushToAdmin(companyId, {
        title: "Low inventory alert",
        body: `${item.name} is down to ${available} available (alert set at ${item.low_stock_threshold}).`,
        url: "/admin.html?view=inventory",
      });
    } catch (err) {
      console.error(`Failed to send low-stock alert for catalog item ${catalogItemId}:`, err.message);
    }
    await db.query(`UPDATE catalog_items SET low_stock_alert_sent = true WHERE id = $1`, [catalogItemId]);
  } else if (available > item.low_stock_threshold && item.low_stock_alert_sent) {
    await db.query(`UPDATE catalog_items SET low_stock_alert_sent = false WHERE id = $1`, [catalogItemId]);
  }
}

// How much of each catalog item has already been physically removed via a
// *fulfilled* pull sheet built from this specific quote/invoice. Used so a
// job's stock never gets consumed twice -- once when a pull sheet is
// fulfilled, and again when the invoice is later marked paid. Sums whatever
// an employee actually reported pulling (quantity_pulled) when they
// reported it, falling back to the originally requested quantity for any
// item nobody reported on -- this has to match what fulfilling the sheet
// actually consumed (see PATCH /api/admin/pull-sheets/:id/fulfill), or a
// partial pull would throw off every later "how much is left to pull/pay
// for" calculation.
async function getPulledQuantities(sourceType, sourceId, companyId) {
  const result = await db.query(
    `SELECT psi.catalog_item_id, SUM(COALESCE(psi.quantity_pulled, psi.quantity)) AS total
     FROM pull_sheet_items psi
     JOIN pull_sheets ps ON ps.id = psi.pull_sheet_id
     WHERE ps.source_type = $1 AND ps.source_id = $2 AND ps.company_id = $3 AND ps.status = 'fulfilled'
     GROUP BY psi.catalog_item_id`,
    [sourceType, sourceId, companyId]
  );
  const map = new Map();
  result.rows.forEach((r) => {
    if (r.catalog_item_id) map.set(r.catalog_item_id, Number(r.total));
  });
  return map;
}

// Consumes only what a fulfilled pull sheet hasn't already taken care of.
// Called instead of consumeInventoryForLineItems directly whenever an
// invoice is marked paid (manual route and Stripe webhook both funnel
// through here), so a job that had some or all of its material pulled ahead
// of payment doesn't get double-subtracted from stock.
async function consumeRemainingAfterPulls(lineItems, sourceType, sourceId, companyId) {
  const pulled = await getPulledQuantities(sourceType, sourceId, companyId);
  const remaining = (lineItems || [])
    .map((item) => ({
      catalog_item_id: item.catalog_item_id,
      quantity: Math.max(0, Number(item.quantity) - (pulled.get(item.catalog_item_id) || 0)),
    }))
    .filter((item) => item.catalog_item_id && item.quantity > 0);
  await consumeInventoryForLineItems(remaining, companyId);
}

// Recomputes quantity_on_hold for every tracked catalog item from scratch,
// based on what's actually still open right now, rather than trusting the
// running counter -- a one-time hard reset for any item whose counter
// drifted from reality (e.g. stuck at a positive number from earlier testing
// or from a bug that's since been fixed, with nothing real left to release
// it). Matches the exact same "what actually holds this item" rules as
// GET /api/admin/catalog-items/:id/holds:
//   - Invoices: 'draft' or 'sent' only ('paid' already consumed the hold,
//     'void' already released it).
//   - Pull sheets: not yet 'fulfilled', and only ones built from a quote or
//     standalone/manual (one built from an invoice doesn't hold anything of
//     its own -- the invoice's own hold already covers it, so counting it
//     too would double-count). A quote on its own is never counted here --
//     see the model comment at the top of this file.
// Safe to run any number of times; it's a SET, not an increment. Runs once
// automatically at server startup (see server.js) so a stuck counter
// self-heals on the next deploy without needing direct database access.
async function recalculateInventoryHolds() {
  const result = await db.query(`
    UPDATE catalog_items ci
    SET quantity_on_hold = COALESCE((
      SELECT ROUND(SUM(qty))::integer
      FROM (
        SELECT ili.quantity AS qty
        FROM invoice_line_items ili
        JOIN invoices i ON i.id = ili.invoice_id
        WHERE i.status IN ('draft', 'sent') AND ili.catalog_item_id = ci.id

        UNION ALL

        SELECT psi.quantity AS qty
        FROM pull_sheet_items psi
        JOIN pull_sheets ps ON ps.id = psi.pull_sheet_id
        WHERE ps.status != 'fulfilled' AND ps.source_type IN ('quote', 'manual') AND psi.catalog_item_id = ci.id
      ) sub
    ), 0)
    WHERE ci.track_inventory = true
      AND ci.quantity_on_hold IS DISTINCT FROM COALESCE((
        SELECT ROUND(SUM(qty))::integer
        FROM (
          SELECT ili.quantity AS qty
          FROM invoice_line_items ili
          JOIN invoices i ON i.id = ili.invoice_id
          WHERE i.status IN ('draft', 'sent') AND ili.catalog_item_id = ci.id

          UNION ALL

          SELECT psi.quantity AS qty
          FROM pull_sheet_items psi
          JOIN pull_sheets ps ON ps.id = psi.pull_sheet_id
          WHERE ps.status != 'fulfilled' AND ps.source_type IN ('quote', 'manual') AND psi.catalog_item_id = ci.id
        ) sub
      ), 0)
    RETURNING ci.id, ci.name, ci.quantity_on_hold
  `);
  return result.rows;
}

module.exports = {
  placeHoldsForLineItems,
  releaseHoldsForLineItems,
  consumeInventoryForLineItems,
  checkLowStock,
  getPulledQuantities,
  consumeRemainingAfterPulls,
  recalculateInventoryHolds,
};
