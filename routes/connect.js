const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const db = require("../db");
const stripe = require("../utils/stripeClient");
const requireAdmin = require("../middleware/requireAdmin");

const JWT_SECRET = process.env.JWT_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL || "https://site-clock-frontend-production.up.railway.app";
const BACKEND_URL = process.env.BACKEND_URL || "https://site-clock-backend-production.up.railway.app";

// GET /api/connect/status
// Admin-authenticated. Tells the Billing settings screen whether this
// company has already connected a Stripe account, so it can show
// "Connected" vs a "Connect Stripe" button.
router.get("/status", requireAdmin, async (req, res) => {
  const result = await db.query(`SELECT stripe_connect_status FROM companies WHERE id = $1`, [req.companyId]);
  res.json({ connected: result.rows[0] && result.rows[0].stripe_connect_status === "connected" });
});

// Builds a fresh Stripe onboarding link for a company -- creating the
// underlying Stripe connected account first if this is its very first time
// through (a Standard account, so it gets its own full Stripe Dashboard).
// Shared by /start (the initial click) and /refresh (Stripe sends the
// browser back here if a link expired or was already used), since both
// need the exact same "get me a fresh link" logic.
async function buildOnboardingLink(companyId) {
  const result = await db.query(`SELECT stripe_account_id FROM companies WHERE id = $1`, [companyId]);
  if (result.rowCount === 0) throw new Error("Company not found");

  let accountId = result.rows[0].stripe_account_id;
  if (!accountId) {
    const account = await stripe.accounts.create({ type: "standard" });
    accountId = account.id;
    await db.query(`UPDATE companies SET stripe_account_id = $1 WHERE id = $2`, [accountId, companyId]);
  }

  // A signed, short-lived token (not the admin's real session token) is how
  // /refresh and /return -- both hit by a plain browser redirect coming
  // from Stripe, with no Authorization header of their own -- know which
  // company this onboarding attempt belongs to.
  const token = jwt.sign({ purpose: "stripe_connect", company_id: companyId }, JWT_SECRET, { expiresIn: "30m" });

  const accountLink = await stripe.accountLinks.create({
    account: accountId,
    type: "account_onboarding",
    refresh_url: `${BACKEND_URL}/api/connect/refresh?token=${token}`,
    return_url: `${BACKEND_URL}/api/connect/return?token=${token}`,
  });

  return accountLink.url;
}

function verifyConnectToken(token) {
  const payload = jwt.verify(token, JWT_SECRET);
  if (payload.purpose !== "stripe_connect" || !payload.company_id) throw new Error("Not a Stripe Connect token");
  return payload;
}

// GET /api/connect/start
// Admin-authenticated. Returns Stripe's onboarding URL for this company to
// open in a real browser tab (Stripe's onboarding form has to run in a
// full top-level page, not an embedded webview or an XHR).
router.get("/start", requireAdmin, async (req, res) => {
  try {
    const url = await buildOnboardingLink(req.companyId);
    res.json({ url });
  } catch (err) {
    console.error("GET /connect/start failed:", err);
    res.status(500).json({ error: "Couldn't start Stripe connection. Please try again." });
  }
});

// GET /api/connect/refresh
// Public -- Stripe redirects the browser here (not our own app calling
// it) if an onboarding link expired (they only last a few minutes) or was
// already used (e.g. the person hit back or refreshed). Just builds a
// fresh one and sends them straight back in, so this path is invisible to
// the person actually connecting.
router.get("/refresh", async (req, res) => {
  try {
    const payload = verifyConnectToken(req.query.token);
    const url = await buildOnboardingLink(payload.company_id);
    res.redirect(url);
  } catch (err) {
    console.error("GET /connect/refresh failed:", err.message);
    res.redirect(`${FRONTEND_URL}/connect-result.html?status=error&reason=expired`);
  }
});

// GET /api/connect/return
// Public -- Stripe redirects the browser here once the person exits the
// onboarding flow, whether or not they actually finished it. Per Stripe's
// own guidance, reaching this URL doesn't by itself mean onboarding is
// complete -- the only reliable check is to look up the account and see
// whether charges_enabled is true, which is what this does before marking
// the company as connected.
router.get("/return", async (req, res) => {
  try {
    const payload = verifyConnectToken(req.query.token);
    const companyResult = await db.query(`SELECT stripe_account_id FROM companies WHERE id = $1`, [payload.company_id]);
    const accountId = companyResult.rows[0] && companyResult.rows[0].stripe_account_id;
    if (!accountId) throw new Error("No connected account on file for this company");

    const account = await stripe.accounts.retrieve(accountId);
    if (account.charges_enabled) {
      await db.query(`UPDATE companies SET stripe_connect_status = 'connected' WHERE id = $1`, [payload.company_id]);
      return res.redirect(`${FRONTEND_URL}/connect-result.html?status=success`);
    }
    // They exited onboarding before Stripe finished verifying them (or
    // backed out partway through) -- don't claim they're connected when
    // they're not; send them to a page that explains that instead.
    res.redirect(`${FRONTEND_URL}/connect-result.html?status=error&reason=incomplete`);
  } catch (err) {
    console.error("GET /connect/return failed:", err.message);
    res.redirect(`${FRONTEND_URL}/connect-result.html?status=error&reason=failed`);
  }
});

module.exports = router;
