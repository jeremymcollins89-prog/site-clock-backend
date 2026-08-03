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
    const updateResult = await db.query(
      `UPDATE catalog_items SET quantity_on_hold = quantity_on_hold + $1
       WHERE id = $2 AND company_id = $3 AND track_inventory = true`,
      [qty, item.catalog_item_id, companyId]
    );
    // TEMPORARY DIAGNOSTIC (2026-08-02): a hold is being reported as silently
    // not applied even though the item looks correctly configured in the UI.
    // If the UPDATE above matches 0 rows, find out why (wrong company_id,
    // track_inventory actually false, or the row doesn't exist at all) and
    // surface it as a real error instead of silently doing nothing, so the
    // cause shows up in the "Convert to invoice" error banner. Safe to
    // remove once the real cause is found.
    if (updateResult.rowCount === 0) {
      const diag = await db.query(
        `SELECT company_id, track_inventory FROM catalog_items WHERE id = $1`,
        [item.catalog_item_id]
      );
      const row = diag.rows[0];
      if (!row) {
        throw new Error(`DIAGNOSTIC: catalog item ${item.catalog_item_id} does not exist at all.`);
      } else if (String(row.company_id) !== String(companyId)) {
        throw new Error(`DIAGNOSTIC: catalog item ${item.catalog_item_id} belongs to company ${row.company_id}, not ${companyId}.`);
      } else if (row.track_inventory !== true) {
        throw new Error(`DIAGNOSTIC: catalog item ${item.catalog_item_id} has track_inventory=${row.track_inventory}, not true.`);
      } else {
        throw new Error(`DIAGNOSTIC: catalog item ${item.catalog_item_id} looked correct (company matched, track_inventory=true) but the UPDATE still matched 0 rows -- unknown cause.`);
      }
    }
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

module.exports = {
  placeHoldsForLineItems,
  releaseHoldsForLineItems,
  consumeInventoryForLineItems,
  checkLowStock,
  getPulledQuantities,
  consumeRemainingAfterPulls,
};
