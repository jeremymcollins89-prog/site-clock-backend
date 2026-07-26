const Stripe = require("stripe");

// STRIPE_SECRET_KEY lives in Railway's env vars, never committed. If it's
// missing or invalid, this must NOT throw here -- this file is required at
// server startup (via routes/payments.js), so an exception here would crash
// the entire backend, not just the payment routes. Instead, fall back to a
// stub whose methods only throw once something actually tries to use them
// (e.g. a customer clicking "Pay now"), so a misconfigured Stripe key can
// only ever break payments, never the whole app -- this is exactly the bug
// that took down every route on 2026-07-26.
let stripe;
try {
  stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "");
} catch (err) {
  console.error("Stripe client failed to initialize (check STRIPE_SECRET_KEY):", err.message);
  stripe = new Proxy(
    {},
    {
      get() {
        throw new Error("Stripe isn't configured yet (STRIPE_SECRET_KEY is missing or invalid).");
      },
    }
  );
}

module.exports = stripe;
