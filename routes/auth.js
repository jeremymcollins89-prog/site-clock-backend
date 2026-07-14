const express = require("express");
const router = express.Router();
const db = require("../db");
const { signToken, hashPin, comparePin } = require("../utils/auth");

// POST /api/auth/login
// Body: { name, pin }
// Called once per device, the first time an employee opens the app.
// Returns a long-lived token the app stores locally so they never have
// to re-enter their PIN on that device again.
router.post("/login", async (req, res) => {
  const { name, pin } = req.body;
  if (!name || !pin) {
    return res.status(400).json({ error: "name and pin are required" });
  }

  const result = await db.query(
    `SELECT * FROM employees WHERE name = $1 AND active = true`,
    [name]
  );
  if (result.rowCount === 0) {
    return res.status(401).json({ error: "Unknown employee name" });
  }

  const employee = result.rows[0];
  const valid = await comparePin(pin, employee.pin_hash);
  if (!valid) {
    return res.status(401).json({ error: "Incorrect PIN" });
  }

  const token = signToken(employee);
  res.json({ token, employee: { id: employee.id, name: employee.name, email: employee.email } });
});

// GET /api/auth/me  — lets the app verify a stored token is still valid
// on launch, and get fresh employee info, without re-prompting for a PIN.
const requireAuth = require("../middleware/requireAuth");
router.get("/me", requireAuth, async (req, res) => {
  const result = await db.query(`SELECT id, name, email FROM employees WHERE id = $1`, [
    req.employee.employee_id,
  ]);
  if (result.rowCount === 0) return res.status(404).json({ error: "Employee not found" });
  res.json(result.rows[0]);
});

// POST /api/auth/admin/create-employee
// Body: { name, email, pin, admin_key }
// You (the owner) run this once per new hire, e.g. from a simple admin
// screen or curl command, to issue their initial PIN.
router.post("/admin/create-employee", async (req, res) => {
  const { name, email, pin, admin_key } = req.body;
  if (admin_key !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: "Invalid admin key" });
  }
  if (!name || !email || !pin) {
    return res.status(400).json({ error: "name, email, and pin are required" });
  }

  const pin_hash = await hashPin(pin);
  const result = await db.query(
    `INSERT INTO employees (name, email, pin_hash) VALUES ($1, $2, $3) RETURNING id, name, email`,
    [name, email, pin_hash]
  );
  res.status(201).json(result.rows[0]);
});

module.exports = router;
