// test/inventory.test.js
//
// Run with: node --test test/
//
// Covers utils/inventory.js's hold/release/consume functions -- specifically
// the two real bugs found and fixed in this file:
//   1. A line item's quantity comes back from Postgres as a NUMERIC string
//      (e.g. "25.00"), but catalog_items.quantity_on_hold/quantity_on_hand
//      are whole-unit INTEGER columns. Passing the raw string straight into
//      an integer arithmetic UPDATE ("invalid input syntax for type
//      integer") used to crash the whole request. Fixed by rounding to a
//      whole number first.
//   2. Any line item missing a catalog_item_id (freeform, not picked from
//      the catalog) or whose quantity rounds to 0 must be silently skipped,
//      not sent to the database at all -- there's nothing to hold/release.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { installMockDb } = require("./support/mockDb");
const {
  placeHoldsForLineItems,
  releaseHoldsForLineItems,
  consumeInventoryForLineItems,
  consumeRemainingAfterPulls,
} = require("../utils/inventory");

test("placeHoldsForLineItems rounds a decimal-string quantity to a whole number", async () => {
  const mock = installMockDb();
  try {
    await placeHoldsForLineItems(
      [{ catalog_item_id: "item-1", quantity: "25.00" }],
      "company-1"
    );
    // 2 calls: the hold UPDATE itself, then checkLowStock's own SELECT
    // (which no-ops here since the mock has no low_stock_threshold row queued).
    assert.equal(mock.calls.length, 2);
    assert.match(mock.calls[0].text, /UPDATE catalog_items/);
    assert.match(mock.calls[0].text, /quantity_on_hold = quantity_on_hold \+ \$1/);
    // The bug: this used to be the raw string "25.00", which Postgres
    // rejects when the target column is INTEGER.
    assert.equal(mock.calls[0].params[0], 25);
    assert.equal(typeof mock.calls[0].params[0], "number");
  } finally {
    mock.restore();
  }
});

test("placeHoldsForLineItems skips a line item with no catalog_item_id", async () => {
  const mock = installMockDb();
  try {
    await placeHoldsForLineItems(
      [{ catalog_item_id: null, quantity: "5.00" }],
      "company-1"
    );
    assert.equal(mock.calls.length, 0, "freeform line items should never touch the database");
  } finally {
    mock.restore();
  }
});

test("placeHoldsForLineItems skips a line item whose quantity rounds to 0", async () => {
  const mock = installMockDb();
  try {
    await placeHoldsForLineItems(
      [{ catalog_item_id: "item-1", quantity: "0.40" }],
      "company-1"
    );
    assert.equal(mock.calls.length, 0, "a quantity that rounds to 0 should reserve nothing");
  } finally {
    mock.restore();
  }
});

test("placeHoldsForLineItems rounds a fractional quantity to the nearest whole unit", async () => {
  const mock = installMockDb();
  try {
    await placeHoldsForLineItems(
      [{ catalog_item_id: "item-1", quantity: "2.6" }],
      "company-1"
    );
    assert.equal(mock.calls[0].params[0], 3);
  } finally {
    mock.restore();
  }
});

test("releaseHoldsForLineItems also rounds before releasing", async () => {
  const mock = installMockDb();
  try {
    await releaseHoldsForLineItems(
      [{ catalog_item_id: "item-1", quantity: "10.00" }],
      "company-1"
    );
    assert.match(mock.calls[0].text, /quantity_on_hold = GREATEST\(0, quantity_on_hold - \$1\)/);
    assert.equal(mock.calls[0].params[0], 10);
  } finally {
    mock.restore();
  }
});

test("consumeInventoryForLineItems rounds before consuming both on-hand and on-hold", async () => {
  const mock = installMockDb();
  try {
    await consumeInventoryForLineItems(
      [{ catalog_item_id: "item-1", quantity: "3.00" }],
      "company-1"
    );
    assert.match(mock.calls[0].text, /quantity_on_hand = GREATEST/);
    assert.match(mock.calls[0].text, /quantity_on_hold = GREATEST/);
    assert.equal(mock.calls[0].params[0], 3);
  } finally {
    mock.restore();
  }
});

test("consumeRemainingAfterPulls subtracts what a fulfilled pull sheet already took", async () => {
  const mock = installMockDb();
  try {
    // getPulledQuantities' query (first call) reports 4 already pulled.
    mock.queueRows([{ catalog_item_id: "item-1", total: "4" }]);
    // consumeInventoryForLineItems' query (second call) -- just needs to exist.
    await consumeRemainingAfterPulls(
      [{ catalog_item_id: "item-1", quantity: "10" }],
      "invoice",
      "invoice-1",
      "company-1"
    );
    // 3 calls: getPulledQuantities' SELECT, the consume UPDATE, then
    // checkLowStock's own SELECT (no-ops here).
    assert.equal(mock.calls.length, 3);
    // 10 requested - 4 already pulled = 6 left to consume now.
    assert.equal(mock.calls[1].params[0], 6);
  } finally {
    mock.restore();
  }
});

test("consumeRemainingAfterPulls consumes nothing once a pull sheet already took it all", async () => {
  const mock = installMockDb();
  try {
    mock.queueRows([{ catalog_item_id: "item-1", total: "10" }]);
    await consumeRemainingAfterPulls(
      [{ catalog_item_id: "item-1", quantity: "10" }],
      "invoice",
      "invoice-1",
      "company-1"
    );
    assert.equal(mock.calls.length, 1, "nothing left to consume, so no second UPDATE should fire");
  } finally {
    mock.restore();
  }
});
