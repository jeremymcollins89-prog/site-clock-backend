// utils/autoClockinSuppression.js
//
// Single source of truth for the "don't auto clock-in right after a manual
// clock-out" flag (employees.auto_clockin_suppressed). Used by
// routes/timeEntries.js's clock-in, clock-out, and
// clear-auto-clockin-suppression routes. Pulled out into its own module
// (rather than inline db.query calls in the route handlers) so it can be
// unit tested directly, the same pattern as utils/lineItems.js and
// utils/inventory.js.
const db = require("../db");

// How long a manual-clock-out suppression is honored for before it's treated
// as stale and ignored, even if the boolean itself never got cleared. Exists
// specifically so a dropped/delayed "employee left the shop radius" signal
// (the normal way this flag clears -- see clearAutoClockinSuppressed below)
// can't block auto clock-in indefinitely. See
// schema-auto-clockin-suppression-expiry.sql for the real incident this
// was added for.
const SUPPRESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours

async function setAutoClockinSuppressed(employeeId) {
  await db.query(
    `UPDATE employees SET auto_clockin_suppressed = true, auto_clockin_suppressed_at = now() WHERE id = $1`,
    [employeeId]
  );
}

async function clearAutoClockinSuppressed(employeeId) {
  await db.query(`UPDATE employees SET auto_clockin_suppressed = false WHERE id = $1`, [employeeId]);
}

// Given a row (or partial object) with `auto_clockin_suppressed` and
// `auto_clockin_suppressed_at` columns, returns whether the suppression
// should actually be honored right now -- true only if the flag is set AND
// it was set recently enough to still be trusted. Callers (routes/auth.js's
// login and /me responses) should report this instead of the raw boolean.
function isSuppressionEffective(row) {
  if (!row || !row.auto_clockin_suppressed) return false;
  if (!row.auto_clockin_suppressed_at) return true; // no timestamp on file (pre-migration row) -- fail open to the old behavior
  const setAt = new Date(row.auto_clockin_suppressed_at).getTime();
  if (Number.isNaN(setAt)) return true;
  return Date.now() - setAt < SUPPRESSION_MAX_AGE_MS;
}

module.exports = { setAutoClockinSuppressed, clearAutoClockinSuppressed, isSuppressionEffective };
