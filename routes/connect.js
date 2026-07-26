const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const db = require("../db");
const stripe = require("../utils/stripeClient");
const requireAdmin = require("../middleware/requireAdmin");

const JWT_SECRET = process.env.JWT_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL || "https://site-clock-frontend-production.up.railway.app";
const BACKEND_URL = process.env.BACKEND_URL || "https://site-clock-backend-production.up.railway.app";
const STRIPE_CONNECT_CLIENT_ID = process.env.STRIPE_CONNECT_CLIENT_ID;

// GET /api/connect/status
// Admin-authenticated. Tells the Billing settings screen whether this
// company has already connected a Stripe account, so it can show
// "Connected" vs a "Connect Stripe" button.
router.get("/status", requireAdmin, async (req, res) => {
  const result = await db.query(`SELECT stripe_connect_status FROM companies WHERE id = $1`, [req.companyId]);
  res.json({ connected: result.rows[0] && result.rows[0].stripe_connect_status === "connected" });
});

// GET /api/connect/start
// Admin-authenticated. Returns Stripe's "Connect with Stripe" authorize URL
// for this company to open in a browser (a real page navigation, not an
// XHR -- Stripe's own onboarding form has to run in a full browser tab).
// Since that navigation can't carry an Authorization header, the company's
// id is embedded in a short-lived signed `state` token instead -- a
// different token than the admin's real session token, scoped to only this
// one purpose, so it can't be reused for anything else if it leaked.
router.get("/start", requireAdmin, (req, res) => {
  if (!STRIPE_CONNECT_CLIENT_ID) {
    return res.status(500).json({ error: "Stripe Connect isn't set up on the server yet." });
  }
  const state = jwt.sign({ purpose: "stripe_connect", company_id: req.companyId }, JWT_SECRET, { expiresIn: "15m" });
  const params = new URLSearchParams({
    response_type: "code",
    client_id: STRIPE_CONNECT_CLIENT_ID,
    scope: "read_write",
    redirect_uri: `${BACKEND_URL}/api/connect/callback`,
    state,
  });
  res.json({ url: `https://connect.stripe.com/oauth/authorize?${params.toString()}` });
});

// GET /api/connect/callback
// Public -- this is Stripe redirecting the business owner's browser back
// after they finish onboarding on Stripe's site, not an API call from our
// own app, so there's no Authorization header to check. The `state` value
// (signed above) is what proves which company this is and that it was us
// who started the flow, not someone guessing at the URL.
router.get("/callback", async (req, res) => {
  const { code, state, error: stripeError } = req.query;

  if (stripeError) {
    // The business owner backed out of Stripe's onboarding, or denied
    // access, before finishing.
    return res.redirect(`${FRONTEND_URL}/connect-result.html?status=error&reason=cancelled`);
  }

  let payload;
  try {
    payload = jwt.verify(state, JWT_SECRET);
    if (payload.purpose !== "stripe_connect" || !payload.company_id) throw new Error("bad state");
  } catch (err) {
    return res.redirect(`${FRONTEND_URL}/connect-result.html?status=error&reason=expired`);
  }

  try {
    const tokenResponse = await stripe.oauth.token({
      grant_type: "authorization_code",
      code,
    });
    await db.query(
      `UPDATE companies SET stripe_account_id = $1, stripe_connect_status = 'connected' WHERE id = $2`,
      [tokenResponse.stripe_user_id, payload.company_id]
    );
    res.redirect(`${FRONTEND_URL}/connect-result.html?status=success`);
  } catch (err) {
    console.error("Stripe Connect OAuth exchange failed:", err.message);
    res.redirect(`${FRONTEND_URL}/connect-result.html?status=error&reason=failed`);
  }
});

module.exports = router;
