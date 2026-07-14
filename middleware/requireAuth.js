const { verifyToken } = require("../utils/auth");

// Reads "Authorization: Bearer <token>", verifies it, and attaches
// req.employee = { employee_id, name }. Every time-clock route the
// employee's own app calls should sit behind this — never trust an
// employee_id passed in the request body, since anyone could edit it.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: "Missing token" });
  }
  try {
    req.employee = verifyToken(token);
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

module.exports = requireAuth;
