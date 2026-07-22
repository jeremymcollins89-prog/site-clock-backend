const express = require("express");
const router = express.Router();
const db = require("../db");
const bcrypt = require("bcrypt");
const { signAdminToken } = require("../utils/adminAuth");

router.post("/signup", async (req, res) => {
  const { company_name, admin_email, admin_password } = req.body;
  if (!company_name || !admin_email || !admin_password) {
    return res.status(400).json({ error: "company_name, admin_email, and admin_password are required" });
  }
  const existing = await db.query(`SELECT id FROM companies WHERE admin_email = $1`, [admin_email]);
  if (existing.rowCount > 0) {
    return res.status(409).json({ error: "An account with that email already exists" });
  }
  const password_hash = await bcrypt.hash(admin_password, 12);
  const result = await db.query(
    `INSERT INTO companies (name, admin_email, admin_password_hash)
     VALUES ($1, $2, $3) RETURNING id, name, admin_email`,
    [company_name, admin_email, password_hash]
  );
  const company = result.rows[0];
  const token = signAdminToken(company.id);
  res.status(201).json({ token, company });
});

module.exports = router;
