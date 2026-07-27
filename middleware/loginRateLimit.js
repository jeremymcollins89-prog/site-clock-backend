const rateLimit = require("express-rate-limit");

// Applied to every endpoint that checks a password, PIN, or reset token
// (employee login, company admin login, platform admin login, and both
// forgot/reset flows) so guessing one is no longer free. 10 attempts per
// IP per 15 minutes is generous enough that a real person mistyping their
// PIN a few times never notices, but stops scripted brute-forcing, which
// today has nothing in its way. Requires app.set("trust proxy", 1) in
// server.js so req.ip reflects the real client rather than Railway's proxy.
const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts from this connection. Please wait 15 minutes and try again." },
});

module.exports = loginRateLimit;
