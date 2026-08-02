const express = require("express");
const router = express.Router();
const db = require("../db");
const bcrypt = require("bcrypt");
const { signAdminToken } = require("../utils/adminAuth");
const loginRateLimit = require("../middleware/loginRateLimit");

// Rate-limited like every other password-checking endpoint -- signup runs a
// real bcrypt hash (~250ms of CPU) and reveals via its 409 whether an email
// is already registered, so it shouldn't be free to hammer.
router.post("/signup", loginRateLimit, async (req, res) => {
  try {
    const { company_name, admin_email, admin_password } = req.body;
    if (!company_name || !admin_email || !admin_password) {
      return res.status(400).json({ error: "company_name, admin_email, and admin_password are required" });
    }
    const existing = await db.query(`SELECT id FROM companies WHERE admin_email = $1`, [admin_email]);
    if (existing.rowCount > 0) {
      return res.status(409).json({ error: "An account with that email already exists" });
    }
    const password_hash = await bcrypt.hash(admin_password, 12);
    // last_active_at is set right at creation -- signing up is itself a real
    // use of the app, not a "never used" account waiting on some later login
    // to register. Without this, a brand-new company would show as dormant
    // on the platform dashboard until its very next authenticated request.
    const result = await db.query(
      `INSERT INTO companies (name, admin_email, admin_password_hash, last_active_at)
       VALUES ($1, $2, $3, now()) RETURNING id, name, admin_email`,
      [company_name, admin_email, password_hash]
    );
    const company = result.rows[0];
    const token = signAdminToken(company.id);
    res.status(201).json({ token, company });
  } catch (err) {
    console.error("POST /companies/signup failed:", err);
    res.status(500).json({ error: "Couldn't create account. Please try again." });
  }
});

module.exports = router;
