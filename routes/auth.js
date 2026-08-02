const express = require("express");
const router = express.Router();
const db = require("../db");
const { signToken, hashPin, comparePin } = require("../utils/auth");
const { generateResetToken, hashResetToken } = require("../utils/resetToken");
const { sendEmployeePinResetEmail } = require("../utils/mailer");
const loginRateLimit = require("../middleware/loginRateLimit");

// POST /api/auth/login
// Body: { name, pin }
// Called once per device, the first time an employee opens the app.
// Returns a long-lived token the app stores locally so they never have
// to re-enter their PIN on that device again.
router.post("/login", loginRateLimit, async (req, res) => {
  try {
    const { email, pin } = req.body;
    if (!email || !pin) {
      return res.status(400).json({ error: "email and pin are required" });
    }

    const result = await db.query(
      `SELECT e.*, c.shop_lat, c.shop_lng, c.shop_radius_m, c.auto_clockout_time, c.auto_clockin_time
       FROM employees e
       LEFT JOIN companies c ON c.id = e.company_id
       WHERE e.email = $1 AND e.active = true`,
      [email]
    );
    if (result.rowCount === 0) {
      return res.status(401).json({ error: "Unknown employee email" });
    }

    // The same email can belong to employees at more than one company (emails
    // are only unique within a single company's roster), so check each
    // candidate's PIN rather than assuming the first row returned is correct.
    let employee = null;
    for (const candidate of result.rows) {
      if (await comparePin(pin, candidate.pin_hash)) {
        employee = candidate;
        break;
      }
    }
    if (!employee) {
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
        auto_clockin_time: employee.auto_clockin_time,
        clock_in_animation: employee.clock_in_animation,
        break_minutes: employee.break_minutes,
      },
    });
  } catch (err) {
    console.error("POST /auth/login failed:", err);
    res.status(500).json({ error: "Couldn't log in. Please try again." });
  }
});

// POST /api/auth/forgot-pin
// Body: { email }
// Public — no auth required, since the whole point is recovering access.
// Always responds the same way whether or not the email exists, so this
// endpoint can't be used to find out which emails have accounts.
router.post("/forgot-pin", loginRateLimit, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "email is required" });

    // An email can now match employees at more than one company, so every
    // matching employee gets their own reset token and their own email --
    // tagged with the company name when there's more than one, so it's clear
    // which account each link resets.
    const result = await db.query(
      `SELECT e.id, e.name, c.name AS company_name
       FROM employees e
       LEFT JOIN companies c ON c.id = e.company_id
       WHERE e.email = $1 AND e.active = true`,
      [email]
    );

    for (const employee of result.rows) {
      const { token, tokenHash } = generateResetToken();
      await db.query(
        `UPDATE employees SET reset_token_hash = $1, reset_token_expires = now() + interval '1 hour' WHERE id = $2`,
        [tokenHash, employee.id]
      );
      try {
        await sendEmployeePinResetEmail({
          to: email,
          name: employee.name,
          token,
          companyName: result.rows.length > 1 ? employee.company_name : null,
        });
      } catch (err) {
        console.error("Failed to send PIN reset email:", err.message);
      }
    }
    res.json({ message: "If that email has an account, a reset link has been sent." });
  } catch (err) {
    console.error("POST /auth/forgot-pin failed:", err);
    res.status(500).json({ error: "Couldn't process that request. Please try again." });
  }
});

// POST /api/auth/reset-pin
// Body: { token, new_pin }
// Public — the token itself (emailed via forgot-pin) is the proof of identity.
router.post("/reset-pin", loginRateLimit, async (req, res) => {
  try {
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
  } catch (err) {
    console.error("POST /auth/reset-pin failed:", err);
    res.status(500).json({ error: "Couldn't update PIN. Please try again." });
  }
});

// GET /api/auth/me  — lets the app verify a stored token is still valid
// on launch, and get fresh employee info, without re-prompting for a PIN.
const requireAuth = require("../middleware/requireAuth");
router.get("/me", requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT e.id, e.name, e.email, e.clock_in_animation, e.break_minutes, c.shop_lat, c.shop_lng, c.shop_radius_m, c.auto_clockout_time, c.auto_clockin_time
       FROM employees e
       LEFT JOIN companies c ON c.id = e.company_id
       WHERE e.id = $1`,
      [req.employee.employee_id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "Employee not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("GET /auth/me failed:", err);
    res.status(500).json({ error: "Couldn't load employee info." });
  }
});

module.exports = router;
