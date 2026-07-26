const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const db = require("../db");
const { loginAdmin } = require("../utils/adminAuth");
const { hashPin } = require("../utils/auth");
const { generateResetToken, hashResetToken } = require("../utils/resetToken");
const { sendAdminPasswordResetEmail, sendInvoiceEmail, sendQuoteEmail } = require("../utils/mailer");
const { renderInvoicePdf, renderQuotePdf } = require("../utils/invoicePdf");
const requireAdmin = require("../middleware/requireAdmin");
const { getPayPeriod, PAY_FREQUENCIES } = require("../utils/payPeriod");
const { JOB_COLORS } = require("../utils/jobColors");
const { sendPushToEmployee } = require("../utils/webPush");

const EVENT_TYPES = ["job", "personal", "other"];
const QUOTE_STATUSES = ["draft", "sent", "accepted", "declined"];
const PAYMENT_TERMS = ["due_on_receipt", "net_15", "net_30", "net_60", "net_90"];
const PAYMENT_TERMS_DAYS = { due_on_receipt: 0, net_15: 15, net_30: 30, net_60: 60, net_90: 90 };
const PAYMENT_METHODS = ["card", "check", "cash", "other"];

router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }
  try {
    const result = await loginAdmin(email, password);
    res.json(result);
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

// POST /api/admin/forgot-password
// Body: { email }
// Public — no auth required, since the whole point is recovering access.
// Always responds the same way whether or not the email exists, so this
// endpoint can't be used to find out which emails have accounts.
router.post("/forgot-password", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "email is required" });

  const result = await db.query(`SELECT id FROM companies WHERE admin_email = $1`, [email]);
  if (result.rowCount > 0) {
    const { token, tokenHash } = generateResetToken();
    await db.query(
      `UPDATE companies SET reset_token_hash = $1, reset_token_expires = now() + interval '1 hour' WHERE id = $2`,
      [tokenHash, result.rows[0].id]
    );
    try {
      await sendAdminPasswordResetEmail({ to: email, token });
    } catch (err) {
      console.error("Failed to send admin password reset email:", err.message);
    }
  }
  res.json({ message: "If that email has an account, a reset link has been sent." });
});

// POST /api/admin/reset-password
// Body: { token, new_password }
// Public — the token itself (emailed via forgot-password) is the proof of
// identity here.
router.post("/reset-password", async (req, res) => {
  const { token, new_password } = req.body;
  if (!token || !new_password) {
    return res.status(400).json({ error: "token and new_password are required" });
  }
  if (new_password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }

  const tokenHash = hashResetToken(token);
  const result = await db.query(
    `SELECT id FROM companies WHERE reset_token_hash = $1 AND reset_token_expires > now()`,
    [tokenHash]
  );
  if (result.rowCount === 0) {
    return res.status(400).json({ error: "This reset link is invalid or has expired" });
  }

  const password_hash = await bcrypt.hash(new_password, 12);
  await db.query(
    `UPDATE companies SET admin_password_hash = $1, reset_token_hash = NULL, reset_token_expires = NULL WHERE id = $2`,
    [password_hash, result.rows[0].id]
  );
  res.json({ message: "Password updated. You can now log in." });
});

router.use(requireAdmin);

// POST /api/admin/change-password
// Body: { current_password, new_password }
// Authenticated — for an admin who's already logged in and knows their
// current password, but wants to update it.
router.post("/change-password", async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) {
    return res.status(400).json({ error: "current_password and new_password are required" });
  }
  if (new_password.length < 8) {
    return res.status(400).json({ error: "New password must be at least 8 characters" });
  }

  const result = await db.query(`SELECT admin_password_hash FROM companies WHERE id = $1`, [req.companyId]);
  if (result.rowCount === 0) return res.status(404).json({ error: "Company not found" });

  const valid = await bcrypt.compare(current_password, result.rows[0].admin_password_hash);
  if (!valid) return res.status(401).json({ error: "Current password is incorrect" });

  const password_hash = await bcrypt.hash(new_password, 12);
  await db.query(`UPDATE companies SET admin_password_hash = $1 WHERE id = $2`, [password_hash, req.companyId]);
  res.json({ message: "Password updated" });
});

// POST /api/admin/change-email
// Body: { new_email, current_password }
// Authenticated — requires the current password as proof, since the email
// doubles as the admin login username.
router.post("/change-email", async (req, res) => {
  const { new_email, current_password } = req.body;
  if (!new_email || !current_password) {
    return res.status(400).json({ error: "new_email and current_password are required" });
  }

  const result = await db.query(`SELECT admin_password_hash FROM companies WHERE id = $1`, [req.companyId]);
  if (result.rowCount === 0) return res.status(404).json({ error: "Company not found" });

  const valid = await bcrypt.compare(current_password, result.rows[0].admin_password_hash);
  if (!valid) return res.status(401).json({ error: "Current password is incorrect" });

  try {
    await db.query(`UPDATE companies SET admin_email = $1 WHERE id = $2`, [new_email, req.companyId]);
    res.json({ message: "Email updated" });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "Another account already uses that email" });
    }
    throw err;
  }
});

// GET /api/admin/payroll-email
// Returns this company's payroll inbox — where "Submit Hours for Payroll"
// sends timesheet emails. Null until the admin sets it here.
router.get("/payroll-email", async (req, res) => {
  const result = await db.query(`SELECT payroll_email FROM companies WHERE id = $1`, [req.companyId]);
  if (result.rowCount === 0) return res.status(404).json({ error: "Company not found" });
  res.json(result.rows[0]);
});

// PATCH /api/admin/payroll-email
// Body: { payroll_email }
router.patch("/payroll-email", async (req, res) => {
  const { payroll_email } = req.body;
  if (!payroll_email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payroll_email)) {
    return res.status(400).json({ error: "A valid payroll_email is required" });
  }
  const result = await db.query(
    `UPDATE companies SET payroll_email = $1 WHERE id = $2 RETURNING payroll_email`,
    [payroll_email, req.companyId]
  );
  res.json(result.rows[0]);
});

// GET /api/admin/company-name
// The business name shown on invoice/quote PDFs, in the "From" display name
// of customer-facing emails (see utils/mailer.js's customerFacingFrom), and
// in push notification titles -- basically anywhere the app is representing
// this specific company rather than Coll Timeclock itself.
router.get("/company-name", async (req, res) => {
  const result = await db.query(`SELECT name FROM companies WHERE id = $1`, [req.companyId]);
  if (result.rowCount === 0) return res.status(404).json({ error: "Company not found" });
  res.json(result.rows[0]);
});

// PATCH /api/admin/company-name
// Body: { name }
router.patch("/company-name", async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "A company name is required" });
  const result = await db.query(
    `UPDATE companies SET name = $1 WHERE id = $2 RETURNING name`,
    [name.trim(), req.companyId]
  );
  res.json(result.rows[0]);
});

// GET /api/admin/shop-location
// Returns this company's shop coordinates and auto clock-out cutoff time,
// used by the employee app for geo-based auto clock-in/out. shop_lat/shop_lng
// are null until the admin sets them here; auto_clockout_time defaults to
// 4:30pm until changed.
router.get("/shop-location", async (req, res) => {
  const result = await db.query(
    `SELECT shop_lat, shop_lng, shop_radius_m, auto_clockout_time FROM companies WHERE id = $1`,
    [req.companyId]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: "Company not found" });
  res.json(result.rows[0]);
});

// PATCH /api/admin/shop-location
// Body: { shop_lat, shop_lng, shop_radius_m, auto_clockout_time }
// auto_clockout_time is optional and expected as "HH:MM" (24-hour).
router.patch("/shop-location", async (req, res) => {
  const { shop_lat, shop_lng, shop_radius_m, auto_clockout_time } = req.body;
  if (shop_lat == null || shop_lng == null) {
    return res.status(400).json({ error: "shop_lat and shop_lng are required" });
  }
  const lat = Number(shop_lat);
  const lng = Number(shop_lng);
  const radius = shop_radius_m != null ? Number(shop_radius_m) : 152;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(radius)) {
    return res.status(400).json({ error: "shop_lat, shop_lng, and shop_radius_m must be numbers" });
  }
  if (auto_clockout_time != null && !/^\d{1,2}:\d{2}(:\d{2})?$/.test(auto_clockout_time)) {
    return res.status(400).json({ error: "auto_clockout_time must be in HH:MM format" });
  }

  const fields = ["shop_lat = $1", "shop_lng = $2", "shop_radius_m = $3"];
  const values = [lat, lng, radius];
  if (auto_clockout_time) {
    values.push(auto_clockout_time);
    fields.push(`auto_clockout_time = $${values.length}`);
  }
  values.push(req.companyId);

  const result = await db.query(
    `UPDATE companies SET ${fields.join(", ")} WHERE id = $${values.length}
     RETURNING shop_lat, shop_lng, shop_radius_m, auto_clockout_time`,
    values
  );
  res.json(result.rows[0]);
});

// GET /api/admin/timezone
// The IANA timezone this company is located in (e.g. "America/Denver").
// Used to decide what local hour it is for this company when deciding when
// to send automated emails -- right now, invoice reminders.
router.get("/timezone", async (req, res) => {
  const result = await db.query(`SELECT timezone FROM companies WHERE id = $1`, [req.companyId]);
  if (result.rowCount === 0) return res.status(404).json({ error: "Company not found" });
  res.json(result.rows[0]);
});

// PATCH /api/admin/timezone
// Body: { timezone } -- must be a real IANA zone name; validated by asking
// Intl to actually format a date with it rather than checking against a
// hardcoded list, so every zone the browser/Node itself supports is valid.
router.patch("/timezone", async (req, res) => {
  const { timezone } = req.body;
  if (!timezone) return res.status(400).json({ error: "timezone is required" });
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch (err) {
    return res.status(400).json({ error: "That doesn't look like a valid timezone." });
  }
  const result = await db.query(
    `UPDATE companies SET timezone = $1 WHERE id = $2 RETURNING timezone`,
    [timezone, req.companyId]
  );
  res.json(result.rows[0]);
});

// GET /api/admin/pay-schedule
// Returns this company's pay frequency and (if applicable) the anchor date
// and custom period length used to calculate pay periods.
router.get("/pay-schedule", async (req, res) => {
  const result = await db.query(
    `SELECT pay_frequency, pay_period_anchor, pay_period_custom_days FROM companies WHERE id = $1`,
    [req.companyId]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: "Company not found" });
  res.json(result.rows[0]);
});

// PATCH /api/admin/pay-schedule
// Body: { pay_frequency, pay_period_anchor, pay_period_custom_days }
// pay_period_anchor (a "YYYY-MM-DD" date) is required for biweekly, weekly,
// and custom -- it's the start date of any one known pay period, used to
// calculate every period going forward and backward from it.
// pay_period_custom_days is required (and must be a positive integer) only
// when pay_frequency is "custom".
router.patch("/pay-schedule", async (req, res) => {
  const { pay_frequency, pay_period_anchor, pay_period_custom_days } = req.body;

  if (!PAY_FREQUENCIES.includes(pay_frequency)) {
    return res.status(400).json({
      error: `pay_frequency must be one of: ${PAY_FREQUENCIES.join(", ")}`,
    });
  }

  const needsAnchor = ["biweekly", "weekly", "custom"].includes(pay_frequency);
  if (needsAnchor && !pay_period_anchor) {
    return res.status(400).json({
      error: "pay_period_anchor (the start date of a known pay period) is required for this frequency",
    });
  }

  let customDays = null;
  if (pay_frequency === "custom") {
    customDays = Number(pay_period_custom_days);
    if (!Number.isInteger(customDays) || customDays < 1) {
      return res.status(400).json({ error: "pay_period_custom_days must be a positive whole number" });
    }
  }

  const result = await db.query(
    `UPDATE companies
     SET pay_frequency = $1, pay_period_anchor = $2, pay_period_custom_days = $3
     WHERE id = $4
     RETURNING pay_frequency, pay_period_anchor, pay_period_custom_days`,
    [pay_frequency, needsAnchor ? pay_period_anchor : null, customDays, req.companyId]
  );
  res.json(result.rows[0]);
});

const CLOCK_IN_ANIMATIONS = ["none", "fireworks", "birthday"];

