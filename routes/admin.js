const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const db = require("../db");
const { loginAdmin } = require("../utils/adminAuth");
const { hashPin } = require("../utils/auth");
const { generateResetToken, hashResetToken } = require("../utils/resetToken");
const { sendAdminPasswordResetEmail } = require("../utils/mailer");
const requireAdmin = require("../middleware/requireAdmin");
const { getPayPeriod } = require("../utils/payPeriod");

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
  const result = await db.query(
    `UPDATE employees SET ${fields.join(", ")} WHERE id = $${values.length - 1} AND company_id = $${values.length}
     RETURNING id, name, email, active, created_at`,
    values
  );
  if (result.rowCount === 0) return res.status(404).json({ error: "Employee not found" });
  res.json(result.rows[0]);
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
  const period = getPayPeriod(new Date());
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

module.exports = router;