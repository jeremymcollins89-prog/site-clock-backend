const { verifyPlatformToken } = require("../utils/platformAuth");

function requirePlatformAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });
  try {
    verifyPlatformToken(token);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired platform token" });
  }
}

module.exports = requirePlatformAuth;
