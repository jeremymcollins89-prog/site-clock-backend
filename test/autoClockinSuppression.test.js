// test/autoClockinSuppression.test.js
//
// Run with: node --test test/
//
// Covers utils/autoClockinSuppression.js -- the shared, server-side version
// of the "don't auto clock-in right after a manual clock-out" flag that
// used to live only in the browser's localStorage (frontend/src/geoAutoClock.js).
// Moving it server-side means a future native/background client (which has
// no localStorage of its own) can honor the same rule the web app already
// enforces. These tests just confirm the two functions issue the right SQL
// against the right employee id -- the actual wiring into the clock-in/
// clock-out routes is exercised manually/by the routes themselves, since
// this project's test setup (see support/mockDb.js) mocks db.query rather
// than spinning up a real Express server.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { installMockDb } = require("./support/mockDb");
const { setAutoClockinSuppressed, clearAutoClockinSuppressed } = require("../utils/autoClockinSuppression");

test("setAutoClockinSuppressed sets the flag true for the given employee", async () => {
  const mock = installMockDb();
  try {
    mock.queueRows([]);
    await setAutoClockinSuppressed("emp-1");
    assert.equal(mock.calls.length, 1);
    assert.match(mock.calls[0].text, /UPDATE employees SET auto_clockin_suppressed = true/);
    assert.deepEqual(mock.calls[0].params, ["emp-1"]);
  } finally {
    mock.restore();
  }
});

test("clearAutoClockinSuppressed sets the flag false for the given employee", async () => {
  const mock = installMockDb();
  try {
    mock.queueRows([]);
    await clearAutoClockinSuppressed("emp-2");
    assert.equal(mock.calls.length, 1);
    assert.match(mock.calls[0].text, /UPDATE employees SET auto_clockin_suppressed = false/);
    assert.deepEqual(mock.calls[0].params, ["emp-2"]);
  } finally {
    mock.restore();
  }
});
