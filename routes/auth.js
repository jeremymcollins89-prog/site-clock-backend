const express = require("express");
const router = express.Router();
const db = require("../db");
const { signToken, hashPin, comparePin } = require("../utils/auth");
const { generateResetToken, hashResetToken } = require("../utils/resetToken");
const { sendEmployeePinResetEmail } = require("../utils/mailer");
const loginRateLimit = require("../middleware/loginRateLimit");
const requireAuth = require("../middleware/requireAuth"); // also used below by GET /me

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
        can_manage_inventory: employee.can_manage_inventory,
      },
    });
  } catch (err) {
    console.error("POST /auth/login failed:", err);
    res.status(500).json({ error: "Couldn't log in. Please try again." });
  }
});

// POST /api/auth/activity-ping
// Authenticated. Fired by the employee app on any click while logged in
// (see the global click listener in App.jsx), purely so requireAuth's
// throttled last_active_at bump (see middleware/requireAuth.js) runs even
// during a long session that never happens to call another endpoint --
// there's nothing else to do here, requireAuth already did the actual work
// before this handler even runs.
router.post("/activity-ping", requireAuth, (req, res) => {
  res.json({ ok: true });
});

// POST /api/auth/snake-score
// Body: { score }
// Authenticated. Fed by the hidden Snake easter egg's game-over handler.
// Upserts this employee's personal best (name/company snapshotted fresh each
// time) -- GREATEST means a lower score than their existing best never
// overwrites it, so this is safe to call after every game, not just new
// records. Returns their (possibly-unchanged) personal best so the frontend
// can trust the server's number over its own optimistic local one.
router.post("/snake-score", requireAuth, async (req, res) => {
  try {
    const score = Math.round(Number(req.body.score));
    if (!Number.isFinite(score) || score < 0 || score > 5000) {
      return res.status(400).json({ error: "Invalid score" });
    }
    const empResult = await db.query(
      `SELECT e.name, co.name AS company_name
       FROM employees e
       LEFT JOIN companies co ON co.id = e.company_id
       WHERE e.id = $1`,
      [req.employee.employee_id]
    );
    if (empResult.rowCount === 0) return res.status(404).json({ error: "Employee not found" });
    const { name, company_name } = empResult.rows[0];

    const result = await db.query(
      `INSERT INTO snake_scores (employee_id, employee_name, company_name, best_score)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (employee_id) DO UPDATE SET
         best_score = GREATEST(snake_scores.best_score, EXCLUDED.best_score),
         employee_name = EXCLUDED.employee_name,
         company_name = EXCLUDED.company_name,
         updated_at = now()
       RETURNING best_score`,
      [req.employee.employee_id, name, company_name, score]
    );
    res.json({ best_score: result.rows[0].best_score });
  } catch (err) {
    console.error("POST /auth/snake-score failed:", err);
    res.status(500).json({ error: "Couldn't save score." });
  }
});

// GET /api/auth/snake-leaderboard
// Authenticated (any logged-in employee at any company can see it -- that's
// the whole point of a platform-wide leaderboard). Top 10 personal bests,
// highest first.
router.get("/snake-leaderboard", requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT employee_name, company_name, best_score
       FROM snake_scores
       ORDER BY best_score DESC, updated_at ASC
       LIMIT 10`
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /auth/snake-leaderboard failed:", err);
    res.status(500).json({ error: "Couldn't load leaderboard." });
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
router.get("/me", requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT e.id, e.name, e.email, e.clock_in_animation, e.break_minutes, e.can_manage_inventory, c.shop_lat, c.shop_lng, c.shop_radius_m, c.auto_clockout_time, c.auto_clockin_time
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

// PATCH /api/auth/clock-in-animation
// Body: { clock_in_animation }
// Authenticated. Lets an employee pick their own clock-in celebration --
// previously this was admin-only (set from the employee's row in the admin
// app's Employees section), but an employee can now override it for
// themselves. Whitelist duplicated from routes/admin.js's
// CLOCK_IN_ANIMATIONS -- no shared constants module exists yet, so keep
// both lists in sync if it ever changes.
const CLOCK_IN_ANIMATIONS = ["none", "fireworks", "birthday", "rocket", "fall", "easter", "christmas"];
router.patch("/clock-in-animation", requireAuth, async (req, res) => {
  try {
    const { clock_in_animation } = req.body;
    if (!CLOCK_IN_ANIMATIONS.includes(clock_in_animation)) {
      return res.status(400).json({ error: "Invalid clock_in_animation" });
    }
    await db.query(`UPDATE employees SET clock_in_animation = $1 WHERE id = $2`, [clock_in_animation, req.employee.employee_id]);
    res.json({ clock_in_animation });
  } catch (err) {
    console.error("PATCH /auth/clock-in-animation failed:", err);
    res.status(500).json({ error: "Couldn't save your choice." });
  }
});

module.exports = router;
