const { verifyAdminToken } = require("../utils/adminAuth");
const db = require("../db");

// Admin tokens last 180 days, so a valid signature alone doesn't mean this
// company should still have access right now -- e.g. right after the
// platform "delete account" feature removes a company, its old admin token
// should stop working immediately rather than linger until expiry.
async function requireAdmin(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });
  try {
    const payload = verifyAdminToken(token);
    // Also bumps last_active_at (throttled to once/hour) right here instead
    // of a separate query -- this is the "did anyone at this company log in
    // and actually do anything" signal the platform dashboard's dormant-days
    // figure relies on, and every admin request already hits this table once
    // for the existence check anyway.
    const result = await db.query(
      `UPDATE companies SET last_active_at = CASE
         WHEN last_active_at IS NULL OR last_active_at < now() - INTERVAL '1 hour' THEN now()
         ELSE last_active_at
       END
       WHERE id = $1
       RETURNING id`,
      [payload.company_id]
    );
    if (result.rowCount === 0) {
      return res.status(401).json({ error: "This company no longer exists" });
    }
    req.companyId = payload.company_id;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired admin token" });
  }
}

module.exports = requireAdmin;