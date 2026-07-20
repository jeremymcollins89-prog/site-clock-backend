const { verifyAdminToken } = require("../utils/adminAuth");

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });
  try {
    verifyAdminToken(token);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired admin token" });
  }
}

module.exports = requireAdmin;
