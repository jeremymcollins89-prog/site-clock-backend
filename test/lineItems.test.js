// test/lineItems.test.js
//
// Run with: node --test test/
//
// Regression test for the actual bug behind "converting a quote to an
// invoice doesn't put inventory on hold": GET /invoices/:id and
// GET /quotes/:id (and the PATCH fallback for both, when a save doesn't
// include line_items) each had their own hand-copied SELECT for line items,
// and the copy used to populate the edit screen was missing
// catalog_item_id. Opening an invoice/quote for review -- which the app
// does automatically right after converting a quote -- would silently
// forget which catalog item each line was picked from, and saving from
// there would then re-save the line items with that link gone, releasing
// the inventory hold with no way to place it again.
//
// utils/lineItems.js is now the single place this query lives, used by all
// four call sites. This test asserts the query it runs still asks for
// catalog_item_id -- if someone "simplifies" this file later and drops it
// again, this test fails immediately instead of the bug resurfacing weeks
// later as a silent data loss only visible on a customer's phone.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { installMockDb } = require("./support/mockDb");
const { getInvoiceLineItemsForEdit, getQuoteLineItemsForEdit } = require("../utils/lineItems");

test("getInvoiceLineItemsForEdit's query selects catalog_item_id", async () => {
  const mock = installMockDb();
  try {
    mock.queueRows([
      { id: "li-1", description: "Softwares", quantity: "25.00", unit_price: "100.00", catalog_item_id: "item-1", amount: "2500.00" },
    ]);
    const items = await getInvoiceLineItemsForEdit("invoice-1");

    assert.match(
      mock.calls[0].text,
      /catalog_item_id/,
      "the SELECT itself must ask for catalog_item_id, or the value can never come back no matter what the database has"
    );
    assert.equal(items[0].catalog_item_id, "item-1");
  } finally {
    mock.restore();
  }
});

test("getQuoteLineItemsForEdit's query selects catalog_item_id", async () => {
  const mock = installMockDb();
  try {
    mock.queueRows([
      { id: "qli-1", description: "Softwares", quantity: "25.00", unit_price: "100.00", catalog_item_id: "item-1", amount: "2500.00" },
    ]);
    const items = await getQuoteLineItemsForEdit("quote-1");

    assert.match(mock.calls[0].text, /catalog_item_id/);
    assert.equal(items[0].catalog_item_id, "item-1");
  } finally {
    mock.restore();
  }
});

test("getInvoiceLineItemsForEdit passes the invoice id through as the query parameter", async () => {
  const mock = installMockDb();
  try {
    mock.queueRows([]);
    await getInvoiceLineItemsForEdit("invoice-42");
    assert.deepEqual(mock.calls[0].params, ["invoice-42"]);
  } finally {
    mock.restore();
  }
});
