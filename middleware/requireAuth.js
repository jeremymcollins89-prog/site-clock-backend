const { verifyToken } = require("../utils/auth");
const db = require("../db");

// Reads "Authorization: Bearer <token>", verifies it, and attaches
// req.employee = { employee_id, name }. Every time-clock route the
// employee's own app calls should sit behind this — never trust an
// employee_id passed in the request body, since anyone could edit it.
//
// A valid signature only proves the token was once issued -- employee
// tokens last 180 days, so this also re-checks employees.active on every
// request. Without that, deactivating someone (fired, quit, etc.) wouldn't
// actually take effect until their token happened to expire on its own.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: "Missing token" });
  }
  try {
    const payload = verifyToken(token);
    const result = await db.query(`SELECT active, company_id FROM employees WHERE id = $1`, [payload.employee_id]);
    if (result.rowCount === 0 || !result.rows[0].active) {
      return res.status(401).json({ error: "This account is no longer active" });
    }
    req.employee = payload;
    // Best-effort, throttled (once/hour) activity ping for the platform
    // dashboard's dormant-days figure -- not awaited so a slow write here
    // never adds latency to the actual request, and failing silently is fine
    // since nothing user-facing depends on it.
    db.query(
      `UPDATE companies SET last_active_at = now()
       WHERE id = $1 AND (last_active_at IS NULL OR last_active_at < now() - INTERVAL '1 hour')`,
      [result.rows[0].company_id]
    ).catch(() => {});
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

module.exports = requireAuth;
