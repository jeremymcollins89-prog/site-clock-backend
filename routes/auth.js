const express = require("express");
const router = express.Router();
const db = require("../db");
const { signToken, hashPin, comparePin } = require("../utils/auth");
const { generateResetToken, hashResetToken } = require("../utils/resetToken");
const { sendEmployeePinResetEmail } = require("../utils/mailer");

// POST /api/auth/login
// Body: { name, pin }
// Called once per device, the first time an employee opens the app.
// Returns a long-lived token the app stores locally so they never have
// to re-enter their PIN on that device again.
router.post("/login", async (req, res) => {
  const { email, pin } = req.body;
  if (!email || !pin) {
    return res.status(400).json({ error: "email and pin are required" });
  }

  const result = await db.query(
    `SELECT e.*, c.shop_lat, c.shop_lng, c.shop_radius_m, c.auto_clockout_time
     FROM employees e
     LEFT JOIN companies c ON c.id = e.company_id
     WHERE e.email = $1 AND e.active = true`,
    [email]
  );
  if (result.rowCount === 0) {
    return res.status(401).json({ error: "Unknown employee email" });
  }

  const employee = result.rows[0];
  const valid = await comparePin(pin, employee.pin_hash);
  if (!valid) {
    return res.status(401).json({ error: "Incorrect PIN" });
  }

  const token = signToken(employee);
  res.json({
    token,
    employee: {
      id: employee.id,
      name: employee.name,
      email: employee.email,
      shop_lat: employee.shop_lat,
      shop_lng: employee.shop_lng,
      shop_radius_m: employee.shop_radius_m,
      auto_clockout_time: employee.auto_clockout_time,
    },
  });
});

// POST /api/auth/forgot-pin
// Body: { email }
// Public — no auth required, since the whole point is recovering access.
// Always responds the same way whether or not the email exists, so this
// endpoint can't be used to find out which emails have accounts.
router.post("/forgot-pin", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "email is required" });

  const result = await db.query(
    `SELECT id, name FROM employees WHERE email = $1 AND active = true`,
    [email]
  );
  if (result.rowCount > 0) {
    const employee = result.rows[0];
    const { token, tokenHash } = generateResetToken();
    await db.query(
      `UPDATE employees SET reset_token_hash = $1, reset_token_expires = now() + interval '1 hour' WHERE id = $2`,
      [tokenHash, employee.id]
    );
    try {
      await sendEmployeePinResetEmail({ to: email, name: employee.name, token });
    } catch (err) {
      console.error("Failed to send PIN reset email:", err.message);
    }
  }
  res.json({ message: "If that email has an account, a reset link has been sent." });
});

// POST /api/auth/reset-pin
// Body: { token, new_pin }
// Public — the token itself (emailed via forgot-pin) is the proof of identity.
router.post("/reset-pin", async (req, res) => {
  const { token, new_pin } = req.body;
  if (!token || !new_pin) {
    return res.status(400).json({ error: "token and new_pin are required" });
  }

  const tokenHash = hashResetToken(token);
  const result = await db.query(
    `SELECT id FROM employees WHERE reset_token_hash = $1 AND reset_token_expires > now()`,
    [tokenHash]
  );
  if (result.rowCount === 0) {
    return res.status(400).json({ error: "This reset link is invalid or has expired" });
  }

  const pin_hash = await hashPin(new_pin);
  await db.query(
    `UPDATE employees SET pin_hash = $1, reset_token_hash = NULL, reset_token_expires = NULL WHERE id = $2`,
    [pin_hash, result.rows[0].id]
  );
  res.json({ message: "PIN updated. You can now log in." });
});

// GET /api/auth/me  — lets the app verify a stored token is still valid
// on launch, and get fresh employee info, without re-prompting for a PIN.
const requireAuth = require("../middleware/requireAuth");
router.get("/me", requireAuth, async (req, res) => {
  const result = await db.query(
    `SELECT e.id, e.name, e.email, c.shop_lat, c.shop_lng, c.shop_radius_m, c.auto_clockout_time
     FROM employees e
     LEFT JOIN companies c ON c.id = e.company_id
     WHERE e.id = $1`,
    [req.employee.employee_id]
  );
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