router.get("/employees", async (req, res) => {
  const result = await db.query(
    `SELECT id, name, email, active, created_at, clock_in_animation, hourly_rate FROM employees WHERE company_id = $1 ORDER BY name`,
    [req.companyId]
  );
  res.json(result.rows);
});

router.post("/employees", async (req, res) => {
  const { name, email, pin, clock_in_animation, hourly_rate } = req.body;
  if (!name || !email || !pin) {
    return res.status(400).json({ error: "name, email, and pin are required" });
  }
  if (clock_in_animation !== undefined && !CLOCK_IN_ANIMATIONS.includes(clock_in_animation)) {
    return res.status(400).json({ error: "Invalid clock_in_animation" });
  }
  const pin_hash = await hashPin(pin);
  try {
    const result = await db.query(
      `INSERT INTO employees (name, email, pin_hash, company_id, clock_in_animation, hourly_rate) VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, email, active, created_at, clock_in_animation, hourly_rate`,
      [name, email, pin_hash, req.companyId, clock_in_animation || "none", hourly_rate || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "An employee with that email already exists" });
    }
    throw err;
  }
});

router.patch("/employees/:id", async (req, res) => {
  const { id } = req.params;
  const { name, email, active, pin, clock_in_animation, hourly_rate } = req.body;

  if (clock_in_animation !== undefined && !CLOCK_IN_ANIMATIONS.includes(clock_in_animation)) {
    return res.status(400).json({ error: "Invalid clock_in_animation" });
  }
  if (hourly_rate !== undefined && hourly_rate !== null && (isNaN(Number(hourly_rate)) || Number(hourly_rate) < 0)) {
    return res.status(400).json({ error: "hourly_rate must be a non-negative number" });
  }

  const fields = [];
  const values = [];
  if (name !== undefined) { values.push(name); fields.push(`name = $${values.length}`); }
  if (email !== undefined) { values.push(email); fields.push(`email = $${values.length}`); }
  if (active !== undefined) { values.push(active); fields.push(`active = $${values.length}`); }
  if (pin) { values.push(await hashPin(pin)); fields.push(`pin_hash = $${values.length}`); }
  if (clock_in_animation !== undefined) { values.push(clock_in_animation); fields.push(`clock_in_animation = $${values.length}`); }
  if (hourly_rate !== undefined) { values.push(hourly_rate === null || hourly_rate === "" ? null : Number(hourly_rate)); fields.push(`hourly_rate = $${values.length}`); }

  if (fields.length === 0) return res.status(400).json({ error: "Nothing to update" });

  values.push(id, req.companyId);
  try {
    const result = await db.query(
      `UPDATE employees SET ${fields.join(", ")} WHERE id = $${values.length - 1} AND company_id = $${values.length}
       RETURNING id, name, email, active, created_at, clock_in_animation, hourly_rate`,
      values
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "Employee not found" });
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "An employee with that email already exists" });
    }
    throw err;
  }
});

router.get("/time-entries", async (req, res) => {
  const { start, end, employee_id } = req.query;
  const conditions = [`e.company_id = $1`];
  const params = [req.companyId];

  if (start) { params.push(start); conditions.push(`d.clock_in >= $${params.length}`); }
  if (end) { params.push(end); conditions.push(`d.clock_in <= $${params.length}`); }
  if (employee_id) { params.push(employee_id); conditions.push(`d.employee_id = $${params.length}`); }

  const result = await db.query(
    `SELECT d.*, e.name AS employee_name
     FROM time_entry_durations d
     JOIN employees e ON e.id = d.employee_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY d.clock_in DESC`,
    params
  );
  res.json(result.rows);
});

router.patch("/time-entries/:id", async (req, res) => {
  const { id } = req.params;
  const { job_name, location_type, clock_in, clock_out } = req.body;

  const owns = await db.query(
    `SELECT te.id FROM time_entries te JOIN employees e ON e.id = te.employee_id
     WHERE te.id = $1 AND e.company_id = $2`,
    [id, req.companyId]
  );
  if (owns.rowCount === 0) return res.status(404).json({ error: "Time entry not found" });

  const fields = [];
  const values = [];
  if (job_name !== undefined) { values.push(job_name); fields.push(`job_name = $${values.length}`); }
  if (location_type !== undefined) { values.push(location_type); fields.push(`location_type = $${values.length}`); }
  if (clock_in !== undefined) { values.push(clock_in); fields.push(`clock_in = $${values.length}`); }
  if (clock_out !== undefined) { values.push(clock_out); fields.push(`clock_out = $${values.length}`); }

  if (fields.length === 0) return res.status(400).json({ error: "Nothing to update" });

  values.push(id);
  const result = await db.query(
    `UPDATE time_entries SET ${fields.join(", ")} WHERE id = $${values.length} RETURNING *`,
    values
  );
  res.json(result.rows[0]);
});

router.get("/overview", async (req, res) => {
  const companyResult = await db.query(
    `SELECT pay_frequency, pay_period_anchor, pay_period_custom_days FROM companies WHERE id = $1`,
    [req.companyId]
  );
  const period = getPayPeriod(new Date(), companyResult.rows[0] || {});
  const result = await db.query(
    `SELECT
       e.id, e.name, e.active,
       open_te.id AS open_entry_id,
       open_te.job_name AS open_job_name,
       open_te.location_type AS open_location_type,
       open_te.clock_in AS open_clock_in,
       l.lat, l.lng, l.recorded_at AS location_recorded_at,
       COALESCE(SUM(d.worked_seconds) FILTER (WHERE d.location_type = 'in_town'), 0) AS regular_seconds,
       COALESCE(SUM(d.worked_seconds) FILTER (WHERE d.location_type = 'traveling'), 0) AS travel_seconds
     FROM employees e
     LEFT JOIN time_entries open_te ON open_te.employee_id = e.id AND open_te.clock_out IS NULL
     LEFT JOIN employee_locations l ON l.employee_id = e.id
     LEFT JOIN time_entry_durations d ON d.employee_id = e.id
       AND d.clock_in >= $2 AND d.clock_in <= $3
     WHERE e.company_id = $1
     GROUP BY e.id, e.name, e.active, open_te.id, open_te.job_name, open_te.location_type, open_te.clock_in, l.lat, l.lng, l.recorded_at
     ORDER BY e.active DESC, e.name`,
    [req.companyId, period.start, period.end]
  );
  res.json({ period, employees: result.rows });
});

router.post("/employees/:id/request-ping", async (req, res) => {
  const { id } = req.params;
  const owns = await db.query(`SELECT id FROM employees WHERE id = $1 AND company_id = $2`, [id, req.companyId]);
  if (owns.rowCount === 0) return res.status(404).json({ error: "Employee not found" });

  const openShift = await db.query(
    `SELECT id FROM time_entries WHERE employee_id = $1 AND clock_out IS NULL`,
    [id]
  );
  if (openShift.rowCount === 0) {
    return res.status(400).json({ error: "Employee is not currently clocked in" });
  }
  await db.query(
    `INSERT INTO ping_requests (employee_id, requested_at) VALUES ($1, now())
     ON CONFLICT (employee_id) DO UPDATE SET requested_at = now()`,
    [id]
  );
  res.json({ requested: true });
});

// ---------- Crews ----------
// A crew is a reusable, named group of employees an admin can assign to a
// job in one click instead of picking employees individually every time.

// GET /api/admin/customers
// Returns every customer for this company, most recently added first.
router.get("/customers", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, phone, email, street, city, state, zip, notes, created_at
       FROM customers
       WHERE company_id = $1
       ORDER BY name`,
      [req.companyId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /admin/customers failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load customers." });
  }
});

// GET /api/admin/customers/:id/events
// Returns every event (job) linked to this customer, most recent first.
router.get("/customers/:id/events", async (req, res) => {
  try {
    const { id } = req.params;
    const owns = await db.query(`SELECT id FROM customers WHERE id = $1 AND company_id = $2`, [id, req.companyId]);
    if (owns.rowCount === 0) return res.status(404).json({ error: "Customer not found" });

    const result = await db.query(
      `SELECT id, title, notes, start_date, end_date, start_time, color, event_type
       FROM jobs
       WHERE customer_id = $1 AND company_id = $2
       ORDER BY start_date DESC`,
      [id, req.companyId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /admin/customers/:id/events failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load customer events." });
  }
});

// POST /api/admin/customers
// Body: { name, phone?, email?, street?, city?, state?, zip?, notes? }
router.post("/customers", async (req, res) => {
  try {
    const { name, phone, email, street, city, state, zip, notes } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });

    const result = await db.query(
      `INSERT INTO customers (company_id, name, phone, email, street, city, state, zip, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, name, phone, email, street, city, state, zip, notes, created_at`,
      [req.companyId, name, phone || null, email || null, street || null, city || null, state || null, zip || null, notes || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("POST /admin/customers failed:", err);
    res.status(500).json({ error: err.message || "Couldn't create customer." });
  }
});

// POST /api/admin/customers/import
// Body: { customers: [{ name, phone?, email?, street?, city?, state?, zip?, notes? }, ...] }
// Bulk-imports customers from a CSV exported by other software (parsed
// client-side, sent here as plain objects). Rows missing a name are
// skipped, and rows whose name case-insensitively matches an existing
// customer -- or an earlier row in the same file -- are skipped as
// duplicates instead of creating a second record.
router.post("/customers/import", async (req, res) => {
  try {
    const { customers } = req.body;
    if (!Array.isArray(customers) || customers.length === 0) {
      return res.status(400).json({ error: "No customers to import." });
    }
    if (customers.length > 2000) {
      return res.status(400).json({ error: "That's more than 2000 rows at once -- please split the file up." });
    }

    const existing = await db.query(`SELECT name FROM customers WHERE company_id = $1`, [req.companyId]);
    const seenNames = new Set(existing.rows.map((r) => r.name.trim().toLowerCase()));

    let imported = 0;
    const skipped = [];

    for (let i = 0; i < customers.length; i++) {
      const row = customers[i] || {};
      const name = (row.name || "").trim();
      if (!name) {
        skipped.push({ row: i + 1, reason: "missing_name" });
        continue;
      }
      const key = name.toLowerCase();
      if (seenNames.has(key)) {
        skipped.push({ row: i + 1, reason: "duplicate", name });
        continue;
      }
      seenNames.add(key);
      await db.query(
        `INSERT INTO customers (company_id, name, phone, email, street, city, state, zip, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          req.companyId, name,
          (row.phone || "").trim() || null,
          (row.email || "").trim() || null,
          (row.street || "").trim() || null,
          (row.city || "").trim() || null,
          (row.state || "").trim() || null,
          (row.zip || "").trim() || null,
          (row.notes || "").trim() || null,
        ]
      );
      imported++;
    }

    res.status(201).json({ imported, skipped });
  } catch (err) {
    console.error("POST /admin/customers/import failed:", err);
    res.status(500).json({ error: err.message || "Couldn't import customers." });
  }
});

// PATCH /api/admin/customers/:id
// Body: { name?, phone?, email?, street?, city?, state?, zip?, notes? }
router.patch("/customers/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, phone, email, street, city, state, zip, notes } = req.body;

    const owns = await db.query(`SELECT id FROM customers WHERE id = $1 AND company_id = $2`, [id, req.companyId]);
    if (owns.rowCount === 0) return res.status(404).json({ error: "Customer not found" });

    const fields = [];
    const values = [];
    if (name !== undefined) { values.push(name); fields.push(`name = $${values.length}`); }
    if (phone !== undefined) { values.push(phone); fields.push(`phone = $${values.length}`); }
    if (email !== undefined) { values.push(email); fields.push(`email = $${values.length}`); }
    if (street !== undefined) { values.push(street); fields.push(`street = $${values.length}`); }
    if (city !== undefined) { values.push(city); fields.push(`city = $${values.length}`); }
    if (state !== undefined) { values.push(state); fields.push(`state = $${values.length}`); }
    if (zip !== undefined) { values.push(zip); fields.push(`zip = $${values.length}`); }
    if (notes !== undefined) { values.push(notes); fields.push(`notes = $${values.length}`); }

    let customer = owns.rows[0];
    if (fields.length > 0) {
      values.push(id);
      const result = await db.query(
        `UPDATE customers SET ${fields.join(", ")} WHERE id = $${values.length}
         RETURNING id, name, phone, email, street, city, state, zip, notes, created_at`,
        values
      );
      customer = result.rows[0];
    }
    res.json(customer);
  } catch (err) {
    console.error("PATCH /admin/customers/:id failed:", err);
    res.status(500).json({ error: err.message || "Couldn't update customer." });
  }
});

