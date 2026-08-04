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

async function setAutoClockinSuppressed(employeeId) {
  await db.query(`UPDATE employees SET auto_clockin_suppressed = true WHERE id = $1`, [employeeId]);
}

async function clearAutoClockinSuppressed(employeeId) {
  await db.query(`UPDATE employees SET auto_clockin_suppressed = false WHERE id = $1`, [employeeId]);
}

module.exports = { setAutoClockinSuppressed, clearAutoClockinSuppressed };
