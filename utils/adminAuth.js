const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET;

function signAdminToken() {
  return jwt.sign({ role: "admin" }, JWT_SECRET, { expiresIn: "180d" });
}

function verifyAdminToken(token) {
  const payload = jwt.verify(token, JWT_SECRET);
  if (payload.role !== "admin") throw new Error("Not an admin token");
  return payload;
}

module.exports = { signAdminToken, verifyAdminToken };