// DELETE /api/admin/customers/:id
// Events linked to this customer are kept -- customer_id is just cleared
// (see schema's ON DELETE SET NULL), so past job history isn't lost.
router.delete("/customers/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(`DELETE FROM customers WHERE id = $1 AND company_id = $2`, [id, req.companyId]);
    if (result.rowCount === 0) return res.status(404).json({ error: "Customer not found" });
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /admin/customers/:id failed:", err);
    res.status(500).json({ error: err.message || "Couldn't delete customer." });
  }
});

// GET /api/admin/crews
// Returns every crew for this company along with its current members.
router.get("/crews", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT c.id, c.name, c.created_at,
              COALESCE(
                json_agg(
                  json_build_object('id', e.id, 'name', e.name)
                  ORDER BY e.name
                ) FILTER (WHERE e.id IS NOT NULL), '[]'
              ) AS members
       FROM crews c
       LEFT JOIN crew_members cm ON cm.crew_id = c.id
       LEFT JOIN employees e ON e.id = cm.employee_id
       WHERE c.company_id = $1
       GROUP BY c.id
       ORDER BY c.name`,
      [req.companyId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /admin/crews failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load crews." });
  }
});

// POST /api/admin/crews
// Body: { name, employee_ids: [] }
router.post("/crews", async (req, res) => {
  try {
    const { name, employee_ids } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });

    const crewResult = await db.query(
      `INSERT INTO crews (company_id, name) VALUES ($1, $2) RETURNING id, name, created_at`,
      [req.companyId, name]
    );
    const crew = crewResult.rows[0];

    const ids = Array.isArray(employee_ids) ? employee_ids.filter(Boolean) : [];
    if (ids.length > 0) {
      await db.query(
        `INSERT INTO crew_members (crew_id, employee_id)
         SELECT $1::uuid, e.id FROM employees e WHERE e.id = ANY($2::uuid[]) AND e.company_id = $3::uuid
         ON CONFLICT DO NOTHING`,
        [crew.id, ids, req.companyId]
      );
    }
    res.status(201).json({ ...crew, members: [] });
  } catch (err) {
    console.error("POST /admin/crews failed:", err);
    res.status(500).json({ error: err.message || "Couldn't create crew." });
  }
});

// PATCH /api/admin/crews/:id
// Body: { name?, employee_ids? } -- employee_ids, if provided, fully
// replaces the crew's membership list.
router.patch("/crews/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, employee_ids } = req.body;

    const owns = await db.query(`SELECT id FROM crews WHERE id = $1 AND company_id = $2`, [id, req.companyId]);
    if (owns.rowCount === 0) return res.status(404).json({ error: "Crew not found" });

    if (name !== undefined) {
      await db.query(`UPDATE crews SET name = $1 WHERE id = $2`, [name, id]);
    }
    if (Array.isArray(employee_ids)) {
      const ids = employee_ids.filter(Boolean);
      await db.query(`DELETE FROM crew_members WHERE crew_id = $1`, [id]);
      if (ids.length > 0) {
        await db.query(
          `INSERT INTO crew_members (crew_id, employee_id)
           SELECT $1::uuid, e.id FROM employees e WHERE e.id = ANY($2::uuid[]) AND e.company_id = $3::uuid
           ON CONFLICT DO NOTHING`,
          [id, ids, req.companyId]
        );
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("PATCH /admin/crews/:id failed:", err);
    res.status(500).json({ error: err.message || "Couldn't update crew." });
  }
});

// DELETE /api/admin/crews/:id
router.delete("/crews/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(`DELETE FROM crews WHERE id = $1 AND company_id = $2`, [id, req.companyId]);
    if (result.rowCount === 0) return res.status(404).json({ error: "Crew not found" });
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /admin/crews/:id failed:", err);
    res.status(500).json({ error: err.message || "Couldn't delete crew." });
  }
});

// ---------- Jobs ----------
// A job is a color-coded task scheduled for one or more days, assigned to
// individual employees and/or whole crews. Assigning sends each newly
// assigned employee a push notification (if they've enabled them).

async function expandAssignments({ employee_ids, crew_ids, companyId }) {
  // Map of employeeId -> assigned_via_crew_id (or null for a direct add).
  // Crew members are added first so a direct add can "win" and be recorded
  // as a direct assignment even if the same person is also in a crew.
  const map = new Map();

  const crewIds = Array.isArray(crew_ids) ? crew_ids.filter(Boolean) : [];
  if (crewIds.length > 0) {
    const members = await db.query(
      `SELECT cm.crew_id, cm.employee_id
       FROM crew_members cm
       JOIN crews c ON c.id = cm.crew_id
       WHERE cm.crew_id = ANY($1::uuid[]) AND c.company_id = $2::uuid`,
      [crewIds, companyId]
    );
    for (const row of members.rows) map.set(row.employee_id, row.crew_id);
  }

  const directIds = Array.isArray(employee_ids) ? employee_ids.filter(Boolean) : [];
  if (directIds.length > 0) {
    const valid = await db.query(
      `SELECT id FROM employees WHERE id = ANY($1::uuid[]) AND company_id = $2::uuid`,
      [directIds, companyId]
    );
    for (const row of valid.rows) map.set(row.id, null);
  }

  return map;
}

function formatTimeForNotification(startTime) {
  if (!startTime) return "";
  const [h, m] = startTime.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return ` at ${hour12}:${String(m).padStart(2, "0")} ${period}`;
}

async function notifyAssigned(employeeIds, job) {
  const dateRange =
    job.start_date === job.end_date
      ? job.start_date
      : `${job.start_date} to ${job.end_date}`;
  const timeLabel = formatTimeForNotification(job.start_time);
  await Promise.all(
    employeeIds.map((employeeId) =>
      sendPushToEmployee(employeeId, {
        title: "New event scheduled",
        body: `${job.title} — ${dateRange}${timeLabel}`,
        url: "/schedule",
      }).catch((err) => console.error("Failed to send job notification:", err.message))
    )
  );
}

// GET /api/admin/jobs?start=YYYY-MM-DD&end=YYYY-MM-DD
// Returns jobs overlapping the given range (both optional -- omit both to
// get every job) along with their assigned employees.
router.get("/jobs", async (req, res) => {
  try {
    const { start, end } = req.query;
    const conditions = [`j.company_id = $1`];
    const params = [req.companyId];

    if (start) { params.push(start); conditions.push(`j.end_date >= $${params.length}`); }
    if (end) { params.push(end); conditions.push(`j.start_date <= $${params.length}`); }

    const result = await db.query(
      `SELECT j.id, j.title, j.notes, j.start_date, j.end_date, j.start_time, j.color, j.event_type, j.created_at,
              j.customer_id, c.name AS customer_name, c.phone AS customer_phone,
              c.street AS customer_street, c.city AS customer_city, c.state AS customer_state, c.zip AS customer_zip,
              COALESCE(
                json_agg(
                  json_build_object('id', e.id, 'name', e.name, 'crew_id', ja.assigned_via_crew_id)
                  ORDER BY e.name
                ) FILTER (WHERE e.id IS NOT NULL), '[]'
              ) AS assigned_employees
       FROM jobs j
       LEFT JOIN job_assignments ja ON ja.job_id = j.id
       LEFT JOIN employees e ON e.id = ja.employee_id
       LEFT JOIN customers c ON c.id = j.customer_id
       WHERE ${conditions.join(" AND ")}
       GROUP BY j.id, c.id
       ORDER BY j.start_date, j.title`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /admin/jobs failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load jobs." });
  }
});

// POST /api/admin/jobs
// Body: { title, notes?, start_date, end_date, color, employee_ids?, crew_ids? }
router.post("/jobs", async (req, res) => {
  try {
    const { title, notes, start_date, end_date, start_time, color, event_type, customer_id, employee_ids, crew_ids } = req.body;
    if (!title || !start_date || !end_date) {
      return res.status(400).json({ error: "title, start_date, and end_date are required" });
    }
    const jobColor = color || "rust";
    if (!JOB_COLORS[jobColor]) {
      return res.status(400).json({ error: `color must be one of: ${Object.keys(JOB_COLORS).join(", ")}` });
    }
    const eventType = event_type || "job";
    if (!EVENT_TYPES.includes(eventType)) {
      return res.status(400).json({ error: `event_type must be one of: ${EVENT_TYPES.join(", ")}` });
    }
    if (start_time && !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(start_time)) {
      return res.status(400).json({ error: "start_time must be in HH:MM format" });
    }
    let customerId = null;
    if (customer_id) {
      const ownsCustomer = await db.query(`SELECT id FROM customers WHERE id = $1 AND company_id = $2`, [customer_id, req.companyId]);
      if (ownsCustomer.rowCount === 0) return res.status(400).json({ error: "customer not found" });
      customerId = customer_id;
    }

    const jobResult = await db.query(
      `INSERT INTO jobs (company_id, title, notes, start_date, end_date, start_time, color, event_type, customer_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, title, notes, start_date, end_date, start_time, color, event_type, customer_id, created_at`,
      [req.companyId, title, notes || null, start_date, end_date, start_time || null, jobColor, eventType, customerId]
    );
    const job = jobResult.rows[0];

    const assignments = await expandAssignments({ employee_ids, crew_ids, companyId: req.companyId });
    if (assignments.size > 0) {
      await Promise.all(
        Array.from(assignments.entries()).map(([employeeId, crewId]) =>
          db.query(
            `INSERT INTO job_assignments (job_id, employee_id, assigned_via_crew_id)
             VALUES ($1, $2, $3)`,
            [job.id, employeeId, crewId]
          )
        )
      );
      notifyAssigned(Array.from(assignments.keys()), job);
    }

    res.status(201).json(job);
  } catch (err) {
    console.error("POST /admin/jobs failed:", err);
    res.status(500).json({ error: err.message || "Couldn't create event." });
  }
});

// PATCH /api/admin/jobs/:id
// Body: { title?, notes?, start_date?, end_date?, color?, employee_ids?, crew_ids? }
// employee_ids/crew_ids, if either is provided, fully replace the job's
// assignment list -- only employees newly added (who weren't already
// assigned) get a push notification, so editing a job doesn't re-notify
// everyone already on it.
router.patch("/jobs/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { title, notes, start_date, end_date, start_time, color, event_type, customer_id, employee_ids, crew_ids } = req.body;

    const owns = await db.query(`SELECT * FROM jobs WHERE id = $1 AND company_id = $2`, [id, req.companyId]);
    if (owns.rowCount === 0) return res.status(404).json({ error: "Event not found" });

    const fields = [];
    const values = [];
    if (title !== undefined) { values.push(title); fields.push(`title = $${values.length}`); }
    if (notes !== undefined) { values.push(notes); fields.push(`notes = $${values.length}`); }
    if (start_date !== undefined) { values.push(start_date); fields.push(`start_date = $${values.length}`); }
    if (end_date !== undefined) { values.push(end_date); fields.push(`end_date = $${values.length}`); }
    if (start_time !== undefined) {
      // null explicitly clears it, meaning "no specific time" -- not "leave unchanged".
      if (start_time && !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(start_time)) {
        return res.status(400).json({ error: "start_time must be in HH:MM format" });
      }
      values.push(start_time || null); fields.push(`start_time = $${values.length}`);
    }
    if (color !== undefined) {
      if (!JOB_COLORS[color]) {
        return res.status(400).json({ error: `color must be one of: ${Object.keys(JOB_COLORS).join(", ")}` });
      }
      values.push(color); fields.push(`color = $${values.length}`);
    }
    if (event_type !== undefined) {
      if (!EVENT_TYPES.includes(event_type)) {
        return res.status(400).json({ error: `event_type must be one of: ${EVENT_TYPES.join(", ")}` });
      }
      values.push(event_type); fields.push(`event_type = $${values.length}`);
    }
    if (customer_id !== undefined) {
      if (customer_id) {
        const ownsCustomer = await db.query(`SELECT id FROM customers WHERE id = $1 AND company_id = $2`, [customer_id, req.companyId]);
        if (ownsCustomer.rowCount === 0) return res.status(400).json({ error: "customer not found" });
      }
      values.push(customer_id || null); fields.push(`customer_id = $${values.length}`);
    }

    let job = owns.rows[0];
    if (fields.length > 0) {
      values.push(id);
      const result = await db.query(
        `UPDATE jobs SET ${fields.join(", ")} WHERE id = $${values.length}
         RETURNING id, title, notes, start_date, end_date, start_time, color, event_type, customer_id, created_at`,
        values
      );
      job = result.rows[0];
    }

    if (employee_ids !== undefined || crew_ids !== undefined) {
      const before = await db.query(`SELECT employee_id, seen_by_employee FROM job_assignments WHERE job_id = $1`, [id]);
      const beforeIds = new Set(before.rows.map((r) => r.employee_id));
      // Employees who were already assigned keep whatever "seen" state they
      // already had (editing the job's title/date shouldn't re-flag it as
      // new for someone who already looked at it) -- only genuinely new
      // assignees start out unseen.
      const beforeSeenMap = new Map(before.rows.map((r) => [r.employee_id, r.seen_by_employee]));

      const assignments = await expandAssignments({ employee_ids, crew_ids, companyId: req.companyId });
      await db.query(`DELETE FROM job_assignments WHERE job_id = $1`, [id]);
      if (assignments.size > 0) {
        await Promise.all(
          Array.from(assignments.entries()).map(([employeeId, crewId]) =>
            db.query(
              `INSERT INTO job_assignments (job_id, employee_id, assigned_via_crew_id, seen_by_employee)
               VALUES ($1, $2, $3, $4)`,
              [id, employeeId, crewId, beforeSeenMap.has(employeeId) ? beforeSeenMap.get(employeeId) : false]
            )
          )
        );
      }
      const newlyAdded = Array.from(assignments.keys()).filter((eid) => !beforeIds.has(eid));
      if (newlyAdded.length > 0) notifyAssigned(newlyAdded, job);
    }

    res.json(job);
  } catch (err) {
    console.error("PATCH /admin/jobs/:id failed:", err);
    res.status(500).json({ error: err.message || "Couldn't update event." });
  }
});

// DELETE /api/admin/jobs/:id
router.delete("/jobs/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(`DELETE FROM jobs WHERE id = $1 AND company_id = $2`, [id, req.companyId]);
    if (result.rowCount === 0) return res.status(404).json({ error: "Job not found" });
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /admin/jobs/:id failed:", err);
    res.status(500).json({ error: err.message || "Couldn't delete event." });
  }
});

// ---------- Invoices ----------
// Invoices bill a customer for completed (or upcoming) work, with line
// items, configurable payment terms (Net 15/30/60/90 or due on receipt),
// and a PDF that gets emailed to the customer. Card/check payments aren't
// processed in-app yet -- "mark as paid" just records how payment came in
// (check, cash, a card run elsewhere, etc.) so the invoice's status stays
// accurate without actually moving any money.

function computeInvoiceTotals(lineItems, taxRate) {
  const subtotal = lineItems.reduce((sum, item) => sum + Number(item.quantity) * Number(item.unit_price), 0);
  const taxAmount = subtotal * (Number(taxRate) / 100);
  const total = subtotal + taxAmount;
  return {
    subtotal: Math.round(subtotal * 100) / 100,
    taxAmount: Math.round(taxAmount * 100) / 100,
    total: Math.round(total * 100) / 100,
  };
}

function computeDueDate(issueDate, paymentTerms) {
  const days = PAYMENT_TERMS_DAYS[paymentTerms] ?? 0;
  const d = new Date(`${issueDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Renders the invoice as a PDF, emails it to the customer (cc'ing this
// company's own admin email as a paper trail), and marks it "sent". Shared
// by the explicit "Send" button and by auto-send-on-save, so both paths
// stay identical. Throws on failure; err.status carries the HTTP status the
// caller should use if it turns the error into a response, err.expected
// marks failures that are a normal part of the flow (no email on file yet,
// invoice voided) rather than a real bug.
async function sendInvoiceNow(invoiceId, companyId) {
  const result = await db.query(
    `SELECT i.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
            c.street AS customer_street, c.city AS customer_city, c.state AS customer_state, c.zip AS customer_zip
     FROM invoices i JOIN customers c ON c.id = i.customer_id
     WHERE i.id = $1 AND i.company_id = $2`,
    [invoiceId, companyId]
  );
  if (result.rowCount === 0) {
    const err = new Error("Invoice not found");
    err.status = 404;
    throw err;
  }
  const invoice = result.rows[0];
  if (invoice.status === "void") {
    const err = new Error("Can't send a voided invoice.");
    err.status = 400;
    err.expected = true;
    throw err;
  }
  if (!invoice.customer_email) {
    const err = new Error("This customer doesn't have an email on file.");
    err.status = 400;
    err.expected = true;
    throw err;
  }

  const itemsResult = await db.query(
    `SELECT description, quantity, unit_price FROM invoice_line_items WHERE invoice_id = $1 ORDER BY sort_order`,
    [invoiceId]
  );
  const companyResult = await db.query(`SELECT name, admin_email, logo_data FROM companies WHERE id = $1`, [companyId]);
  const company = companyResult.rows[0];

  const pdfBuffer = await renderInvoicePdf({
    companyName: company.name,
    invoice,
    customer: {
      name: invoice.customer_name,
      email: invoice.customer_email,
      phone: invoice.customer_phone,
      street: invoice.customer_street,
      city: invoice.customer_city,
      state: invoice.customer_state,
      zip: invoice.customer_zip,
    },
    lineItems: itemsResult.rows,
    logoBuffer: company.logo_data || null,
  });

  await sendInvoiceEmail({
    to: invoice.customer_email,
    cc: company.admin_email,
    companyName: company.name,
    invoice,
    pdfBuffer,
  });

  const updateResult = await db.query(
    `UPDATE invoices SET status = 'sent', sent_at = now() WHERE id = $1 RETURNING *`,
    [invoiceId]
  );
  return updateResult.rows[0];
}

// GET /api/admin/invoices
// Returns every invoice for this company, most recent first, with the
// customer's name joined in and an `is_overdue` flag computed on the fly
// (sent + past due date) rather than stored, so nothing needs a cron job
// to keep it in sync.
router.get("/invoices", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT i.id, i.invoice_number, i.status, i.payment_terms, i.payment_method,
              i.issue_date, i.due_date, i.subtotal, i.tax_rate, i.tax_amount, i.total,
              i.sent_at, i.paid_at, i.created_at, i.reminder_count, i.last_reminder_sent_at,
              i.customer_id, c.name AS customer_name,
              (i.status = 'sent' AND i.due_date < CURRENT_DATE) AS is_overdue
       FROM invoices i
       JOIN customers c ON c.id = i.customer_id
       WHERE i.company_id = $1
       ORDER BY i.invoice_number DESC`,
      [req.companyId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /admin/invoices failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load invoices." });
  }
});

// GET /api/admin/invoices/:id
// Full detail, including line items and the customer's contact info (used
// both for the edit form and to render/send the PDF).
router.get("/invoices/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      `SELECT i.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
              c.street AS customer_street, c.city AS customer_city, c.state AS customer_state, c.zip AS customer_zip,
              (i.status = 'sent' AND i.due_date < CURRENT_DATE) AS is_overdue
       FROM invoices i
       JOIN customers c ON c.id = i.customer_id
       WHERE i.id = $1 AND i.company_id = $2`,
      [id, req.companyId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "Invoice not found" });

    const items = await db.query(
      `SELECT id, description, quantity, unit_price, (quantity * unit_price) AS amount
       FROM invoice_line_items WHERE invoice_id = $1 ORDER BY sort_order`,
      [id]
    );
    res.json({ ...result.rows[0], line_items: items.rows });
  } catch (err) {
    console.error("GET /admin/invoices/:id failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load invoice." });
  }
});

// GET /api/admin/invoices/:id/pdf
// Regenerates the invoice PDF on demand (from the same data used to email
// it) and streams it back so Jeremy can see exactly what a customer
// received, for any invoice status -- including a draft that hasn't been
// sent yet, as a preview. Nothing is stored -- this is rendered fresh every
// time it's requested.
router.get("/invoices/:id/pdf", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      `SELECT i.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
              c.street AS customer_street, c.city AS customer_city, c.state AS customer_state, c.zip AS customer_zip
       FROM invoices i
       JOIN customers c ON c.id = i.customer_id
       WHERE i.id = $1 AND i.company_id = $2`,
      [id, req.companyId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "Invoice not found" });
    const invoice = result.rows[0];

    const itemsResult = await db.query(
      `SELECT description, quantity, unit_price FROM invoice_line_items WHERE invoice_id = $1 ORDER BY sort_order`,
      [id]
    );
    const companyResult = await db.query(`SELECT name, logo_data FROM companies WHERE id = $1`, [req.companyId]);
    const company = companyResult.rows[0];

    const pdfBuffer = await renderInvoicePdf({
      companyName: company.name,
      invoice,
      customer: {
        name: invoice.customer_name,
        email: invoice.customer_email,
        phone: invoice.customer_phone,
        street: invoice.customer_street,
        city: invoice.customer_city,
        state: invoice.customer_state,
        zip: invoice.customer_zip,
      },
      lineItems: itemsResult.rows,
      logoBuffer: company.logo_data || null,
    });

    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", `inline; filename="invoice-${invoice.invoice_number}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error("GET /admin/invoices/:id/pdf failed:", err);
    res.status(500).json({ error: err.message || "Couldn't generate invoice PDF." });
  }
});

// POST /api/admin/invoices
// Body: { customer_id, job_id?, payment_terms, issue_date?, tax_rate?, notes?, line_items: [{description, quantity, unit_price}] }
// Saved as a draft, then immediately emailed to the customer -- the
// response's status will be "sent" if that succeeded. If the customer has
// no email on file (or sending otherwise fails), it's left as a draft and
// the response includes a `send_warning` explaining why, so nothing is
// silently lost -- the manual Send button can be used once that's fixed.
router.post("/invoices", async (req, res) => {
  const client = await db.pool.connect();
  try {
    const { customer_id, job_id, payment_terms, issue_date, tax_rate, notes, line_items } = req.body;
    if (!customer_id) return res.status(400).json({ error: "customer_id is required" });
    if (!Array.isArray(line_items) || line_items.length === 0) {
      return res.status(400).json({ error: "At least one line item is required" });
    }
    const terms = payment_terms || "due_on_receipt";
    if (!PAYMENT_TERMS.includes(terms)) {
      return res.status(400).json({ error: `payment_terms must be one of: ${PAYMENT_TERMS.join(", ")}` });
    }
    for (const item of line_items) {
      if (!item.description || item.quantity == null || item.unit_price == null) {
        return res.status(400).json({ error: "Each line item needs description, quantity, and unit_price" });
      }
    }

    const ownsCustomer = await client.query(`SELECT id FROM customers WHERE id = $1 AND company_id = $2`, [customer_id, req.companyId]);
    if (ownsCustomer.rowCount === 0) return res.status(400).json({ error: "Customer not found" });

    let jobId = null;
    if (job_id) {
      const ownsJob = await client.query(`SELECT id FROM jobs WHERE id = $1 AND company_id = $2`, [job_id, req.companyId]);
      if (ownsJob.rowCount === 0) return res.status(400).json({ error: "Job not found" });
      jobId = job_id;
    }

    const issueDate = issue_date || new Date().toISOString().slice(0, 10);
    const dueDate = computeDueDate(issueDate, terms);
    const { subtotal, taxAmount, total } = computeInvoiceTotals(line_items, tax_rate || 0);

    await client.query("BEGIN");
    // Per-company advisory lock so two invoices created at the same instant
    // can't both land on the same invoice_number.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [req.companyId]);
    const numResult = await client.query(
      `SELECT COALESCE(MAX(invoice_number), 0) + 1 AS next FROM invoices WHERE company_id = $1`,
      [req.companyId]
    );
    const invoiceNumber = numResult.rows[0].next;

    const invoiceResult = await client.query(
      `INSERT INTO invoices (company_id, customer_id, job_id, invoice_number, payment_terms, issue_date, due_date, notes, subtotal, tax_rate, tax_amount, total)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [req.companyId, customer_id, jobId, invoiceNumber, terms, issueDate, dueDate, notes || null, subtotal, tax_rate || 0, taxAmount, total]
    );
    const invoice = invoiceResult.rows[0];

    for (let i = 0; i < line_items.length; i++) {
      const item = line_items[i];
      await client.query(
        `INSERT INTO invoice_line_items (invoice_id, description, quantity, unit_price, sort_order)
         VALUES ($1, $2, $3, $4, $5)`,
        [invoice.id, item.description, item.quantity, item.unit_price, i]
      );
    }

    await client.query("COMMIT");

    let finalInvoice = invoice;
    let sendWarning = null;
    try {
      finalInvoice = await sendInvoiceNow(invoice.id, req.companyId);
    } catch (sendErr) {
      if (!sendErr.expected) console.error("Auto-send on invoice creation failed:", sendErr);
      sendWarning = sendErr.message || "Couldn't send the invoice automatically.";
    }

    res.status(201).json({
      ...finalInvoice,
      line_items: line_items.map((it, i) => ({ ...it, sort_order: i })),
      send_warning: sendWarning,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("POST /admin/invoices failed:", err);
    res.status(500).json({ error: err.message || "Couldn't create invoice." });
  } finally {
    client.release();
  }
});

// PATCH /api/admin/invoices/:id
// Body: any of { customer_id, job_id, payment_terms, issue_date, tax_rate, notes, line_items }
// Only allowed while the invoice is still a draft -- once it's been sent,
// the numbers on the customer's copy shouldn't silently change out from
// under them. Void it and create a new one instead. After saving, this
// also attempts to auto-send -- useful for a draft that stayed a draft
// because the customer had no email on file yet (add one, then re-save).
router.patch("/invoices/:id", async (req, res) => {
  const client = await db.pool.connect();
  try {
    const { id } = req.params;
    const owns = await client.query(`SELECT * FROM invoices WHERE id = $1 AND company_id = $2`, [id, req.companyId]);
    if (owns.rowCount === 0) return res.status(404).json({ error: "Invoice not found" });
    if (owns.rows[0].status !== "draft") {
      return res.status(400).json({ error: "Only draft invoices can be edited. Void it and create a new one instead." });
    }
    const existing = owns.rows[0];
    const { customer_id, job_id, payment_terms, issue_date, tax_rate, notes, line_items } = req.body;

    if (customer_id !== undefined) {
      const ownsCustomer = await client.query(`SELECT id FROM customers WHERE id = $1 AND company_id = $2`, [customer_id, req.companyId]);
      if (ownsCustomer.rowCount === 0) return res.status(400).json({ error: "Customer not found" });
    }
    if (job_id) {
      const ownsJob = await client.query(`SELECT id FROM jobs WHERE id = $1 AND company_id = $2`, [job_id, req.companyId]);
      if (ownsJob.rowCount === 0) return res.status(400).json({ error: "Job not found" });
    }
    const terms = payment_terms !== undefined ? payment_terms : existing.payment_terms;
    if (!PAYMENT_TERMS.includes(terms)) {
      return res.status(400).json({ error: `payment_terms must be one of: ${PAYMENT_TERMS.join(", ")}` });
    }

    let items = line_items;
    if (items !== undefined) {
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: "At least one line item is required" });
      }
      for (const item of items) {
        if (!item.description || item.quantity == null || item.unit_price == null) {
          return res.status(400).json({ error: "Each line item needs description, quantity, and unit_price" });
        }
      }
    } else {
      const currentItems = await client.query(
        `SELECT description, quantity, unit_price FROM invoice_line_items WHERE invoice_id = $1 ORDER BY sort_order`,
        [id]
      );
      items = currentItems.rows;
    }

    const issueDate = issue_date !== undefined ? issue_date : existing.issue_date.toISOString().slice(0, 10);
    const dueDate = computeDueDate(issueDate, terms);
    const taxRate = tax_rate !== undefined ? tax_rate : existing.tax_rate;
    const { subtotal, taxAmount, total } = computeInvoiceTotals(items, taxRate);

    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE invoices SET customer_id = $1, job_id = $2, payment_terms = $3, issue_date = $4, due_date = $5,
              notes = $6, tax_rate = $7, subtotal = $8, tax_amount = $9, total = $10
       WHERE id = $11
       RETURNING *`,
      [
        customer_id !== undefined ? customer_id : existing.customer_id,
        job_id !== undefined ? (job_id || null) : existing.job_id,
        terms,
        issueDate,
        dueDate,
        notes !== undefined ? notes : existing.notes,
        taxRate,
        subtotal,
        taxAmount,
        total,
        id,
      ]
    );

    if (line_items !== undefined) {
      await client.query(`DELETE FROM invoice_line_items WHERE invoice_id = $1`, [id]);
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        await client.query(
          `INSERT INTO invoice_line_items (invoice_id, description, quantity, unit_price, sort_order)
           VALUES ($1, $2, $3, $4, $5)`,
          [id, item.description, item.quantity, item.unit_price, i]
        );
      }
    }

    await client.query("COMMIT");

    let finalInvoice = result.rows[0];
    let sendWarning = null;
    try {
      finalInvoice = await sendInvoiceNow(id, req.companyId);
    } catch (sendErr) {
      if (!sendErr.expected) console.error("Auto-send on invoice update failed:", sendErr);
      sendWarning = sendErr.message || "Couldn't send the invoice automatically.";
    }

    res.json({ ...finalInvoice, send_warning: sendWarning });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("PATCH /admin/invoices/:id failed:", err);
    res.status(500).json({ error: err.message || "Couldn't update invoice." });
  } finally {
    client.release();
  }
});

// DELETE /api/admin/invoices/:id
// Only draft invoices can be deleted outright -- once sent, use void
// instead so the invoice number and history stay intact.
router.delete("/invoices/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const owns = await db.query(`SELECT status FROM invoices WHERE id = $1 AND company_id = $2`, [id, req.companyId]);
    if (owns.rowCount === 0) return res.status(404).json({ error: "Invoice not found" });
    if (owns.rows[0].status !== "draft") {
      return res.status(400).json({ error: "Only draft invoices can be deleted. Void it instead." });
    }
    await db.query(`DELETE FROM invoices WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /admin/invoices/:id failed:", err);
    res.status(500).json({ error: err.message || "Couldn't delete invoice." });
  }
});

// POST /api/admin/invoices/:id/send
// Manual send/resend -- the same logic new invoices trigger automatically
// on save, exposed here for resending as a reminder, or for a draft that
// didn't auto-send the first time (e.g. the customer had no email on file
// yet).
router.post("/invoices/:id/send", async (req, res) => {
  try {
    const invoice = await sendInvoiceNow(req.params.id, req.companyId);
    res.json(invoice);
  } catch (err) {
    if (!err.expected) console.error("POST /admin/invoices/:id/send failed:", err);
    res.status(err.status || 500).json({ error: err.message || "Couldn't send invoice." });
  }
});

// PATCH /api/admin/invoices/:id/mark-paid
// Body: { payment_method } -- one of card/check/cash/other. Doesn't process
// any payment itself; this just records how payment came in (a check that
// arrived in the mail, a card run through a separate terminal, cash, etc.)
// so the invoice's status reflects reality.
router.patch("/invoices/:id/mark-paid", async (req, res) => {
  try {
    const { id } = req.params;
    const { payment_method } = req.body;
    if (!PAYMENT_METHODS.includes(payment_method)) {
      return res.status(400).json({ error: `payment_method must be one of: ${PAYMENT_METHODS.join(", ")}` });
    }
    const owns = await db.query(`SELECT status FROM invoices WHERE id = $1 AND company_id = $2`, [id, req.companyId]);
    if (owns.rowCount === 0) return res.status(404).json({ error: "Invoice not found" });
    if (owns.rows[0].status === "void") return res.status(400).json({ error: "Can't mark a voided invoice as paid." });

    const result = await db.query(
      `UPDATE invoices SET status = 'paid', payment_method = $1, paid_at = now() WHERE id = $2 RETURNING *`,
      [payment_method, id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("PATCH /admin/invoices/:id/mark-paid failed:", err);
    res.status(500).json({ error: err.message || "Couldn't mark invoice as paid." });
  }
});

// PATCH /api/admin/invoices/:id/void
// Voids an invoice (sent by mistake, job fell through, etc.) without
// deleting it, so the invoice number and history stay intact.
router.patch("/invoices/:id/void", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      `UPDATE invoices SET status = 'void' WHERE id = $1 AND company_id = $2 RETURNING *`,
      [id, req.companyId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "Invoice not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("PATCH /admin/invoices/:id/void failed:", err);
    res.status(500).json({ error: err.message || "Couldn't void invoice." });
  }
});

// ---------- Quotes ----------
// A quote (estimate) is priced up for a customer before any work is booked.
// It shares its line-item/tax/total math with invoices (computeInvoiceTotals
// works on either), but has its own sequential numbering, its own simpler
// draft -> sent -> accepted/declined status, and no payment concept at all
// -- it doesn't owe anything until it's converted into a job and/or an
// invoice. Like invoices, a new quote is auto-sent right after it's created
// (see sendQuoteNow, used by both POST /quotes and POST /quotes/:id/send) --
// if the customer has no email on file, or sending otherwise fails, the
// quote is still saved as a draft and the failure comes back as
// send_warning instead of blocking creation.

// GET /api/admin/quotes
router.get("/quotes", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT q.id, q.quote_number, q.status, q.issue_date, q.expiration_date,
              q.subtotal, q.tax_rate, q.tax_amount, q.total, q.sent_at, q.created_at,
              q.converted_job_id, q.converted_invoice_id,
              q.customer_id, c.name AS customer_name,
              (q.status = 'sent' AND q.expiration_date IS NOT NULL AND q.expiration_date < CURRENT_DATE) AS is_expired
       FROM quotes q
       JOIN customers c ON c.id = q.customer_id
       WHERE q.company_id = $1
       ORDER BY q.quote_number DESC`,
      [req.companyId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /admin/quotes failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load quotes." });
  }
});

// GET /api/admin/quotes/:id
router.get("/quotes/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      `SELECT q.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
              c.street AS customer_street, c.city AS customer_city, c.state AS customer_state, c.zip AS customer_zip,
              (q.status = 'sent' AND q.expiration_date IS NOT NULL AND q.expiration_date < CURRENT_DATE) AS is_expired
       FROM quotes q
       JOIN customers c ON c.id = q.customer_id
       WHERE q.id = $1 AND q.company_id = $2`,
      [id, req.companyId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "Quote not found" });

    const items = await db.query(
      `SELECT id, description, quantity, unit_price, (quantity * unit_price) AS amount
       FROM quote_line_items WHERE quote_id = $1 ORDER BY sort_order`,
      [id]
    );
    res.json({ ...result.rows[0], line_items: items.rows });
  } catch (err) {
    console.error("GET /admin/quotes/:id failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load quote." });
  }
});

// GET /api/admin/quotes/:id/pdf
// Regenerated fresh on every request, same as the invoice PDF -- works for
// any status, including a draft, as a preview.
router.get("/quotes/:id/pdf", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      `SELECT q.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
              c.street AS customer_street, c.city AS customer_city, c.state AS customer_state, c.zip AS customer_zip
       FROM quotes q
       JOIN customers c ON c.id = q.customer_id
       WHERE q.id = $1 AND q.company_id = $2`,
      [id, req.companyId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "Quote not found" });
    const quote = result.rows[0];

    const itemsResult = await db.query(
      `SELECT description, quantity, unit_price FROM quote_line_items WHERE quote_id = $1 ORDER BY sort_order`,
      [id]
    );
    const companyResult = await db.query(`SELECT name, logo_data FROM companies WHERE id = $1`, [req.companyId]);
    const company = companyResult.rows[0];

    const pdfBuffer = await renderQuotePdf({
      companyName: company.name,
      quote,
      customer: {
        name: quote.customer_name,
        email: quote.customer_email,
        phone: quote.customer_phone,
        street: quote.customer_street,
        city: quote.customer_city,
        state: quote.customer_state,
        zip: quote.customer_zip,
      },
      lineItems: itemsResult.rows,
      logoBuffer: company.logo_data || null,
    });

    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", `inline; filename="quote-${quote.quote_number}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error("GET /admin/quotes/:id/pdf failed:", err);
    res.status(500).json({ error: err.message || "Couldn't generate quote PDF." });
  }
});

