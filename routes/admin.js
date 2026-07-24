const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const db = require("../db");
const { loginAdmin } = require("../utils/adminAuth");
const { hashPin } = require("../utils/auth");
const { generateResetToken, hashResetToken } = require("../utils/resetToken");
const { sendAdminPasswordResetEmail, sendInvoiceEmail } = require("../utils/mailer");
const { renderInvoicePdf } = require("../utils/invoicePdf");
const requireAdmin = require("../middleware/requireAdmin");
const { getPayPeriod, PAY_FREQUENCIES } = require("../utils/payPeriod");
const { JOB_COLORS } = require("../utils/jobColors");
const { sendPushToEmployee } = require("../utils/webPush");

const EVENT_TYPES = ["job", "personal", "other"];
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

router.get("/employees", async (req, res) => {
  const result = await db.query(
    `SELECT id, name, email, active, created_at FROM employees WHERE company_id = $1 ORDER BY name`,
    [req.companyId]
  );
  res.json(result.rows);
});

router.post("/employees", async (req, res) => {
  const { name, email, pin } = req.body;
  if (!name || !email || !pin) {
    return res.status(400).json({ error: "name, email, and pin are required" });
  }
  const pin_hash = await hashPin(pin);
  try {
    const result = await db.query(
      `INSERT INTO employees (name, email, pin_hash, company_id) VALUES ($1, $2, $3, $4)
       RETURNING id, name, email, active, created_at`,
      [name, email, pin_hash, req.companyId]
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
  const { name, email, active, pin } = req.body;

  const fields = [];
  const values = [];
  if (name !== undefined) { values.push(name); fields.push(`name = $${values.length}`); }
  if (email !== undefined) { values.push(email); fields.push(`email = $${values.length}`); }
  if (active !== undefined) { values.push(active); fields.push(`active = $${values.length}`); }
  if (pin) { values.push(await hashPin(pin)); fields.push(`pin_hash = $${values.length}`); }

  if (fields.length === 0) return res.status(400).json({ error: "Nothing to update" });

  values.push(id, req.companyId);
  try {
    const result = await db.query(
      `UPDATE employees SET ${fields.join(", ")} WHERE id = $${values.length - 1} AND company_id = $${values.length}
       RETURNING id, name, email, active, created_at`,
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
      `SELECT id, title, notes, start_date, end_date, color, event_type
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

async function notifyAssigned(employeeIds, job) {
  const dateRange =
    job.start_date === job.end_date
      ? job.start_date
      : `${job.start_date} to ${job.end_date}`;
  await Promise.all(
    employeeIds.map((employeeId) =>
      sendPushToEmployee(employeeId, {
        title: "New event scheduled",
        body: `${job.title} — ${dateRange}`,
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
      `SELECT j.id, j.title, j.notes, j.start_date, j.end_date, j.color, j.event_type, j.created_at,
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
    const { title, notes, start_date, end_date, color, event_type, customer_id, employee_ids, crew_ids } = req.body;
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
    let customerId = null;
    if (customer_id) {
      const ownsCustomer = await db.query(`SELECT id FROM customers WHERE id = $1 AND company_id = $2`, [customer_id, req.companyId]);
      if (ownsCustomer.rowCount === 0) return res.status(400).json({ error: "customer not found" });
      customerId = customer_id;
    }

    const jobResult = await db.query(
      `INSERT INTO jobs (company_id, title, notes, start_date, end_date, color, event_type, customer_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, title, notes, start_date, end_date, color, event_type, customer_id, created_at`,
      [req.companyId, title, notes || null, start_date, end_date, jobColor, eventType, customerId]
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
    const { title, notes, start_date, end_date, color, event_type, customer_id, employee_ids, crew_ids } = req.body;

    const owns = await db.query(`SELECT * FROM jobs WHERE id = $1 AND company_id = $2`, [id, req.companyId]);
    if (owns.rowCount === 0) return res.status(404).json({ error: "Event not found" });

    const fields = [];
    const values = [];
    if (title !== undefined) { values.push(title); fields.push(`title = $${values.length}`); }
    if (notes !== undefined) { values.push(notes); fields.push(`notes = $${values.length}`); }
    if (start_date !== undefined) { values.push(start_date); fields.push(`start_date = $${values.length}`); }
    if (end_date !== undefined) { values.push(end_date); fields.push(`end_date = $${values.length}`); }
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
         RETURNING id, title, notes, start_date, end_date, color, event_type, customer_id, created_at`,
        values
      );
      job = result.rows[0];
    }

    if (employee_ids !== undefined || crew_ids !== undefined) {
      const before = await db.query(`SELECT employee_id FROM job_assignments WHERE job_id = $1`, [id]);
      const beforeIds = new Set(before.rows.map((r) => r.employee_id));

      const assignments = await expandAssignments({ employee_ids, crew_ids, companyId: req.companyId });
      await db.query(`DELETE FROM job_assignments WHERE job_id = $1`, [id]);
      if (assignments.size > 0) {
        await Promise.all(
          Array.from(assignments.entries()).map(([employeeId, crewId]) =>
            db.query(
              `INSERT INTO job_assignments (job_id, employee_id, assigned_via_crew_id)
               VALUES ($1, $2, $3)`,
              [id, employeeId, crewId]
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
              i.sent_at, i.paid_at, i.created_at,
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

// POST /api/admin/invoices
// Body: { customer_id, job_id?, payment_terms, issue_date?, tax_rate?, notes?, line_items: [{description, quantity, unit_price}] }
// Always created as a draft -- POST /invoices/:id/send is the only thing
// that flips it to "sent".
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
    res.status(201).json({ ...invoice, line_items: line_items.map((it, i) => ({ ...it, sort_order: i })) });
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
// under them. Void it and create a new one instead.
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
    res.json(result.rows[0]);
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
// Renders the invoice as a PDF and emails it to the customer (cc'ing this
// company's own admin email as a paper trail), then marks the invoice
// "sent". A sent invoice can be re-sent later (e.g. as a reminder) without
// changing its status again.
router.post("/invoices/:id/send", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      `SELECT i.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
              c.street AS customer_street, c.city AS customer_city, c.state AS customer_state, c.zip AS customer_zip
       FROM invoices i JOIN customers c ON c.id = i.customer_id
       WHERE i.id = $1 AND i.company_id = $2`,
      [id, req.companyId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "Invoice not found" });
    const invoice = result.rows[0];
    if (invoice.status === "void") return res.status(400).json({ error: "Can't send a voided invoice." });
    if (!invoice.customer_email) return res.status(400).json({ error: "This customer doesn't have an email on file." });

    const itemsResult = await db.query(
      `SELECT description, quantity, unit_price FROM invoice_line_items WHERE invoice_id = $1 ORDER BY sort_order`,
      [id]
    );
    const companyResult = await db.query(`SELECT name, admin_email FROM companies WHERE id = $1`, [req.companyId]);
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
      [id]
    );
    res.json(updateResult.rows[0]);
  } catch (err) {
    console.error("POST /admin/invoices/:id/send failed:", err);
    res.status(500).json({ error: err.message || "Couldn't send invoice." });
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

module.exports = router;