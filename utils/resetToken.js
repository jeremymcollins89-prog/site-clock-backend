// utils/resetToken.js
//
// Shared helper for "forgot password" / "forgot PIN" reset links.
// A reset link contains the raw token; the database only ever stores its
// SHA-256 hash, so a leaked database dump alone can't be used to reset
// anyone's password or PIN.

const crypto = require("crypto");

function hashResetToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function generateResetToken() {
  const token = crypto.randomBytes(32).toString("hex");
  return { token, tokenHash: hashResetToken(token) };
}

module.exports = { generateResetToken, hashResetToken };