// Shared by both the auto-send-on-create step (POST /quotes below) and the
// explicit POST /quotes/:id/send route -- mirrors sendInvoiceNow. Bail-outs
// that are a normal, expected part of quote life (wrong status to send from,
// no customer email on file) are tagged err.expected so callers don't log
// them as real bugs, just surface the message (as send_warning on creation,
// or a plain error response on an explicit send).
async function sendQuoteNow(quoteId, companyId) {
  const result = await db.query(
    `SELECT q.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
            c.street AS customer_street, c.city AS customer_city, c.state AS customer_state, c.zip AS customer_zip
     FROM quotes q JOIN customers c ON c.id = q.customer_id
     WHERE q.id = $1 AND q.company_id = $2`,
    [quoteId, companyId]
  );
  if (result.rowCount === 0) {
    const err = new Error("Quote not found");
    err.status = 404;
    throw err;
  }
  const quote = result.rows[0];
  if (!["draft", "sent"].includes(quote.status)) {
    const err = new Error("Only draft or sent quotes can be sent.");
    err.status = 400;
    err.expected = true;
    throw err;
  }
  if (!quote.customer_email) {
    const err = new Error("This customer doesn't have an email on file.");
    err.status = 400;
    err.expected = true;
    throw err;
  }

  const itemsResult = await db.query(
    `SELECT description, quantity, unit_price FROM quote_line_items WHERE quote_id = $1 ORDER BY sort_order`,
    [quoteId]
  );
  const companyResult = await db.query(`SELECT name, admin_email, logo_data FROM companies WHERE id = $1`, [companyId]);
  const company = companyResult.rows[0];

  const pdfBuffer = await renderQuotePdf({
    companyName: company.name,
    quote,
    customer: {
      name: quote.customer_name,
      email: quote.customer_email,
      phone: quote.customer_phone,
      street: quote.customer_street,
      city: quote.customer_city,
      state: quote.customer_state,
      zip: quote.customer_zip,
    },
    lineItems: itemsResult.rows,
    logoBuffer: company.logo_data || null,
  });

  await sendQuoteEmail({
    to: quote.customer_email,
    cc: company.admin_email,
    companyName: company.name,
    quote,
    pdfBuffer,
  });

  const updateResult = await db.query(
    `UPDATE quotes SET status = 'sent', sent_at = now() WHERE id = $1 RETURNING *`,
    [quoteId]
  );
  return updateResult.rows[0];
}

