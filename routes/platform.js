const express = require("express");
const router = express.Router();
const db = require("../db");
const { checkPlatformCredentials, signPlatformToken } = require("../utils/platformAuth");
const requirePlatformAuth = require("../middleware/requirePlatformAuth");

// POST /api/platform/login
// Body: { email, password }
// Not company-scoped at all -- this is Jeremy's own cross-company login,
// checked against PLATFORM_ADMIN_EMAIL / PLATFORM_ADMIN_PASSWORD in Railway
// rather than any row in the database (there's only ever one of these).
router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }
  try {
    const ok = checkPlatformCredentials(email, password);
    if (!ok) return res.status(401).json({ error: "Invalid email or password" });
    res.json({ token: signPlatformToken() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.use(requirePlatformAuth);

// GET /api/platform/companies
// One row per company on the whole platform, with just enough to answer
// "who's using this, and who might need a nudge or a check-in": when they
// signed up, whether they've connected Stripe (so their customers can pay
// online), how many employees they have, whether they're comped
// (billing_exempt), and the last time any employee at that company
// actually clocked in/out -- the simplest reliable definition of "used the
// app" available today, since there's no dedicated admin-login-timestamp
// tracking yet. dormant_days is left as null (never used) or a number of
// days, rather than a boolean, so the page can sort/highlight by however
// stale an account is instead of just a single 30-day cutoff.
router.get("/companies", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT
         c.id,
         c.name,
         c.admin_email,
         c.created_at,
         c.billing_exempt,
         (c.stripe_connect_status = 'connected') AS stripe_connected,
         COALESCE(emp.employee_count, 0) AS employee_count,
         act.last_activity,
         CASE WHEN act.last_activity IS NULL THEN NULL
              ELSE EXTRACT(DAY FROM (now() - act.last_activity))::int
         END AS dormant_days
       FROM companies c
       LEFT JOIN (
         SELECT company_id, COUNT(*) AS employee_count
         FROM employees
         GROUP BY company_id
       ) emp ON emp.company_id = c.id
       LEFT JOIN (
         SELECT e.company_id, MAX(te.clock_in) AS last_activity
         FROM time_entries te
         JOIN employees e ON e.id = te.employee_id
         GROUP BY e.company_id
       ) act ON act.company_id = c.id
       ORDER BY c.name`
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /platform/companies failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load companies." });
  }
});

// PATCH /api/platform/companies/:id
// Body: { billing_exempt }
// Only field this needs to touch right now -- everything else on this page
// is read-only reporting. This replaces the old "run an UPDATE in Railway's
// Query tool" workflow for comping a company.
router.patch("/companies/:id", async (req, res) => {
  const { id } = req.params;
  const { billing_exempt } = req.body;
  if (typeof billing_exempt !== "boolean") {
    return res.status(400).json({ error: "billing_exempt must be true or false" });
  }
  const result = await db.query(
    `UPDATE companies SET billing_exempt = $1 WHERE id = $2 RETURNING id, billing_exempt`,
    [billing_exempt, id]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: "Company not found" });
  res.json(result.rows[0]);
});

// GET /api/platform/overview
// Platform-wide totals across every company -- how much money has actually
// moved through the app (paid invoices), and your own cut of it (the 0.5%
// platform fee from routes/payments.js), plus simple counts that answer
// "how many companies are actually set up to take money" and "how many
// haven't touched the app in a month."
router.get("/overview", async (req, res) => {
  try {
    const countsResult = await db.query(`SELECT COUNT(*) AS total_companies FROM companies`);
    const connectedResult = await db.query(
      `SELECT COUNT(*) AS connected_count FROM companies WHERE stripe_connect_status = 'connected'`
    );
    const revenueResult = await db.query(
      `SELECT COALESCE(SUM(total), 0) AS total_paid,
              COALESCE(SUM(COALESCE(platform_fee, 0)), 0) AS total_platform_fees
       FROM invoices WHERE status = 'paid'`
    );
    const dormantResult = await db.query(
      `SELECT COUNT(*) AS dormant_count FROM (
         SELECT e.company_id, MAX(te.clock_in) AS last_activity
         FROM time_entries te
         JOIN employees e ON e.id = te.employee_id
         GROUP BY e.company_id
         HAVING MAX(te.clock_in) < now() - INTERVAL '30 days'
       ) dormant`
    );

    res.json({
      total_companies: Number(countsResult.rows[0].total_companies),
      stripe_connected_count: Number(connectedResult.rows[0].connected_count),
      total_paid: Number(revenueResult.rows[0].total_paid),
      total_platform_fees: Number(revenueResult.rows[0].total_platform_fees),
      dormant_count: Number(dormantResult.rows[0].dormant_count),
    });
  } catch (err) {
    console.error("GET /platform/overview failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load platform overview." });
  }
});

module.exports = router;
