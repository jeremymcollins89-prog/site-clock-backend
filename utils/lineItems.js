// utils/lineItems.js
//
// Shared "fetch this invoice/quote's line items for editing" queries.
//
// These exist because of a real bug: GET /invoices/:id, GET /quotes/:id, and
// the "no line_items in the PATCH body" fallback for both routes each had
// their own hand-written copy of this SELECT, and one of them (the GET
// routes) was missing catalog_item_id. Since converting a quote to an
// invoice auto-opens the new invoice for review, loading that screen wiped
// the link between each line item and the catalog item it was picked from --
// and saving from there (or any edit that didn't resubmit line_items)
// re-wrote the line items with that link gone, silently releasing the
// inventory hold with no way to place it again.
//
// The fix isn't just adding the missing column back in four places -- it's
// making sure there's only one place to get this wrong. Anything that needs
// an invoice's or quote's line items *for editing/resaving purposes*
// (as opposed to a read-only PDF/email render, which only needs description/
// quantity/unit_price and doesn't care about the catalog link) should call
// one of these two functions instead of writing the SELECT inline again.
const db = require("../db");

// Full column set needed to both display an invoice's line items in the edit
// screen AND, if resubmitted unchanged, resave them without losing their
// catalog_item_id link (and therefore without silently dropping an
// inventory hold).
async function getInvoiceLineItemsForEdit(invoiceId) {
  const result = await db.query(
    `SELECT id, description, quantity, unit_price, catalog_item_id, (quantity * unit_price) AS amount
     FROM invoice_line_items WHERE invoice_id = $1 ORDER BY sort_order`,
    [invoiceId]
  );
  return result.rows;
}

// Same idea, for quotes.
async function getQuoteLineItemsForEdit(quoteId) {
  const result = await db.query(
    `SELECT id, description, quantity, unit_price, catalog_item_id, (quantity * unit_price) AS amount
     FROM quote_line_items WHERE quote_id = $1 ORDER BY sort_order`,
    [quoteId]
  );
  return result.rows;
}

module.exports = {
  getInvoiceLineItemsForEdit,
  getQuoteLineItemsForEdit,
};