// POST /api/admin/quotes
// Body: { customer_id, issue_date?, expiration_date?, tax_rate?, notes?, line_items: [{description, quantity, unit_price}] }
router.post("/quotes", async (req, res) => {
  const client = await db.pool.connect();
  try {
    const { customer_id, issue_date, expiration_date, tax_rate, notes, line_items } = req.body;
    if (!customer_id) return res.status(400).json({ error: "customer_id is required" });
    if (!Array.isArray(line_items) || line_items.length === 0) {
      return res.status(400).json({ error: "At least one line item is required" });
    }
    for (const item of line_items) {
      if (!item.description || item.quantity == null || item.unit_price == null) {
        return res.status(400).json({ error: "Each line item needs description, quantity, and unit_price" });
      }
    }

    const ownsCustomer = await client.query(`SELECT id FROM customers WHERE id = $1 AND company_id = $2`, [customer_id, req.companyId]);
    if (ownsCustomer.rowCount === 0) return res.status(400).json({ error: "Customer not found" });

    const issueDate = issue_date || new Date().toISOString().slice(0, 10);
    const { subtotal, taxAmount, total } = computeInvoiceTotals(line_items, tax_rate || 0);

    await client.query("BEGIN");
    // Per-company advisory lock -- same trick invoice_number uses -- so two
    // quotes created at the same instant can't collide on the same number.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [req.companyId]);
    const numResult = await client.query(
      `SELECT COALESCE(MAX(quote_number), 0) + 1 AS next FROM quotes WHERE company_id = $1`,
      [req.companyId]
    );
    const quoteNumber = numResult.rows[0].next;

    const quoteResult = await client.query(
      `INSERT INTO quotes (company_id, customer_id, quote_number, issue_date, expiration_date, notes, subtotal, tax_rate, tax_amount, total)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [req.companyId, customer_id, quoteNumber, issueDate, expiration_date || null, notes || null, subtotal, tax_rate || 0, taxAmount, total]
    );
    const quote = quoteResult.rows[0];

    for (let i = 0; i < line_items.length; i++) {
      const item = line_items[i];
      await client.query(
        `INSERT INTO quote_line_items (quote_id, description, quantity, unit_price, sort_order)
         VALUES ($1, $2, $3, $4, $5)`,
        [quote.id, item.description, item.quantity, item.unit_price, i]
      );
    }

    await client.query("COMMIT");

    let finalQuote = quote;
    let sendWarning = null;
    try {
      finalQuote = await sendQuoteNow(quote.id, req.companyId);
    } catch (sendErr) {
      if (!sendErr.expected) console.error("Auto-send on quote creation failed:", sendErr);
      sendWarning = sendErr.message || "Couldn't send the quote automatically.";
    }

    res.status(201).json({
      ...finalQuote,
      line_items: line_items.map((it, i) => ({ ...it, sort_order: i })),
      send_warning: sendWarning,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("POST /admin/quotes failed:", err);
    res.status(500).json({ error: err.message || "Couldn't create quote." });
  } finally {
    client.release();
  }
});

// PATCH /api/admin/quotes/:id
// Body: any of { customer_id, issue_date, expiration_date, tax_rate, notes, line_items }
// Editable while draft or sent (a quote commonly gets revised after going
// out, unlike a sent invoice) -- locked once accepted/declined so the record
// of what was actually agreed to (or turned down) doesn't shift underfoot.
router.patch("/quotes/:id", async (req, res) => {
  const client = await db.pool.connect();
  try {
    const { id } = req.params;
    const owns = await client.query(`SELECT * FROM quotes WHERE id = $1 AND company_id = $2`, [id, req.companyId]);
    if (owns.rowCount === 0) return res.status(404).json({ error: "Quote not found" });
    if (!["draft", "sent"].includes(owns.rows[0].status)) {
      return res.status(400).json({ error: "Only draft or sent quotes can be edited." });
    }
    const existing = owns.rows[0];
    const { customer_id, issue_date, expiration_date, tax_rate, notes, line_items } = req.body;

    if (customer_id !== undefined) {
      const ownsCustomer = await client.query(`SELECT id FROM customers WHERE id = $1 AND company_id = $2`, [customer_id, req.companyId]);
      if (ownsCustomer.rowCount === 0) return res.status(400).json({ error: "Customer not found" });
    }

    let items = line_items;
    if (items !== undefined) {
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: "At least one line item is required" });
      }
      for (const item of items) {
        if (!item.description || item.quantity == null || item.unit_price == null) {
          return res.status(400).json({ error: "Each line item needs description, quantity, and unit_price" });
        }
      }
    } else {
      const currentItems = await client.query(
        `SELECT description, quantity, unit_price FROM quote_line_items WHERE quote_id = $1 ORDER BY sort_order`,
        [id]
      );
      items = currentItems.rows;
    }

    const taxRate = tax_rate !== undefined ? tax_rate : existing.tax_rate;
    const { subtotal, taxAmount, total } = computeInvoiceTotals(items, taxRate);

    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE quotes SET customer_id = $1, issue_date = $2, expiration_date = $3,
              notes = $4, tax_rate = $5, subtotal = $6, tax_amount = $7, total = $8
       WHERE id = $9
       RETURNING *`,
      [
        customer_id !== undefined ? customer_id : existing.customer_id,
        issue_date !== undefined ? issue_date : existing.issue_date.toISOString().slice(0, 10),
        expiration_date !== undefined ? (expiration_date || null) : existing.expiration_date,
        notes !== undefined ? notes : existing.notes,
        taxRate,
        subtotal,
        taxAmount,
        total,
        id,
      ]
    );

    if (line_items !== undefined) {
      await client.query(`DELETE FROM quote_line_items WHERE quote_id = $1`, [id]);
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        await client.query(
          `INSERT INTO quote_line_items (quote_id, description, quantity, unit_price, sort_order)
           VALUES ($1, $2, $3, $4, $5)`,
          [id, item.description, item.quantity, item.unit_price, i]
        );
      }
    }

    await client.query("COMMIT");
    res.json(result.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("PATCH /admin/quotes/:id failed:", err);
    res.status(500).json({ error: err.message || "Couldn't update quote." });
  } finally {
    client.release();
  }
});

