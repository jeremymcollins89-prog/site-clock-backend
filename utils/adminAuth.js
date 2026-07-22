const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const db = require("../db");

const JWT_SECRET = process.env.JWT_SECRET;

function signAdminToken(companyId) {
  return jwt.sign({ role: "admin", company_id: companyId }, JWT_SECRET, { expiresIn: "180d" });
}

function verifyAdminToken(token) {
  const payload = jwt.verify(token, JWT_SECRET);
  if (payload.role !== "admin") throw new Error("Not an admin token");
  return payload;
}

async function loginAdmin(email, password) {
  const result = await db.query(`SELECT * FROM companies WHERE admin_email = $1`, [email]);
  if (result.rowCount === 0) throw new Error("Invalid email or password");
  const company = result.rows[0];
  const valid = await bcrypt.compare(password, company.admin_password_hash);
  if (!valid) throw new Error("Invalid email or password");
  return { token: signAdminToken(company.id), company: { id: company.id, name: company.name } };
}

module.exports = { signAdminToken, verifyAdminToken, loginAdmin };