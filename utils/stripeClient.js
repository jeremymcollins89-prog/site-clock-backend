const Stripe = require("stripe");

// STRIPE_SECRET_KEY lives in Railway's env vars, never committed. Left empty
// here just so requiring this file doesn't crash before it's configured --
// any actual API call will fail with a clear Stripe error in that case
// rather than this file throwing at startup.
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "");

module.exports = stripe;