// DELETE /api/admin/quotes/:id
// Only drafts can be deleted outright, matching invoices.
router.delete("/quotes/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const owns = await db.query(`SELECT status FROM quotes WHERE id = $1 AND company_id = $2`, [id, req.companyId]);
    if (owns.rowCount === 0) return res.status(404).json({ error: "Quote not found" });
    if (owns.rows[0].status !== "draft") {
      return res.status(400).json({ error: "Only draft quotes can be deleted." });
    }
    await db.query(`DELETE FROM quotes WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /admin/quotes/:id failed:", err);
    res.status(500).json({ error: err.message || "Couldn't delete quote." });
  }
});

// POST /api/admin/quotes/:id/send
// Emails the quote PDF to the customer and marks it "sent". Also used
// internally right after a quote is created (see sendQuoteNow above) --
// this route stays around for re-sending an already-sent quote, or manually
// sending one whose auto-send failed (e.g. customer had no email on file
// yet at creation time, added since).
router.post("/quotes/:id/send", async (req, res) => {
  try {
    const quote = await sendQuoteNow(req.params.id, req.companyId);
    res.json(quote);
  } catch (err) {
    if (!err.expected) console.error("POST /admin/quotes/:id/send failed:", err);
    res.status(err.status || 500).json({ error: err.message || "Couldn't send quote." });
  }
});

// PATCH /api/admin/quotes/:id/mark-accepted
// PATCH /api/admin/quotes/:id/mark-declined
// Records the customer's decision. Doesn't do anything else on its own --
// converting to a job/invoice is a separate explicit action (a customer
// might accept but the work doesn't get scheduled for weeks).
router.patch("/quotes/:id/mark-accepted", async (req, res) => {
  try {
    const result = await db.query(
      `UPDATE quotes SET status = 'accepted' WHERE id = $1 AND company_id = $2 RETURNING *`,
      [req.params.id, req.companyId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "Quote not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("PATCH /admin/quotes/:id/mark-accepted failed:", err);
    res.status(500).json({ error: err.message || "Couldn't mark quote as accepted." });
  }
});

router.patch("/quotes/:id/mark-declined", async (req, res) => {
  try {
    const result = await db.query(
      `UPDATE quotes SET status = 'declined' WHERE id = $1 AND company_id = $2 RETURNING *`,
      [req.params.id, req.companyId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "Quote not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("PATCH /admin/quotes/:id/mark-declined failed:", err);
    res.status(500).json({ error: err.message || "Couldn't mark quote as declined." });
  }
});

// POST /api/admin/quotes/:id/convert-to-job
// Body: { title?, notes?, start_date, end_date, start_time?, color?, event_type?, employee_ids?, crew_ids? }
// Schedules the quoted work as a job, carrying over the quote's customer.
// Reuses the same color/event_type validation and crew/employee assignment
// expansion as the regular jobs route. Records the link both ways (quote ->
// converted_job_id) and bumps the quote to "accepted" if it wasn't already,
// since scheduling the work implies the customer said yes.
router.post("/quotes/:id/convert-to-job", async (req, res) => {
  try {
    const { id } = req.params;
    const quoteResult = await db.query(`SELECT * FROM quotes WHERE id = $1 AND company_id = $2`, [id, req.companyId]);
    if (quoteResult.rowCount === 0) return res.status(404).json({ error: "Quote not found" });
    const quote = quoteResult.rows[0];

    const { title, notes, start_date, end_date, start_time, color, event_type, employee_ids, crew_ids } = req.body;
    if (!start_date || !end_date) {
      return res.status(400).json({ error: "start_date and end_date are required" });
    }
    const jobColor = color || "rust";
    if (!JOB_COLORS[jobColor]) {
      return res.status(400).json({ error: `color must be one of: ${Object.keys(JOB_COLORS).join(", ")}` });
    }
    const eventType = event_type || "job";
    if (!EVENT_TYPES.includes(eventType)) {
      return res.status(400).json({ error: `event_type must be one of: ${EVENT_TYPES.join(", ")}` });
    }
    if (start_time && !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(start_time)) {
      return res.status(400).json({ error: "start_time must be in HH:MM format" });
    }

    const jobTitle = title || `Quote #${quote.quote_number}`;
    const jobResult = await db.query(
      `INSERT INTO jobs (company_id, title, notes, start_date, end_date, start_time, color, event_type, customer_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, title, notes, start_date, end_date, start_time, color, event_type, customer_id, created_at`,
      [req.companyId, jobTitle, notes !== undefined ? notes : quote.notes, start_date, end_date, start_time || null, jobColor, eventType, quote.customer_id]
    );
    const job = jobResult.rows[0];

    const assignments = await expandAssignments({ employee_ids, crew_ids, companyId: req.companyId });
    if (assignments.size > 0) {
      await Promise.all(
        Array.from(assignments.entries()).map(([employeeId, crewId]) =>
          db.query(
            `INSERT INTO job_assignments (job_id, employee_id, assigned_via_crew_id)
             VALUES ($1, $2, $3)`,
            [job.id, employeeId, crewId]
          )
        )
      );
      notifyAssigned(Array.from(assignments.keys()), job);
    }

    const updatedQuote = await db.query(
      `UPDATE quotes SET converted_job_id = $1, status = CASE WHEN status IN ('draft', 'sent') THEN 'accepted' ELSE status END
       WHERE id = $2 RETURNING *`,
      [job.id, id]
    );

    res.status(201).json({ job, quote: updatedQuote.rows[0] });
  } catch (err) {
    console.error("POST /admin/quotes/:id/convert-to-job failed:", err);
    res.status(500).json({ error: err.message || "Couldn't convert quote to a scheduled job." });
  }
});

