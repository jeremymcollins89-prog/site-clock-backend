const express = require("express");
const router = express.Router();
const db = require("../db");
const { signAdminToken } = require("../utils/adminAuth");
const { hashPin } = require("../utils/auth");
const requireAdmin = require("../middleware/requireAdmin");

router.post("/login", async (req, res) => {
  const { admin_key } = req.body;
  if (admin_key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: "Incorrect admin key" });
  }
  res.json({ token: signAdminToken() });
});

router.use(requireAdmin);

router.get("/employees", async (req, res) => {
  const result = await db.query(
    `SELECT id, name, email, active, created_at FROM employees ORDER BY name`
  );
  res.json(result.rows);
});

router.post("/employees", async (req, res) => {
  const { name, email, pin } = req.body;
  if (!name || !email || !pin) {
    return res.status(400).json({ error: "name, email, and pin are required" });
  }
  const pin_hash = await hashPin(pin);
  const result = await db.query(
    `INSERT INTO employees (name, email, pin_hash) VALUES ($1, $2, $3)
     RETURNING id, name, email, active, created_at`,
    [name, email, pin_hash]
  );
  res.status(201).json(result.rows[0]);
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

  values.push(id);
  const result = await db.query(
    `UPDATE employees SET ${fields.join(", ")} WHERE id = $${values.length}
     RETURNING id, name, email, active, created_at`,
    values
  );
  if (result.rowCount === 0) return res.status(404).json({ error: "Employee not found" });
  res.json(result.rows[0]);
});

router.get("/time-entries", async (req, res) => {
  const { start, end, employee_id } = req.query;
  const conditions = [];
  const params = [];

  if (start) { params.push(start); conditions.push(`d.clock_in >= $${params.length}`); }
  if (end) { params.push(end); conditions.push(`d.clock_in <= $${params.length}`); }
  if (employee_id) { params.push(employee_id); conditions.push(`d.employee_id = $${params.length}`); }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await db.query(
    `SELECT d.*, e.name AS employee_name
     FROM time_entry_durations d
     JOIN employees e ON e.id = d.employee_id
     ${where}
     ORDER BY d.clock_in DESC`,
    params
  );
  res.json(result.rows);
});

router.patch("/time-entries/:id", async (req, res) => {
  const { id } = req.params;
  const { job_name, location_type, clock_in, clock_out } = req.body;

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
  if (result.rowCount === 0) return res.status(404).json({ error: "Time entry not found" });
  res.json(result.rows[0]);
});

router.get("/live-locations", async (req, res) => {
  const result = await db.query(
    `SELECT e.id AS employee_id, e.name, l.lat, l.lng, l.recorded_at, te.job_name, te.location_type
     FROM employees e
     JOIN time_entries te ON te.employee_id = e.id AND te.clock_out IS NULL
     LEFT JOIN employee_locations l ON l.employee_id = e.id
     WHERE l.recorded_at > now() - interval '15 minutes'
     ORDER BY e.name`
  );
  res.json(result.rows);
});

module.exports = router;