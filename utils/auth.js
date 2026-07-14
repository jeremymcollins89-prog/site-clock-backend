const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");

const JWT_SECRET = process.env.JWT_SECRET; // set a long random string in env
const TOKEN_TTL = "180d"; // employees stay logged in on their own device for months

function signToken(employee) {
  return jwt.sign(
    { employee_id: employee.id, name: employee.name },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET); // throws if invalid/expired
}

async function hashPin(pin) {
  return bcrypt.hash(pin, 12);
}

async function comparePin(pin, hash) {
  return bcrypt.compare(pin, hash);
}

module.exports = { signToken, verifyToken, hashPin, comparePin };