// POST /api/admin/quotes/:id/convert-to-invoice
// Body: { payment_terms?, issue_date? } -- everything else (customer, line
// items, tax rate) carries over from the quote. Created as a draft, same as
// any other invoice -- NOT auto-sent, so the terms/due date can be reviewed
// first. Links both ways (invoices.quote_id / quotes.converted_invoice_id)
// and bumps the quote to "accepted" if it wasn't already.
router.post("/quotes/:id/convert-to-invoice", async (req, res) => {
  const client = await db.pool.connect();
  try {
    const { id } = req.params;
    const quoteResult = await client.query(`SELECT * FROM quotes WHERE id = $1 AND company_id = $2`, [id, req.companyId]);
    if (quoteResult.rowCount === 0) return res.status(404).json({ error: "Quote not found" });
    const quote = quoteResult.rows[0];

    const itemsResult = await client.query(
      `SELECT description, quantity, unit_price FROM quote_line_items WHERE quote_id = $1 ORDER BY sort_order`,
      [id]
    );
    if (itemsResult.rowCount === 0) return res.status(400).json({ error: "This quote has no line items to invoice." });

    const { payment_terms, issue_date } = req.body;
    const terms = payment_terms || "due_on_receipt";
    if (!PAYMENT_TERMS.includes(terms)) {
      return res.status(400).json({ error: `payment_terms must be one of: ${PAYMENT_TERMS.join(", ")}` });
    }
    const issueDate = issue_date || new Date().toISOString().slice(0, 10);
    const dueDate = computeDueDate(issueDate, terms);
    const { subtotal, taxAmount, total } = computeInvoiceTotals(itemsResult.rows, quote.tax_rate);

    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [req.companyId]);
    const numResult = await client.query(
      `SELECT COALESCE(MAX(invoice_number), 0) + 1 AS next FROM invoices WHERE company_id = $1`,
      [req.companyId]
    );
    const invoiceNumber = numResult.rows[0].next;

    const invoiceResult = await client.query(
      `INSERT INTO invoices (company_id, customer_id, quote_id, invoice_number, payment_terms, issue_date, due_date, notes, subtotal, tax_rate, tax_amount, total)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [req.companyId, quote.customer_id, quote.id, invoiceNumber, terms, issueDate, dueDate, quote.notes, subtotal, quote.tax_rate, taxAmount, total]
    );
    const invoice = invoiceResult.rows[0];

    for (let i = 0; i < itemsResult.rows.length; i++) {
      const item = itemsResult.rows[i];
      await client.query(
        `INSERT INTO invoice_line_items (invoice_id, description, quantity, unit_price, sort_order)
         VALUES ($1, $2, $3, $4, $5)`,
        [invoice.id, item.description, item.quantity, item.unit_price, i]
      );
    }

    const updatedQuote = await client.query(
      `UPDATE quotes SET converted_invoice_id = $1, status = CASE WHEN status IN ('draft', 'sent') THEN 'accepted' ELSE status END
       WHERE id = $2 RETURNING *`,
      [invoice.id, id]
    );

    await client.query("COMMIT");
    res.status(201).json({ invoice: { ...invoice, line_items: itemsResult.rows }, quote: updatedQuote.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("POST /admin/quotes/:id/convert-to-invoice failed:", err);
    res.status(500).json({ error: err.message || "Couldn't convert quote to an invoice." });
  } finally {
    client.release();
  }
});

// ---------- Reports ----------
// GET /api/admin/reports/summary?start=YYYY-MM-DD&end=YYYY-MM-DD
// Aggregates for the Reports tab's preset time ranges (1 week, 1 month,
// etc.) and the this-year-vs-last-year comparison, which just calls this
// twice with two different ranges. "Invoiced" is billed amount (non-draft,
// non-void invoices by issue date); "Paid" is what was actually collected
// (paid invoices by the date they were marked paid) -- these intentionally
// aren't the same number, since something can be invoiced in one period and
// paid in a later one.
router.get("/reports/summary", async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: "start and end are required" });

    const laborResult = await db.query(
      `SELECT COALESCE(SUM(d.worked_seconds), 0) AS total_seconds
       FROM time_entry_durations d
       JOIN employees e ON e.id = d.employee_id
       WHERE e.company_id = $1 AND d.clock_in >= $2::date AND d.clock_in < ($3::date + INTERVAL '1 day')`,
      [req.companyId, start, end]
    );

    const invoicedResult = await db.query(
      `SELECT COALESCE(SUM(total), 0) AS sum_total, COUNT(*) AS cnt
       FROM invoices
       WHERE company_id = $1 AND status NOT IN ('draft', 'void')
         AND issue_date >= $2::date AND issue_date <= $3::date`,
      [req.companyId, start, end]
    );

    const paidResult = await db.query(
      `SELECT COALESCE(SUM(total), 0) AS sum_total, COUNT(*) AS cnt
       FROM invoices
       WHERE company_id = $1 AND status = 'paid'
         AND paid_at >= $2::date AND paid_at < ($3::date + INTERVAL '1 day')`,
      [req.companyId, start, end]
    );

    // Labor cost mirrors the labor_hours query above (same clock_in-based
    // range) but multiplies each employee's worked hours by their own
    // hourly_rate before summing, so employees with different pay rates
    // are costed correctly. Employees with no rate set (NULL) contribute $0
    // -- this undercounts true cost until a rate is filled in for everyone,
    // which is called out to Jeremy in the UI rather than silently guessed.
    const laborCostResult = await db.query(
      `SELECT COALESCE(SUM((d.worked_seconds / 3600.0) * COALESCE(e.hourly_rate, 0)), 0) AS total_cost
       FROM time_entry_durations d
       JOIN employees e ON e.id = d.employee_id
       WHERE e.company_id = $1 AND d.clock_in >= $2::date AND d.clock_in < ($3::date + INTERVAL '1 day')`,
      [req.companyId, start, end]
    );

    const expenseResult = await db.query(
      `SELECT COALESCE(SUM(amount), 0) AS sum_total, COUNT(*) AS cnt
       FROM expenses
       WHERE company_id = $1 AND expense_date >= $2::date AND expense_date <= $3::date`,
      [req.companyId, start, end]
    );

    res.json({
      labor_hours: Number(laborResult.rows[0].total_seconds) / 3600,
      invoice_total: Number(invoicedResult.rows[0].sum_total),
      invoice_count: Number(invoicedResult.rows[0].cnt),
      paid_invoice_total: Number(paidResult.rows[0].sum_total),
      paid_invoice_count: Number(paidResult.rows[0].cnt),
      labor_cost: Number(laborCostResult.rows[0].total_cost),
      expense_total: Number(expenseResult.rows[0].sum_total),
      expense_count: Number(expenseResult.rows[0].cnt),
    });
  } catch (err) {
    console.error("GET /admin/reports/summary failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load report." });
  }
});

// GET /api/admin/reports/labor-breakdown?start=YYYY-MM-DD&end=YYYY-MM-DD
// Per-employee hours + cost for the same date range reports/summary uses --
// powers the drill-down when someone clicks the Labor hours or Gross Profit
// bubble. Only includes employees who actually worked in the range (an
// employee with zero hours has nothing to show here even if they have a
// rate set).
router.get("/reports/labor-breakdown", async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: "start and end are required" });

    const result = await db.query(
      `SELECT e.id AS employee_id, e.name AS employee_name, e.hourly_rate,
              SUM(d.worked_seconds) AS total_seconds
       FROM time_entry_durations d
       JOIN employees e ON e.id = d.employee_id
       WHERE e.company_id = $1 AND d.clock_in >= $2::date AND d.clock_in < ($3::date + INTERVAL '1 day')
       GROUP BY e.id, e.name, e.hourly_rate
       ORDER BY e.name`,
      [req.companyId, start, end]
    );

    res.json(result.rows.map(function(r) {
      const hours = Number(r.total_seconds) / 3600;
      const rate = r.hourly_rate === null ? null : Number(r.hourly_rate);
      return {
        employee_id: r.employee_id,
        employee_name: r.employee_name,
        hours: hours,
        hourly_rate: rate,
        cost: rate === null ? 0 : hours * rate,
      };
    }));
  } catch (err) {
    console.error("GET /admin/reports/labor-breakdown failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load labor breakdown." });
  }
});

// ---------- Expenses ----------
// Simple manually-logged business costs (materials, insurance, rent, etc.)
// that feed into Net Profit on the Reports tab. Deliberately minimal --
// date, amount, optional description -- for quick logging rather than full
// bookkeeping.

// GET /api/admin/expenses
router.get("/expenses", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT e.id, e.expense_date, e.amount, e.description, e.created_at, e.job_id, j.title AS job_title
       FROM expenses e
       LEFT JOIN jobs j ON j.id = e.job_id
       WHERE e.company_id = $1 ORDER BY e.expense_date DESC, e.created_at DESC`,
      [req.companyId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /admin/expenses failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load expenses." });
  }
});

// POST /api/admin/expenses
// Body: { expense_date, amount, description?, job_id? }
router.post("/expenses", async (req, res) => {
  try {
    const { expense_date, amount, description, job_id } = req.body;
    if (!expense_date) return res.status(400).json({ error: "expense_date is required" });
    if (amount === undefined || amount === null || isNaN(Number(amount))) {
      return res.status(400).json({ error: "amount is required" });
    }
    if (job_id) {
      const ownsJob = await db.query(`SELECT id FROM jobs WHERE id = $1 AND company_id = $2`, [job_id, req.companyId]);
      if (ownsJob.rowCount === 0) return res.status(400).json({ error: "job not found" });
    }
    const result = await db.query(
      `INSERT INTO expenses (company_id, expense_date, amount, description, job_id) VALUES ($1, $2, $3, $4, $5)
       RETURNING id, expense_date, amount, description, created_at, job_id`,
      [req.companyId, expense_date, Number(amount), description || null, job_id || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("POST /admin/expenses failed:", err);
    res.status(500).json({ error: err.message || "Couldn't create expense." });
  }
});

// PATCH /api/admin/expenses/:id
// Body: { expense_date?, amount?, description?, job_id? } -- job_id: null unassigns
router.patch("/expenses/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { expense_date, amount, description, job_id } = req.body;
    const owns = await db.query(`SELECT id FROM expenses WHERE id = $1 AND company_id = $2`, [id, req.companyId]);
    if (owns.rowCount === 0) return res.status(404).json({ error: "Expense not found" });

    if (amount !== undefined && isNaN(Number(amount))) {
      return res.status(400).json({ error: "amount must be a number" });
    }
    if (job_id) {
      const ownsJob = await db.query(`SELECT id FROM jobs WHERE id = $1 AND company_id = $2`, [job_id, req.companyId]);
      if (ownsJob.rowCount === 0) return res.status(400).json({ error: "job not found" });
    }

    const fields = [];
    const values = [];
    if (expense_date !== undefined) { values.push(expense_date); fields.push(`expense_date = $${values.length}`); }
    if (amount !== undefined) { values.push(Number(amount)); fields.push(`amount = $${values.length}`); }
    if (description !== undefined) { values.push(description || null); fields.push(`description = $${values.length}`); }
    if (job_id !== undefined) { values.push(job_id || null); fields.push(`job_id = $${values.length}`); }
    if (fields.length === 0) return res.status(400).json({ error: "Nothing to update" });

    values.push(id, req.companyId);
    const result = await db.query(
      `UPDATE expenses SET ${fields.join(", ")} WHERE id = $${values.length - 1} AND company_id = $${values.length}
       RETURNING id, expense_date, amount, description, created_at, job_id`,
      values
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("PATCH /admin/expenses/:id failed:", err);
    res.status(500).json({ error: err.message || "Couldn't update expense." });
  }
});

// DELETE /api/admin/expenses/:id
router.delete("/expenses/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(`DELETE FROM expenses WHERE id = $1 AND company_id = $2`, [id, req.companyId]);
    if (result.rowCount === 0) return res.status(404).json({ error: "Expense not found" });
    res.status(204).end();
  } catch (err) {
    console.error("DELETE /admin/expenses/:id failed:", err);
    res.status(500).json({ error: err.message || "Couldn't delete expense." });
  }
});

