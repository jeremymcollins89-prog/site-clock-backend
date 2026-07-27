const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET;

// The platform admin (Jeremy, and only Jeremy) is not a row in any table --
// unlike company admins, there's exactly one of these, ever, so it's just a
// pair of Railway env vars rather than its own signup/DB flow. Same pattern
// this codebase already uses for ADMIN_KEY on the create-employee route.
function checkPlatformCredentials(email, password) {
  const expectedEmail = process.env.PLATFORM_ADMIN_EMAIL;
  const expectedPassword = process.env.PLATFORM_ADMIN_PASSWORD;
  if (!expectedEmail || !expectedPassword) {
    throw new Error("Platform admin login isn't configured yet -- ask your developer to set PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD in Railway.");
  }
  return email === expectedEmail && password === expectedPassword;
}

function signPlatformToken() {
  return jwt.sign({ role: "platform" }, JWT_SECRET, { expiresIn: "180d" });
}

function verifyPlatformToken(token) {
  const payload = jwt.verify(token, JWT_SECRET);
  if (payload.role !== "platform") throw new Error("Not a platform token");
  return payload;
}

module.exports = { checkPlatformCredentials, signPlatformToken, verifyPlatformToken };
