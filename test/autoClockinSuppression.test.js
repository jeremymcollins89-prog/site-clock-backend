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
const { setAutoClockinSuppressed, clearAutoClockinSuppressed, isSuppressionEffective } = require("../utils/autoClockinSuppression");

test("setAutoClockinSuppressed sets the flag true and stamps a timestamp for the given employee", async () => {
  const mock = installMockDb();
  try {
    mock.queueRows([]);
    await setAutoClockinSuppressed("emp-1");
    assert.equal(mock.calls.length, 1);
    assert.match(mock.calls[0].text, /UPDATE employees SET auto_clockin_suppressed = true, auto_clockin_suppressed_at = now\(\)/);
    assert.deepEqual(mock.calls[0].params, ["emp-1"]);
  } finally {
    mock.restore();
  }
});

// See schema-auto-clockin-suppression-expiry.sql -- added after a real
// missed auto clock-in where the flag stayed stuck true overnight because
// the geofence-exit event that should have cleared it apparently never
// arrived. isSuppressionEffective() is what lets a stale flag stop
// blocking auto clock-in after enough time has passed regardless.
test("isSuppressionEffective is false when the flag isn't set", () => {
  assert.equal(isSuppressionEffective({ auto_clockin_suppressed: false, auto_clockin_suppressed_at: new Date() }), false);
  assert.equal(isSuppressionEffective(null), false);
});

test("isSuppressionEffective is true when the flag was set recently", () => {
  const recent = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
  assert.equal(isSuppressionEffective({ auto_clockin_suppressed: true, auto_clockin_suppressed_at: recent }), true);
});

test("isSuppressionEffective is false once the flag is more than 12 hours old", () => {
  const stale = new Date(Date.now() - 13 * 60 * 60 * 1000); // 13 hours ago
  assert.equal(isSuppressionEffective({ auto_clockin_suppressed: true, auto_clockin_suppressed_at: stale }), false);
});

test("isSuppressionEffective fails open (true) for a pre-migration row with no timestamp", () => {
  assert.equal(isSuppressionEffective({ auto_clockin_suppressed: true, auto_clockin_suppressed_at: null }), true);
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