// ---------- Catalog items ----------
// A reusable, per-company list of recurring invoice line items (name +
// default unit price) so common charges don't need to be re-typed on every
// invoice. Picking one just pre-fills a normal line item on the invoice --
// there's no ongoing link back to the catalog afterward.

// GET /api/admin/catalog-items
router.get("/catalog-items", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, unit_price, created_at FROM catalog_items WHERE company_id = $1 ORDER BY name`,
      [req.companyId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /admin/catalog-items failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load catalog items." });
  }
});

// POST /api/admin/catalog-items
// Body: { name, unit_price }
router.post("/catalog-items", async (req, res) => {
  try {
    const { name, unit_price } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });
    const result = await db.query(
      `INSERT INTO catalog_items (company_id, name, unit_price) VALUES ($1, $2, $3)
       RETURNING id, name, unit_price, created_at`,
      [req.companyId, name, Number(unit_price) || 0]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("POST /admin/catalog-items failed:", err);
    res.status(500).json({ error: err.message || "Couldn't create catalog item." });
  }
});

// PATCH /api/admin/catalog-items/:id
// Body: { name?, unit_price? }
router.patch("/catalog-items/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, unit_price } = req.body;
    const owns = await db.query(`SELECT id FROM catalog_items WHERE id = $1 AND company_id = $2`, [id, req.companyId]);
    if (owns.rowCount === 0) return res.status(404).json({ error: "Catalog item not found" });

    const fields = [];
    const values = [];
    if (name !== undefined) { values.push(name); fields.push(`name = $${values.length}`); }
    if (unit_price !== undefined) { values.push(Number(unit_price) || 0); fields.push(`unit_price = $${values.length}`); }

    let item = owns.rows[0];
    if (fields.length > 0) {
      values.push(id);
      const result = await db.query(
        `UPDATE catalog_items SET ${fields.join(", ")} WHERE id = $${values.length}
         RETURNING id, name, unit_price, created_at`,
        values
      );
      item = result.rows[0];
    }
    res.json(item);
  } catch (err) {
    console.error("PATCH /admin/catalog-items/:id failed:", err);
    res.status(500).json({ error: err.message || "Couldn't update catalog item." });
  }
});

// DELETE /api/admin/catalog-items/:id
router.delete("/catalog-items/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(`DELETE FROM catalog_items WHERE id = $1 AND company_id = $2`, [id, req.companyId]);
    if (result.rowCount === 0) return res.status(404).json({ error: "Catalog item not found" });
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /admin/catalog-items/:id failed:", err);
    res.status(500).json({ error: err.message || "Couldn't delete catalog item." });
  }
});

// ---------- Company logo ----------
// An optional logo shown on generated invoice PDFs, stored directly in
// Postgres as bytea rather than a separate file-storage service. Uploaded
// as base64 over the normal JSON API (no multipart handling needed) --
// server.js raises the JSON body limit to 6mb to make room for that.

const LOGO_MAX_BYTES = 3 * 1024 * 1024; // 3MB, before base64 inflation
const LOGO_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];

// GET /api/admin/company-logo
// Returns { logo: null } if none is set, otherwise { logo: "data:<mime>;base64,..." }
// ready to drop straight into an <img src>.
router.get("/company-logo", async (req, res) => {
  try {
    const result = await db.query(`SELECT logo_data, logo_mime_type FROM companies WHERE id = $1`, [req.companyId]);
    const row = result.rows[0];
    if (!row || !row.logo_data) return res.json({ logo: null });
    res.json({ logo: `data:${row.logo_mime_type};base64,${row.logo_data.toString("base64")}` });
  } catch (err) {
    console.error("GET /admin/company-logo failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load logo." });
  }
});

// PUT /api/admin/company-logo
// Body: { logo_base64, mime_type } -- logo_base64 is the raw base64 payload
// (no "data:...;base64," prefix).
router.put("/company-logo", async (req, res) => {
  try {
    const { logo_base64, mime_type } = req.body;
    if (!logo_base64 || !mime_type) {
      return res.status(400).json({ error: "logo_base64 and mime_type are required" });
    }
    if (!LOGO_MIME_TYPES.includes(mime_type)) {
      return res.status(400).json({ error: "Logo must be a PNG, JPEG, or WebP image." });
    }
    const buffer = Buffer.from(logo_base64, "base64");
    if (buffer.length > LOGO_MAX_BYTES) {
      return res.status(400).json({ error: "Logo must be 3MB or smaller." });
    }
    await db.query(`UPDATE companies SET logo_data = $1, logo_mime_type = $2 WHERE id = $3`, [buffer, mime_type, req.companyId]);
    res.json({ ok: true });
  } catch (err) {
    console.error("PUT /admin/company-logo failed:", err);
    res.status(500).json({ error: err.message || "Couldn't save logo." });
  }
});

// DELETE /api/admin/company-logo
router.delete("/company-logo", async (req, res) => {
  try {
    await db.query(`UPDATE companies SET logo_data = NULL, logo_mime_type = NULL WHERE id = $1`, [req.companyId]);
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /admin/company-logo failed:", err);
    res.status(500).json({ error: err.message || "Couldn't remove logo." });
  }
});

// ---------- Admin push subscriptions (for chat notifications) ----------
// POST /api/admin/push/subscribe
// Body: a PushSubscription object from the browser's Push API. Called once
// per device from the mobile admin web page.
router.post("/push/subscribe", async (req, res) => {
  try {
    const { endpoint, keys } = req.body;
    if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
      return res.status(400).json({ error: "A valid push subscription is required" });
    }
    await db.query(
      `INSERT INTO admin_push_subscriptions (company_id, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE SET company_id = $1, p256dh = $3, auth = $4`,
      [req.companyId, endpoint, keys.p256dh, keys.auth]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error("POST /admin/push/subscribe failed:", err);
    res.status(500).json({ error: err.message || "Couldn't save subscription." });
  }
});

// POST /api/admin/push/unsubscribe
// Body: { endpoint }
router.post("/push/unsubscribe", async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ error: "endpoint is required" });
    await db.query(`DELETE FROM admin_push_subscriptions WHERE endpoint = $1 AND company_id = $2`, [endpoint, req.companyId]);
    res.json({ ok: true });
  } catch (err) {
    console.error("POST /admin/push/unsubscribe failed:", err);
    res.status(500).json({ error: err.message || "Couldn't remove subscription." });
  }
});

// ---------- Chat ----------
// One thread per employee (there's only one admin per company). Employees
// only show up here if they're currently clocked in (so a brand-new
// conversation can be started) or already have message history (so past
// conversations stay visible after someone clocks out).
router.get("/chat/threads", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT e.id, e.name,
              (open_te.id IS NOT NULL) AS on_clock,
              lm.body AS last_message_body, lm.sender AS last_message_sender, lm.created_at AS last_message_at,
              COALESCE(uc.unread_count, 0)::int AS unread_count
       FROM employees e
       LEFT JOIN time_entries open_te ON open_te.employee_id = e.id AND open_te.clock_out IS NULL
       LEFT JOIN LATERAL (
         SELECT body, sender, created_at FROM chat_messages WHERE employee_id = e.id ORDER BY created_at DESC LIMIT 1
       ) lm ON true
       LEFT JOIN (
         SELECT employee_id, COUNT(*) AS unread_count FROM chat_messages
         WHERE sender = 'employee' AND read_by_admin = false GROUP BY employee_id
       ) uc ON uc.employee_id = e.id
       WHERE e.company_id = $1 AND e.active = true AND (open_te.id IS NOT NULL OR lm.created_at IS NOT NULL)
       ORDER BY (lm.created_at IS NULL), lm.created_at DESC, e.name`,
      [req.companyId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /admin/chat/threads failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load chats." });
  }
});

// GET /api/admin/chat/:employeeId/messages
// Marks the employee's messages in this thread as read.
router.get("/chat/:employeeId/messages", async (req, res) => {
  try {
    const { employeeId } = req.params;
    const owns = await db.query(`SELECT id FROM employees WHERE id = $1 AND company_id = $2`, [employeeId, req.companyId]);
    if (owns.rowCount === 0) return res.status(404).json({ error: "Employee not found" });

    const result = await db.query(
      `SELECT id, sender, body, created_at FROM chat_messages WHERE employee_id = $1 ORDER BY created_at`,
      [employeeId]
    );
    await db.query(
      `UPDATE chat_messages SET read_by_admin = true WHERE employee_id = $1 AND sender = 'employee' AND read_by_admin = false`,
      [employeeId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /admin/chat/:employeeId/messages failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load messages." });
  }
});

// POST /api/admin/chat/:employeeId/messages
// Body: { body }. Only allowed while the employee is currently clocked in.
router.post("/chat/:employeeId/messages", async (req, res) => {
  try {
    const { employeeId } = req.params;
    const { body } = req.body;
    if (!body || !body.trim()) return res.status(400).json({ error: "Message can't be empty." });

    const employee = await db.query(`SELECT id, name FROM employees WHERE id = $1 AND company_id = $2`, [employeeId, req.companyId]);
    if (employee.rowCount === 0) return res.status(404).json({ error: "Employee not found" });

    const openShift = await db.query(`SELECT id FROM time_entries WHERE employee_id = $1 AND clock_out IS NULL`, [employeeId]);
    if (openShift.rowCount === 0) {
      return res.status(400).json({ error: "This employee isn't clocked in right now, so they can't be messaged." });
    }

    const result = await db.query(
      `INSERT INTO chat_messages (company_id, employee_id, sender, body, read_by_admin, read_by_employee)
       VALUES ($1, $2, 'admin', $3, true, false)
       RETURNING id, sender, body, created_at`,
      [req.companyId, employeeId, body.trim()]
    );

    const company = await db.query(`SELECT name FROM companies WHERE id = $1`, [req.companyId]);
    const companyName = company.rows[0]?.name || "Your employer";
    sendPushToEmployee(employeeId, {
      title: `Message from ${companyName}`,
      body: body.trim().slice(0, 120),
      url: "/chat",
    }).catch((err) => console.error("Failed to send chat push notification:", err.message));

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("POST /admin/chat/:employeeId/messages failed:", err);
    res.status(500).json({ error: err.message || "Couldn't send message." });
  }
});

module.exports = router;