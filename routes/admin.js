const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const db = require("../db");
const { loginAdmin } = require("../utils/adminAuth");
const { hashPin } = require("../utils/auth");
const { generateResetToken, hashResetToken } = require("../utils/resetToken");
const { sendAdminPasswordResetEmail, sendInvoiceEmail, sendQuoteEmail, sendPaymentReceiptEmail, sendEmployeeWelcomeEmail } = require("../utils/mailer");
const { renderInvoicePdf, renderQuotePdf, renderPullSheetPdf } = require("../utils/invoicePdf");
const requireAdmin = require("../middleware/requireAdmin");
const loginRateLimit = require("../middleware/loginRateLimit");
const { getPayPeriod, PAY_FREQUENCIES } = require("../utils/payPeriod");
const { JOB_COLORS } = require("../utils/jobColors");
const { sendPushToEmployee } = require("../utils/webPush");
const { geocodeAddress, suggestAddresses } = require("../utils/geocode");
const { optimizeStopOrder, buildGoogleMapsUrl } = require("../utils/routeOptimize");
const { placeHoldsForLineItems, releaseHoldsForLineItems, consumeInventoryForLineItems, checkLowStock, consumeRemainingAfterPulls, getPulledQuantities } = require("../utils/inventory");

const EVENT_TYPES = ["job", "personal", "other", "time_off"];
const TIME_OFF_STATUSES = ["approved", "denied"];
const QUOTE_STATUSES = ["draft", "sent", "accepted", "declined"];
const PAYMENT_TERMS = ["due_on_receipt", "net_15", "net_30", "net_60", "net_90"];
const PAYMENT_TERMS_DAYS = { due_on_receipt: 0, net_15: 15, net_30: 30, net_60: 60, net_90: 90 };
// "online" isn't in this list on purpose -- it's only ever set by the Stripe
// webhook (see routes/payments.js), never a manual "Mark as paid" option.
const PAYMENT_METHODS = ["card", "check", "cash", "other"];
// Hard cap on how many separate payments (partial or otherwise) an invoice
// can ever collect, whether recorded manually or paid online through Stripe.
// A normal (non-partial) invoice only ever uses 1 of these.
const MAX_INVOICE_PAYMENTS = 4;
const FRONTEND_URL = process.env.FRONTEND_URL || "https://site-clock-frontend-production.up.railway.app";

// Every company -- including Jeremy's own -- must connect its own Stripe
// account (see routes/connect.js) before its invoices get a Pay Now link.
// There's no platform-account fallback for anyone: see routes/payments.js
// for why that would be a self-referential mess (an application fee on a
// charge to your own account).
function canAcceptOnlinePayments(stripeConnectStatus) {
  return stripeConnectStatus === "connected";
}

router.post("/login", loginRateLimit, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }
  try {
    const result = await loginAdmin(email, password);
    res.json(result);
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

// POST /api/admin/forgot-password
// Body: { email }
// Public — no auth required, since the whole point is recovering access.
// Always responds the same way whether or not the email exists, so this
// endpoint can't be used to find out which emails have accounts.
router.post("/forgot-password", loginRateLimit, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "email is required" });

  const result = await db.query(`SELECT id FROM companies WHERE admin_email = $1`, [email]);
  if (result.rowCount > 0) {
    const { token, tokenHash } = generateResetToken();
    await db.query(
      `UPDATE companies SET reset_token_hash = $1, reset_token_expires = now() + interval '1 hour' WHERE id = $2`,
      [tokenHash, result.rows[0].id]
    );
    try {
      await sendAdminPasswordResetEmail({ to: email, token });
    } catch (err) {
      console.error("Failed to send admin password reset email:", err.message);
    }
  }
  res.json({ message: "If that email has an account, a reset link has been sent." });
});

// POST /api/admin/reset-password
// Body: { token, new_password }
// Public — the token itself (emailed via forgot-password) is the proof of
// identity here.
router.post("/reset-password", loginRateLimit, async (req, res) => {
  const { token, new_password } = req.body;
  if (!token || !new_password) {
    return res.status(400).json({ error: "token and new_password are required" });
  }
  if (new_password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }

  const tokenHash = hashResetToken(token);
  const result = await db.query(
    `SELECT id FROM companies WHERE reset_token_hash = $1 AND reset_token_expires > now()`,
    [tokenHash]
  );
  if (result.rowCount === 0) {
    return res.status(400).json({ error: "This reset link is invalid or has expired" });
  }

  const password_hash = await bcrypt.hash(new_password, 12);
  await db.query(
    `UPDATE companies SET admin_password_hash = $1, reset_token_hash = NULL, reset_token_expires = NULL WHERE id = $2`,
    [password_hash, result.rows[0].id]
  );
  res.json({ message: "Password updated. You can now log in." });
});

router.use(requireAdmin);

// POST /api/admin/activity-ping
// Body: none. Fired by the frontend on any click while logged in (see the
// global click listener in each app), purely so requireAdmin's throttled
// last_active_at bump (see middleware/requireAdmin.js) runs even during a
// long session that never happens to load new data -- there's nothing else
// to do here, requireAdmin already did the actual work before this handler
// even runs.
router.post("/activity-ping", (req, res) => {
  res.json({ ok: true });
});

// POST /api/admin/change-password
// Body: { current_password, new_password }
// Authenticated — for an admin who's already logged in and knows their
// current password, but wants to update it.
router.post("/change-password", async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) {
    return res.status(400).json({ error: "current_password and new_password are required" });
  }
  if (new_password.length < 8) {
    return res.status(400).json({ error: "New password must be at least 8 characters" });
  }

  const result = await db.query(`SELECT admin_password_hash FROM companies WHERE id = $1`, [req.companyId]);
  if (result.rowCount === 0) return res.status(404).json({ error: "Company not found" });

  const valid = await bcrypt.compare(current_password, result.rows[0].admin_password_hash);
  if (!valid) return res.status(401).json({ error: "Current password is incorrect" });

  const password_hash = await bcrypt.hash(new_password, 12);
  await db.query(`UPDATE companies SET admin_password_hash = $1 WHERE id = $2`, [password_hash, req.companyId]);
  res.json({ message: "Password updated" });
});

// POST /api/admin/change-email
// Body: { new_email, current_password }
// Authenticated — requires the current password as proof, since the email
// doubles as the admin login username.
router.post("/change-email", async (req, res) => {
  const { new_email, current_password } = req.body;
  if (!new_email || !current_password) {
    return res.status(400).json({ error: "new_email and current_password are required" });
  }

  const result = await db.query(`SELECT admin_password_hash FROM companies WHERE id = $1`, [req.companyId]);
  if (result.rowCount === 0) return res.status(404).json({ error: "Company not found" });

  const valid = await bcrypt.compare(current_password, result.rows[0].admin_password_hash);
  if (!valid) return res.status(401).json({ error: "Current password is incorrect" });

  try {
    await db.query(`UPDATE companies SET admin_email = $1 WHERE id = $2`, [new_email, req.companyId]);
    res.json({ message: "Email updated" });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "Another account already uses that email" });
    }
    throw err;
  }
});

// GET /api/admin/payroll-email
// Returns this company's payroll inbox — where "Submit Hours for Payroll"
// sends timesheet emails. Null until the admin sets it here.
router.get("/payroll-email", async (req, res) => {
  const result = await db.query(`SELECT payroll_email FROM companies WHERE id = $1`, [req.companyId]);
  if (result.rowCount === 0) return res.status(404).json({ error: "Company not found" });
  res.json(result.rows[0]);
});

// PATCH /api/admin/payroll-email
// Body: { payroll_email }
router.patch("/payroll-email", async (req, res) => {
  const { payroll_email } = req.body;
  if (!payroll_email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payroll_email)) {
    return res.status(400).json({ error: "A valid payroll_email is required" });
  }
  const result = await db.query(
    `UPDATE companies SET payroll_email = $1 WHERE id = $2 RETURNING payroll_email`,
    [payroll_email, req.companyId]
  );
  res.json(result.rows[0]);
});

// GET /api/admin/long-shift-alert
// How many hours a shift can run before the admin gets pushed a "still
// clocked in" notification (see the cron job in server.js). Null means the
// alert is off. Defaults to 10 for every company.
router.get("/long-shift-alert", async (req, res) => {
  const result = await db.query(`SELECT long_shift_alert_hours FROM companies WHERE id = $1`, [req.companyId]);
  if (result.rowCount === 0) return res.status(404).json({ error: "Company not found" });
  res.json(result.rows[0]);
});

// PATCH /api/admin/long-shift-alert
// Body: { long_shift_alert_hours } -- an integer 1-24, or null to turn the
// alert off.
router.patch("/long-shift-alert", async (req, res) => {
  const { long_shift_alert_hours } = req.body;
  if (long_shift_alert_hours !== null && long_shift_alert_hours !== undefined) {
    const hours = Number(long_shift_alert_hours);
    if (!Number.isInteger(hours) || hours < 1 || hours > 24) {
      return res.status(400).json({ error: "long_shift_alert_hours must be an integer between 1 and 24, or null" });
    }
  }
  const result = await db.query(
    `UPDATE companies SET long_shift_alert_hours = $1 WHERE id = $2 RETURNING long_shift_alert_hours`,
    [long_shift_alert_hours === undefined ? null : long_shift_alert_hours, req.companyId]
  );
  res.json(result.rows[0]);
});

// GET /api/admin/show-profit-bubbles
// Whether the Gross/Net Profit bubbles render on the Overview tab's home
// screen. Defaults to true for every company (see schema-show-profit-
// bubbles.sql) so this is purely an opt-out.
router.get("/show-profit-bubbles", async (req, res) => {
  const result = await db.query(`SELECT show_profit_bubbles FROM companies WHERE id = $1`, [req.companyId]);
  if (result.rowCount === 0) return res.status(404).json({ error: "Company not found" });
  res.json(result.rows[0]);
});

// PATCH /api/admin/show-profit-bubbles
// Body: { show_profit_bubbles: boolean }
router.patch("/show-profit-bubbles", async (req, res) => {
  const { show_profit_bubbles } = req.body;
  const result = await db.query(
    `UPDATE companies SET show_profit_bubbles = $1 WHERE id = $2 RETURNING show_profit_bubbles`,
    [!!show_profit_bubbles, req.companyId]
  );
  res.json(result.rows[0]);
});

// GET /api/admin/company-name
// The business name shown on invoice/quote PDFs, in the "From" display name
// of customer-facing emails (see utils/mailer.js's customerFacingFrom), and
// in push notification titles -- basically anywhere the app is representing
// this specific company rather than Coll Timeclock itself.
router.get("/company-name", async (req, res) => {
  const result = await db.query(`SELECT name FROM companies WHERE id = $1`, [req.companyId]);
  if (result.rowCount === 0) return res.status(404).json({ error: "Company not found" });
  res.json(result.rows[0]);
});

// PATCH /api/admin/company-name
// Body: { name }
router.patch("/company-name", async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "A company name is required" });
  const result = await db.query(
    `UPDATE companies SET name = $1 WHERE id = $2 RETURNING name`,
    [name.trim(), req.companyId]
  );
  res.json(result.rows[0]);
});

// GET /api/admin/shop-location
// Returns this company's shop coordinates and auto clock-in/out cutoff
// times, used by the employee app for geo-based auto clock-in/out.
// shop_lat/shop_lng are null until the admin sets them here;
// auto_clockout_time defaults to 4:30pm and auto_clockin_time defaults to
// midnight (i.e. no earliest-time restriction) until changed.
router.get("/shop-location", async (req, res) => {
  const result = await db.query(
    `SELECT shop_lat, shop_lng, shop_radius_m, auto_clockout_time, auto_clockin_time FROM companies WHERE id = $1`,
    [req.companyId]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: "Company not found" });
  res.json(result.rows[0]);
});

// PATCH /api/admin/shop-location
// Body: { shop_lat, shop_lng, shop_radius_m, auto_clockout_time, auto_clockin_time }
// auto_clockout_time/auto_clockin_time are optional and expected as
// "HH:MM" (24-hour). auto_clockin_time is the earliest time of day auto
// clock-in is allowed to fire on arrival -- someone showing up before that
// (e.g. well before their shift starts) won't get auto clocked in until it
// passes, same idea as the existing auto clock-out cutoff.
router.patch("/shop-location", async (req, res) => {
  const { shop_lat, shop_lng, shop_radius_m, auto_clockout_time, auto_clockin_time } = req.body;
  if (shop_lat == null || shop_lng == null) {
    return res.status(400).json({ error: "shop_lat and shop_lng are required" });
  }
  const lat = Number(shop_lat);
  const lng = Number(shop_lng);
  const radius = shop_radius_m != null ? Number(shop_radius_m) : 152;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(radius)) {
    return res.status(400).json({ error: "shop_lat, shop_lng, and shop_radius_m must be numbers" });
  }
  if (auto_clockout_time != null && !/^\d{1,2}:\d{2}(:\d{2})?$/.test(auto_clockout_time)) {
    return res.status(400).json({ error: "auto_clockout_time must be in HH:MM format" });
  }
  if (auto_clockin_time != null && !/^\d{1,2}:\d{2}(:\d{2})?$/.test(auto_clockin_time)) {
    return res.status(400).json({ error: "auto_clockin_time must be in HH:MM format" });
  }

  const fields = ["shop_lat = $1", "shop_lng = $2", "shop_radius_m = $3"];
  const values = [lat, lng, radius];
  if (auto_clockout_time) {
    values.push(auto_clockout_time);
    fields.push(`auto_clockout_time = $${values.length}`);
  }
  if (auto_clockin_time) {
    values.push(auto_clockin_time);
    fields.push(`auto_clockin_time = $${values.length}`);
  }
  values.push(req.companyId);

  const result = await db.query(
    `UPDATE companies SET ${fields.join(", ")} WHERE id = $${values.length}
     RETURNING shop_lat, shop_lng, shop_radius_m, auto_clockout_time, auto_clockin_time`,
    values
  );
  res.json(result.rows[0]);
});

// GET /api/admin/timezone
// The IANA timezone this company is located in (e.g. "America/Denver").
// Used to decide what local hour it is for this company when deciding when
// to send automated emails -- right now, invoice reminders.
router.get("/timezone", async (req, res) => {
  const result = await db.query(`SELECT timezone FROM companies WHERE id = $1`, [req.companyId]);
  if (result.rowCount === 0) return res.status(404).json({ error: "Company not found" });
  res.json(result.rows[0]);
});

// PATCH /api/admin/timezone
// Body: { timezone } -- must be a real IANA zone name; validated by asking
// Intl to actually format a date with it rather than checking against a
// hardcoded list, so every zone the browser/Node itself supports is valid.
router.patch("/timezone", async (req, res) => {
  const { timezone } = req.body;
  if (!timezone) return res.status(400).json({ error: "timezone is required" });
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch (err) {
    return res.status(400).json({ error: "That doesn't look like a valid timezone." });
  }
  const result = await db.query(
    `UPDATE companies SET timezone = $1 WHERE id = $2 RETURNING timezone`,
    [timezone, req.companyId]
  );
  res.json(result.rows[0]);
});

// GET /api/admin/pay-schedule
// Returns this company's pay frequency and (if applicable) the anchor date
// and custom period length used to calculate pay periods.
router.get("/pay-schedule", async (req, res) => {
  const result = await db.query(
    `SELECT pay_frequency, pay_period_anchor, pay_period_custom_days FROM companies WHERE id = $1`,
    [req.companyId]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: "Company not found" });
  res.json(result.rows[0]);
});

// PATCH /api/admin/pay-schedule
// Body: { pay_frequency, pay_period_anchor, pay_period_custom_days }
// pay_period_anchor (a "YYYY-MM-DD" date) is required for biweekly, weekly,
// and custom -- it's the start date of any one known pay period, used to
// calculate every period going forward and backward from it.
// pay_period_custom_days is required (and must be a positive integer) only
// when pay_frequency is "custom".
router.patch("/pay-schedule", async (req, res) => {
  const { pay_frequency, pay_period_anchor, pay_period_custom_days } = req.body;

  if (!PAY_FREQUENCIES.includes(pay_frequency)) {
    return res.status(400).json({
      error: `pay_frequency must be one of: ${PAY_FREQUENCIES.join(", ")}`,
    });
  }

  const needsAnchor = ["biweekly", "weekly", "custom"].includes(pay_frequency);
  if (needsAnchor && !pay_period_anchor) {
    return res.status(400).json({
      error: "pay_period_anchor (the start date of a known pay period) is required for this frequency",
    });
  }

  let customDays = null;
  if (pay_frequency === "custom") {
    customDays = Number(pay_period_custom_days);
    if (!Number.isInteger(customDays) || customDays < 1) {
      return res.status(400).json({ error: "pay_period_custom_days must be a positive whole number" });
    }
  }

  const result = await db.query(
    `UPDATE companies
     SET pay_frequency = $1, pay_period_anchor = $2, pay_period_custom_days = $3
     WHERE id = $4
     RETURNING pay_frequency, pay_period_anchor, pay_period_custom_days`,
    [pay_frequency, needsAnchor ? pay_period_anchor : null, customDays, req.companyId]
  );
  res.json(result.rows[0]);
});

const CLOCK_IN_ANIMATIONS = ["none", "fireworks", "birthday", "rocket", "fall", "easter", "christmas"];
const BREAK_MINUTES_OPTIONS = [30, 60];

router.get("/employees", async (req, res) => {
  const result = await db.query(
    `SELECT id, name, email, active, created_at, clock_in_animation, hourly_rate, phone, street, city, state, zip, break_minutes, can_manage_inventory
     FROM employees WHERE company_id = $1 ORDER BY name`,
    [req.companyId]
  );
  res.json(result.rows);
});

router.post("/employees", async (req, res) => {
  const { name, email, pin, clock_in_animation, hourly_rate, break_minutes } = req.body;
  if (!name || !email || !pin) {
    return res.status(400).json({ error: "name, email, and pin are required" });
  }
  if (clock_in_animation !== undefined && !CLOCK_IN_ANIMATIONS.includes(clock_in_animation)) {
    return res.status(400).json({ error: "Invalid clock_in_animation" });
  }
  if (break_minutes !== undefined && !BREAK_MINUTES_OPTIONS.includes(Number(break_minutes))) {
    return res.status(400).json({ error: "break_minutes must be 30 or 60" });
  }
  const pin_hash = await hashPin(pin);
  try {
    const result = await db.query(
      `INSERT INTO employees (name, email, pin_hash, company_id, clock_in_animation, hourly_rate, break_minutes) VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, email, active, created_at, clock_in_animation, hourly_rate, break_minutes`,
      [name, email, pin_hash, req.companyId, clock_in_animation || "none", hourly_rate || null, break_minutes || 30]
    );
    res.status(201).json(result.rows[0]);

    // Welcome email is a nice-to-have, not a hard requirement for the
    // employee to actually be created -- send it after responding, and
    // don't let a delivery failure turn a successful hire into an error the
    // admin has to deal with.
    try {
      const companyResult = await db.query(`SELECT name FROM companies WHERE id = $1`, [req.companyId]);
      await sendEmployeeWelcomeEmail({ to: email, name, companyName: companyResult.rows[0].name });
    } catch (emailErr) {
      console.error(`Failed to send welcome email to new employee ${result.rows[0].id}:`, emailErr.message);
    }
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "An employee with that email already exists" });
    }
    throw err;
  }
});

router.patch("/employees/:id", async (req, res) => {
  const { id } = req.params;
  const { name, email, active, pin, clock_in_animation, hourly_rate, phone, street, city, state, zip, break_minutes, can_manage_inventory } = req.body;

  if (clock_in_animation !== undefined && !CLOCK_IN_ANIMATIONS.includes(clock_in_animation)) {
    return res.status(400).json({ error: "Invalid clock_in_animation" });
  }
  if (hourly_rate !== undefined && hourly_rate !== null && (isNaN(Number(hourly_rate)) || Number(hourly_rate) < 0)) {
    return res.status(400).json({ error: "hourly_rate must be a non-negative number" });
  }
  if (break_minutes !== undefined && !BREAK_MINUTES_OPTIONS.includes(Number(break_minutes))) {
    return res.status(400).json({ error: "break_minutes must be 30 or 60" });
  }

  const fields = [];
  const values = [];
  if (name !== undefined) { values.push(name); fields.push(`name = $${values.length}`); }
  if (email !== undefined) { values.push(email); fields.push(`email = $${values.length}`); }
  if (active !== undefined) { values.push(active); fields.push(`active = $${values.length}`); }
  if (pin) { values.push(await hashPin(pin)); fields.push(`pin_hash = $${values.length}`); }
  if (clock_in_animation !== undefined) { values.push(clock_in_animation); fields.push(`clock_in_animation = $${values.length}`); }
  if (hourly_rate !== undefined) { values.push(hourly_rate === null || hourly_rate === "" ? null : Number(hourly_rate)); fields.push(`hourly_rate = $${values.length}`); }
  if (phone !== undefined) { values.push(phone || null); fields.push(`phone = $${values.length}`); }
  if (street !== undefined) { values.push(street || null); fields.push(`street = $${values.length}`); }
  if (city !== undefined) { values.push(city || null); fields.push(`city = $${values.length}`); }
  if (state !== undefined) { values.push(state || null); fields.push(`state = $${values.length}`); }
  if (zip !== undefined) { values.push(zip || null); fields.push(`zip = $${values.length}`); }
  if (break_minutes !== undefined) { values.push(Number(break_minutes)); fields.push(`break_minutes = $${values.length}`); }
  if (can_manage_inventory !== undefined) { values.push(!!can_manage_inventory); fields.push(`can_manage_inventory = $${values.length}`); }

  if (fields.length === 0) return res.status(400).json({ error: "Nothing to update" });

  values.push(id, req.companyId);
  try {
    const result = await db.query(
      `UPDATE employees SET ${fields.join(", ")} WHERE id = $${values.length - 1} AND company_id = $${values.length}
       RETURNING id, name, email, active, created_at, clock_in_animation, hourly_rate, phone, street, city, state, zip, break_minutes, can_manage_inventory`,
      values
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "Employee not found" });
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "An employee with that email already exists" });
    }
    throw err;
  }
});

router.get("/time-entries", async (req, res) => {
  const { start, end, employee_id } = req.query;
  const conditions = [`e.company_id = $1`];
  const params = [req.companyId];

  // end is a plain "YYYY-MM-DD" date with no time component. Comparing
  // clock_in (a timestamptz) against it with <= casts the date to midnight,
  // so any entry on the end day itself with a clock_in after 00:00 -- i.e.
  // basically all of them -- got silently excluded. That's exactly what made
  // editing a time entry to land on "today" (the default end of the range in
  // the Edit Hours view) look like the save didn't take: it saved fine, it
  // just immediately fell outside this query's range and vanished from the
  // list. Using "< end + 1 day" instead makes the end day fully inclusive,
  // matching the fix already applied to the Reports queries below.
  if (start) { params.push(start); conditions.push(`d.clock_in >= $${params.length}::date`); }
  if (end) { params.push(end); conditions.push(`d.clock_in < ($${params.length}::date + INTERVAL '1 day')`); }
  if (employee_id) { params.push(employee_id); conditions.push(`d.employee_id = $${params.length}`); }

  const result = await db.query(
    `SELECT d.*, e.name AS employee_name
     FROM time_entry_durations d
     JOIN employees e ON e.id = d.employee_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY d.clock_in DESC`,
    params
  );
  res.json(result.rows);
});

router.patch("/time-entries/:id", async (req, res) => {
  const { id } = req.params;
  const { job_name, location_type, clock_in, clock_out } = req.body;

  const owns = await db.query(
    `SELECT te.id FROM time_entries te JOIN employees e ON e.id = te.employee_id
     WHERE te.id = $1 AND e.company_id = $2`,
    [id, req.companyId]
  );
  if (owns.rowCount === 0) return res.status(404).json({ error: "Time entry not found" });

  const fields = [];
  const values = [];
  if (job_name !== undefined) { values.push(job_name); fields.push(`job_name = $${values.length}`); }
  if (location_type !== undefined) { values.push(location_type); fields.push(`location_type = $${values.length}`); }
  if (clock_in !== undefined) { values.push(clock_in); fields.push(`clock_in = $${values.length}`); }
  if (clock_out !== undefined) { values.push(clock_out); fields.push(`clock_out = $${values.length}`); }

  if (fields.length === 0) return res.status(400).json({ error: "Nothing to update" });

  values.push(id);
  const result = await db.query(
    `UPDATE time_entries SET ${fields.join(", ")} WHERE id = $${values.length} RETURNING *`,
    values
  );
  res.json(result.rows[0]);
});

router.get("/overview", async (req, res) => {
  const companyResult = await db.query(
    `SELECT pay_frequency, pay_period_anchor, pay_period_custom_days, long_shift_alert_hours, show_profit_bubbles FROM companies WHERE id = $1`,
    [req.companyId]
  );
  const period = getPayPeriod(new Date(), companyResult.rows[0] || {});
  const result = await db.query(
    `SELECT
       e.id, e.name, e.active,
       open_te.id AS open_entry_id,
       open_te.job_name AS open_job_name,
       open_te.location_type AS open_location_type,
       open_te.clock_in AS open_clock_in,
       l.lat, l.lng, l.recorded_at AS location_recorded_at,
       COALESCE(SUM(d.worked_seconds) FILTER (WHERE d.location_type = 'in_town'), 0) AS regular_seconds,
       COALESCE(SUM(d.worked_seconds) FILTER (WHERE d.location_type = 'traveling'), 0) AS travel_seconds
     FROM employees e
     LEFT JOIN time_entries open_te ON open_te.employee_id = e.id AND open_te.clock_out IS NULL
     LEFT JOIN employee_locations l ON l.employee_id = e.id
     LEFT JOIN time_entry_durations d ON d.employee_id = e.id
       AND d.clock_in >= $2 AND d.clock_in <= $3
     WHERE e.company_id = $1
     GROUP BY e.id, e.name, e.active, open_te.id, open_te.job_name, open_te.location_type, open_te.clock_in, l.lat, l.lng, l.recorded_at
     ORDER BY e.active DESC, e.name`,
    [req.companyId, period.start, period.end]
  );
  res.json({
    period,
    employees: result.rows,
    long_shift_alert_hours: companyResult.rows[0] ? companyResult.rows[0].long_shift_alert_hours : 10,
    show_profit_bubbles: companyResult.rows[0] ? companyResult.rows[0].show_profit_bubbles : true,
  });
});

router.post("/employees/:id/request-ping", async (req, res) => {
  const { id } = req.params;
  const owns = await db.query(`SELECT id FROM employees WHERE id = $1 AND company_id = $2`, [id, req.companyId]);
  if (owns.rowCount === 0) return res.status(404).json({ error: "Employee not found" });

  const openShift = await db.query(
    `SELECT id FROM time_entries WHERE employee_id = $1 AND clock_out IS NULL`,
    [id]
  );
  if (openShift.rowCount === 0) {
    return res.status(400).json({ error: "Employee is not currently clocked in" });
  }
  await db.query(
    `INSERT INTO ping_requests (employee_id, requested_at) VALUES ($1, now())
     ON CONFLICT (employee_id) DO UPDATE SET requested_at = now()`,
    [id]
  );
  res.json({ requested: true });
});

// ---------- Crews ----------
// A crew is a reusable, named group of employees an admin can assign to a
// job in one click instead of picking employees individually every time.

// GET /api/admin/customers
// Returns every customer for this company, most recently added first.
router.get("/customers", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, company_name, phone, email, street, city, state, zip, notes, created_at
       FROM customers
       WHERE company_id = $1
       ORDER BY name`,
      [req.companyId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /admin/customers failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load customers." });
  }
});

// GET /api/admin/customers/:id/events
// Returns every event (job) linked to this customer, most recent first.
router.get("/customers/:id/events", async (req, res) => {
  try {
    const { id } = req.params;
    const owns = await db.query(`SELECT id FROM customers WHERE id = $1 AND company_id = $2`, [id, req.companyId]);
    if (owns.rowCount === 0) return res.status(404).json({ error: "Customer not found" });

    const result = await db.query(
      `SELECT id, title, notes, start_date, end_date, start_time, color, event_type
       FROM jobs
       WHERE customer_id = $1 AND company_id = $2
       ORDER BY start_date DESC`,
      [id, req.companyId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /admin/customers/:id/events failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load customer events." });
  }
});

// GET /api/admin/geocode/suggest?q=partial+address
// Powers the predictive-text dropdown under the street address field on
// the Add/Edit Customer form. See utils/geocode.js for the rate-limiting
// and usage-policy notes -- the frontend debounces keystrokes so this
// doesn't fire on every character typed. Biases results toward the
// company's shop location (if set) so a same-named street near the
// business outranks an unrelated one in another state.
router.get("/geocode/suggest", async (req, res) => {
  try {
    const shopResult = await db.query(`SELECT shop_lat, shop_lng FROM companies WHERE id = $1`, [req.companyId]);
    const shop = shopResult.rows[0];
    const bias = shop && shop.shop_lat != null && shop.shop_lng != null ? { lat: shop.shop_lat, lng: shop.shop_lng } : null;
    const suggestions = await suggestAddresses(req.query.q, bias);
    res.json(suggestions);
  } catch (err) {
    console.error("GET /admin/geocode/suggest failed:", err);
    res.status(500).json({ error: err.message || "Couldn't look up addresses." });
  }
});

// POST /api/admin/customers
// Body: { name, company_name?, phone?, email?, street?, city?, state?, zip?, notes?, lat?, lng? }
router.post("/customers", async (req, res) => {
  try {
    const { name, company_name, phone, email, street, city, state, zip, notes, lat, lng } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });

    // If the admin picked a suggestion from the predictive-text dropdown,
    // the client already has an exact, Nominatim-confirmed lat/lng for this
    // address -- use it directly instead of re-geocoding (saves a lookup
    // and is more accurate than re-deriving it from the typed-out fields).
    // Otherwise fall back to geocoding server-side, best effort only: a
    // failed/slow lookup should never block adding a customer. (Rate-limited
    // to ~1/sec across the whole server, see utils/geocode.js.)
    let resolvedLat = null;
    let resolvedLng = null;
    let geocodedAt = null;
    if (Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))) {
      resolvedLat = Number(lat);
      resolvedLng = Number(lng);
      geocodedAt = new Date();
    } else {
      const geocoded = await geocodeAddress({ street, city, state, zip }).catch(() => null);
      if (geocoded) {
        resolvedLat = geocoded.lat;
        resolvedLng = geocoded.lng;
        geocodedAt = new Date();
      }
    }

    const result = await db.query(
      `INSERT INTO customers (company_id, name, company_name, phone, email, street, city, state, zip, notes, lat, lng, geocoded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id, name, company_name, phone, email, street, city, state, zip, notes, lat, lng, created_at`,
      [
        req.companyId, name, company_name || null, phone || null, email || null, street || null, city || null, state || null, zip || null, notes || null,
        resolvedLat, resolvedLng, geocodedAt,
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("POST /admin/customers failed:", err);
    res.status(500).json({ error: err.message || "Couldn't create customer." });
  }
});

// POST /api/admin/customers/import
// Body: { customers: [{ name, company_name?, phone?, email?, street?, city?, state?, zip?, notes? }, ...] }
// Bulk-imports customers from a CSV exported by other software (parsed
// client-side, sent here as plain objects). Rows missing a name are
// skipped, and rows whose name case-insensitively matches an existing
// customer -- or an earlier row in the same file -- are skipped as
// duplicates instead of creating a second record.
router.post("/customers/import", async (req, res) => {
  try {
    const { customers } = req.body;
    if (!Array.isArray(customers) || customers.length === 0) {
      return res.status(400).json({ error: "No customers to import." });
    }
    if (customers.length > 2000) {
      return res.status(400).json({ error: "That's more than 2000 rows at once -- please split the file up." });
    }

    const existing = await db.query(`SELECT name FROM customers WHERE company_id = $1`, [req.companyId]);
    const seenNames = new Set(existing.rows.map((r) => r.name.trim().toLowerCase()));

    let imported = 0;
    const skipped = [];

    for (let i = 0; i < customers.length; i++) {
      const row = customers[i] || {};
      const name = (row.name || "").trim();
      if (!name) {
        skipped.push({ row: i + 1, reason: "missing_name" });
        continue;
      }
      const key = name.toLowerCase();
      if (seenNames.has(key)) {
        skipped.push({ row: i + 1, reason: "duplicate", name });
        continue;
      }
      seenNames.add(key);
      await db.query(
        `INSERT INTO customers (company_id, name, company_name, phone, email, street, city, state, zip, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          req.companyId, name,
          (row.company_name || "").trim() || null,
          (row.phone || "").trim() || null,
          (row.email || "").trim() || null,
          (row.street || "").trim() || null,
          (row.city || "").trim() || null,
          (row.state || "").trim() || null,
          (row.zip || "").trim() || null,
          (row.notes || "").trim() || null,
        ]
      );
      imported++;
    }

    res.status(201).json({ imported, skipped });
  } catch (err) {
    console.error("POST /admin/customers/import failed:", err);
    res.status(500).json({ error: err.message || "Couldn't import customers." });
  }
});

// PATCH /api/admin/customers/:id
// Body: { name?, company_name?, phone?, email?, street?, city?, state?, zip?, notes?, lat?, lng? }
router.patch("/customers/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, company_name, phone, email, street, city, state, zip, notes, lat, lng } = req.body;

    const owns = await db.query(
      `SELECT id, street, city, state, zip FROM customers WHERE id = $1 AND company_id = $2`,
      [id, req.companyId]
    );
    if (owns.rowCount === 0) return res.status(404).json({ error: "Customer not found" });
    const existing = owns.rows[0];

    const fields = [];
    const values = [];
    if (name !== undefined) { values.push(name); fields.push(`name = $${values.length}`); }
    if (company_name !== undefined) { values.push(company_name); fields.push(`company_name = $${values.length}`); }
    if (phone !== undefined) { values.push(phone); fields.push(`phone = $${values.length}`); }
    if (email !== undefined) { values.push(email); fields.push(`email = $${values.length}`); }
    if (street !== undefined) { values.push(street); fields.push(`street = $${values.length}`); }
    if (city !== undefined) { values.push(city); fields.push(`city = $${values.length}`); }
    if (state !== undefined) { values.push(state); fields.push(`state = $${values.length}`); }
    if (zip !== undefined) { values.push(zip); fields.push(`zip = $${values.length}`); }
    if (notes !== undefined) { values.push(notes); fields.push(`notes = $${values.length}`); }

    // If the admin picked a suggestion from the predictive-text dropdown,
    // the client already has an exact, Nominatim-confirmed lat/lng for this
    // address -- trust it directly rather than re-geocoding from the typed
    // fields. Otherwise fall back to the original behavior: only re-geocode
    // if an address field actually changed, keeping this to one lookup per
    // real address edit rather than every save.
    const hasClientLatLng = Number.isFinite(Number(lat)) && Number.isFinite(Number(lng));
    const addressChanged =
      (street !== undefined && street !== existing.street) ||
      (city !== undefined && city !== existing.city) ||
      (state !== undefined && state !== existing.state) ||
      (zip !== undefined && zip !== existing.zip);
    if (hasClientLatLng) {
      values.push(Number(lat));
      fields.push(`lat = $${values.length}`);
      values.push(Number(lng));
      fields.push(`lng = $${values.length}`);
      values.push(new Date());
      fields.push(`geocoded_at = $${values.length}`);
    } else if (addressChanged) {
      const geocoded = await geocodeAddress({
        street: street !== undefined ? street : existing.street,
        city: city !== undefined ? city : existing.city,
        state: state !== undefined ? state : existing.state,
        zip: zip !== undefined ? zip : existing.zip,
      }).catch(() => null);
      values.push(geocoded ? geocoded.lat : null);
      fields.push(`lat = $${values.length}`);
      values.push(geocoded ? geocoded.lng : null);
      fields.push(`lng = $${values.length}`);
      values.push(geocoded ? new Date() : null);
      fields.push(`geocoded_at = $${values.length}`);
    }

    let customer = owns.rows[0];
    if (fields.length > 0) {
      values.push(id);
      const result = await db.query(
        `UPDATE customers SET ${fields.join(", ")} WHERE id = $${values.length}
         RETURNING id, name, company_name, phone, email, street, city, state, zip, notes, lat, lng, created_at`,
        values
      );
      customer = result.rows[0];
    }
    res.json(customer);
  } catch (err) {
    console.error("PATCH /admin/customers/:id failed:", err);
    res.status(500).json({ error: err.message || "Couldn't update customer." });
  }
});

// DELETE /api/admin/customers/:id
// Events linked to this customer are kept -- customer_id is just cleared
// (see schema's ON DELETE SET NULL), so past job history isn't lost.
router.delete("/customers/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(`DELETE FROM customers WHERE id = $1 AND company_id = $2`, [id, req.companyId]);
    if (result.rowCount === 0) return res.status(404).json({ error: "Customer not found" });
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /admin/customers/:id failed:", err);
    res.status(500).json({ error: err.message || "Couldn't delete customer." });
  }
});

// GET /api/admin/crews
// Returns every crew for this company along with its current members.
router.get("/crews", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT c.id, c.name, c.created_at,
              COALESCE(
                json_agg(
                  json_build_object('id', e.id, 'name', e.name)
                  ORDER BY e.name
                ) FILTER (WHERE e.id IS NOT NULL), '[]'
              ) AS members
       FROM crews c
       LEFT JOIN crew_members cm ON cm.crew_id = c.id
       LEFT JOIN employees e ON e.id = cm.employee_id
       WHERE c.company_id = $1
       GROUP BY c.id
       ORDER BY c.name`,
      [req.companyId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /admin/crews failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load crews." });
  }
});

// POST /api/admin/crews
// Body: { name, employee_ids: [] }
router.post("/crews", async (req, res) => {
  try {
    const { name, employee_ids } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });

    const crewResult = await db.query(
      `INSERT INTO crews (company_id, name) VALUES ($1, $2) RETURNING id, name, created_at`,
      [req.companyId, name]
    );
    const crew = crewResult.rows[0];

    const ids = Array.isArray(employee_ids) ? employee_ids.filter(Boolean) : [];
    if (ids.length > 0) {
      await db.query(
        `INSERT INTO crew_members (crew_id, employee_id)
         SELECT $1::uuid, e.id FROM employees e WHERE e.id = ANY($2::uuid[]) AND e.company_id = $3::uuid
         ON CONFLICT DO NOTHING`,
        [crew.id, ids, req.companyId]
      );
    }
    res.status(201).json({ ...crew, members: [] });
  } catch (err) {
    console.error("POST /admin/crews failed:", err);
    res.status(500).json({ error: err.message || "Couldn't create crew." });
  }
});

// PATCH /api/admin/crews/:id
// Body: { name?, employee_ids? } -- employee_ids, if provided, fully
// replaces the crew's membership list.
router.patch("/crews/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, employee_ids } = req.body;

    const owns = await db.query(`SELECT id FROM crews WHERE id = $1 AND company_id = $2`, [id, req.companyId]);
    if (owns.rowCount === 0) return res.status(404).json({ error: "Crew not found" });

    if (name !== undefined) {
      await db.query(`UPDATE crews SET name = $1 WHERE id = $2`, [name, id]);
    }
    if (Array.isArray(employee_ids)) {
      const ids = employee_ids.filter(Boolean);
      await db.query(`DELETE FROM crew_members WHERE crew_id = $1`, [id]);
      if (ids.length > 0) {
        await db.query(
          `INSERT INTO crew_members (crew_id, employee_id)
           SELECT $1::uuid, e.id FROM employees e WHERE e.id = ANY($2::uuid[]) AND e.company_id = $3::uuid
           ON CONFLICT DO NOTHING`,
          [id, ids, req.companyId]
        );
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("PATCH /admin/crews/:id failed:", err);
    res.status(500).json({ error: err.message || "Couldn't update crew." });
  }
});

// DELETE /api/admin/crews/:id
router.delete("/crews/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(`DELETE FROM crews WHERE id = $1 AND company_id = $2`, [id, req.companyId]);
    if (result.rowCount === 0) return res.status(404).json({ error: "Crew not found" });
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /admin/crews/:id failed:", err);
    res.status(500).json({ error: err.message || "Couldn't delete crew." });
  }
});

// ---------- Jobs ----------
// A job is a color-coded task scheduled for one or more days, assigned to
// individual employees and/or whole crews. Assigning sends each newly
// assigned employee a push notification (if they've enabled them).

async function expandAssignments({ employee_ids, crew_ids, companyId }) {
  // Map of employeeId -> assigned_via_crew_id (or null for a direct add).
  // Crew members are added first so a direct add can "win" and be recorded
  // as a direct assignment even if the same person is also in a crew.
  const map = new Map();

  const crewIds = Array.isArray(crew_ids) ? crew_ids.filter(Boolean) : [];
  if (crewIds.length > 0) {
    const members = await db.query(
      `SELECT cm.crew_id, cm.employee_id
       FROM crew_members cm
       JOIN crews c ON c.id = cm.crew_id
       WHERE cm.crew_id = ANY($1::uuid[]) AND c.company_id = $2::uuid`,
      [crewIds, companyId]
    );
    for (const row of members.rows) map.set(row.employee_id, row.crew_id);
  }

  const directIds = Array.isArray(employee_ids) ? employee_ids.filter(Boolean) : [];
  if (directIds.length > 0) {
    const valid = await db.query(
      `SELECT id FROM employees WHERE id = ANY($1::uuid[]) AND company_id = $2::uuid`,
      [directIds, companyId]
    );
    for (const row of valid.rows) map.set(row.id, null);
  }

  return map;
}

function formatTimeForNotification(startTime) {
  if (!startTime) return "";
  const [h, m] = startTime.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return ` at ${hour12}:${String(m).padStart(2, "0")} ${period}`;
}

async function notifyAssigned(employeeIds, job) {
  const dateRange =
    job.start_date === job.end_date
      ? job.start_date
      : `${job.start_date} to ${job.end_date}`;
  const timeLabel = formatTimeForNotification(job.start_time);
  await Promise.all(
    employeeIds.map((employeeId) =>
      sendPushToEmployee(employeeId, {
        title: "New event scheduled",
        body: `${job.title} — ${dateRange}${timeLabel}`,
        url: "/schedule",
      }).catch((err) => console.error("Failed to send job notification:", err.message))
    )
  );
}

// Notifies whichever employees are assigned to the job a newly-built,
// job-based pull sheet (source_type 'quote'/'invoice') is tied to. Solo/
// manual pull sheets never call this -- they're not tied to a job, so
// there's no crew to notify. Best-effort: a missing job link, a job with no
// assignments yet, or a push failure should never fail the pull-sheet build
// itself, so every step here is wrapped to swallow its own errors.
async function notifyPullSheetBuilt(sheet, sourceType, sourceId, companyId) {
  try {
    const jobField = sourceType === "quote" ? "converted_job_id" : "job_id";
    const table = sourceType === "quote" ? "quotes" : "invoices";
    const jobResult = await db.query(`SELECT ${jobField} AS job_id FROM ${table} WHERE id = $1`, [sourceId]);
    const jobId = jobResult.rows[0]?.job_id;
    if (!jobId) return;

    const assignedResult = await db.query(`SELECT employee_id FROM job_assignments WHERE job_id = $1`, [jobId]);
    if (assignedResult.rowCount === 0) return;

    await Promise.all(
      assignedResult.rows.map((row) =>
        sendPushToEmployee(row.employee_id, {
          title: "Pull sheet ready",
          body: `A pull sheet was built for ${sheet.source_label}${sheet.customer_name ? ` — ${sheet.customer_name}` : ""}`,
          url: "/schedule",
        }).catch((err) => console.error("Failed to send pull sheet notification:", err.message))
      )
    );
  } catch (err) {
    console.error("notifyPullSheetBuilt failed:", err.message);
  }
}

// GET /api/admin/jobs?start=YYYY-MM-DD&end=YYYY-MM-DD
// Returns jobs overlapping the given range (both optional -- omit both to
// get every job) along with their assigned employees.
router.get("/jobs", async (req, res) => {
  try {
    const { start, end } = req.query;
    const conditions = [`j.company_id = $1`];
    const params = [req.companyId];

    if (start) { params.push(start); conditions.push(`j.end_date >= $${params.length}`); }
    if (end) { params.push(end); conditions.push(`j.start_date <= $${params.length}`); }

    const result = await db.query(
      `SELECT j.id, j.title, j.notes, j.start_date, j.end_date, j.start_time, j.color, j.event_type, j.created_at,
              j.customer_id, c.name AS customer_name, c.company_name AS customer_company_name, c.phone AS customer_phone,
              c.street AS customer_street, c.city AS customer_city, c.state AS customer_state, c.zip AS customer_zip,
              COALESCE(
                json_agg(
                  json_build_object('id', e.id, 'name', e.name, 'crew_id', ja.assigned_via_crew_id)
                  ORDER BY e.name
                ) FILTER (WHERE e.id IS NOT NULL), '[]'
              ) AS assigned_employees
       FROM jobs j
       LEFT JOIN job_assignments ja ON ja.job_id = j.id
       LEFT JOIN employees e ON e.id = ja.employee_id
       LEFT JOIN customers c ON c.id = j.customer_id
       WHERE ${conditions.join(" AND ")}
       GROUP BY j.id, c.id
       ORDER BY j.start_date, j.title`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /admin/jobs failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load jobs." });
  }
});

// POST /api/admin/jobs
// Body: { title, notes?, start_date, end_date, color, employee_ids?, crew_ids? }
router.post("/jobs", async (req, res) => {
  try {
    const { title, notes, start_date, end_date, start_time, color, event_type, customer_id, employee_ids, crew_ids } = req.body;
    if (!title || !start_date || !end_date) {
      return res.status(400).json({ error: "title, start_date, and end_date are required" });
    }
    const jobColor = color || "rust";
    if (!JOB_COLORS[jobColor]) {
      return res.status(400).json({ error: `color must be one of: ${Object.keys(JOB_COLORS).join(", ")}` });
    }
    const eventType = event_type || "job";
    if (!EVENT_TYPES.includes(eventType)) {
      return res.status(400).json({ error: `event_type must be one of: ${EVENT_TYPES.join(", ")}` });
    }
    if (start_time && !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(start_time)) {
      return res.status(400).json({ error: "start_time must be in HH:MM format" });
    }
    let customerId = null;
    if (customer_id) {
      const ownsCustomer = await db.query(`SELECT id FROM customers WHERE id = $1 AND company_id = $2`, [customer_id, req.companyId]);
      if (ownsCustomer.rowCount === 0) return res.status(400).json({ error: "customer not found" });
      customerId = customer_id;
    }

    const jobResult = await db.query(
      `INSERT INTO jobs (company_id, title, notes, start_date, end_date, start_time, color, event_type, customer_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, title, notes, start_date, end_date, start_time, color, event_type, customer_id, created_at`,
      [req.companyId, title, notes || null, start_date, end_date, start_time || null, jobColor, eventType, customerId]
    );
    const job = jobResult.rows[0];

    const assignments = await expandAssignments({ employee_ids, crew_ids, companyId: req.companyId });
    if (assignments.size > 0) {
      await Promise.all(
        Array.from(assignments.entries()).map(([employeeId, crewId]) =>
          db.query(
            `INSERT INTO job_assignments (job_id, employee_id, assigned_via_crew_id)
             VALUES ($1, $2, $3)`,
            [job.id, employeeId, crewId]
          )
        )
      );
      notifyAssigned(Array.from(assignments.keys()), job);
    }

    res.status(201).json(job);
  } catch (err) {
    console.error("POST /admin/jobs failed:", err);
    res.status(500).json({ error: err.message || "Couldn't create event." });
  }
});

// PATCH /api/admin/jobs/:id
// Body: { title?, notes?, start_date?, end_date?, color?, employee_ids?, crew_ids? }
// employee_ids/crew_ids, if either is provided, fully replace the job's
// assignment list -- only employees newly added (who weren't already
// assigned) get a push notification, so editing a job doesn't re-notify
// everyone already on it.
router.patch("/jobs/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { title, notes, start_date, end_date, start_time, color, event_type, customer_id, employee_ids, crew_ids } = req.body;

    const owns = await db.query(`SELECT * FROM jobs WHERE id = $1 AND company_id = $2`, [id, req.companyId]);
    if (owns.rowCount === 0) return res.status(404).json({ error: "Event not found" });

    const fields = [];
    const values = [];
    if (title !== undefined) { values.push(title); fields.push(`title = $${values.length}`); }
    if (notes !== undefined) { values.push(notes); fields.push(`notes = $${values.length}`); }
    if (start_date !== undefined) { values.push(start_date); fields.push(`start_date = $${values.length}`); }
    if (end_date !== undefined) { values.push(end_date); fields.push(`end_date = $${values.length}`); }
    if (start_time !== undefined) {
      // null explicitly clears it, meaning "no specific time" -- not "leave unchanged".
      if (start_time && !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(start_time)) {
        return res.status(400).json({ error: "start_time must be in HH:MM format" });
      }
      values.push(start_time || null); fields.push(`start_time = $${values.length}`);
    }
    if (color !== undefined) {
      if (!JOB_COLORS[color]) {
        return res.status(400).json({ error: `color must be one of: ${Object.keys(JOB_COLORS).join(", ")}` });
      }
      values.push(color); fields.push(`color = $${values.length}`);
    }
    if (event_type !== undefined) {
      if (!EVENT_TYPES.includes(event_type)) {
        return res.status(400).json({ error: `event_type must be one of: ${EVENT_TYPES.join(", ")}` });
      }
      values.push(event_type); fields.push(`event_type = $${values.length}`);
    }
    if (customer_id !== undefined) {
      if (customer_id) {
        const ownsCustomer = await db.query(`SELECT id FROM customers WHERE id = $1 AND company_id = $2`, [customer_id, req.companyId]);
        if (ownsCustomer.rowCount === 0) return res.status(400).json({ error: "customer not found" });
      }
      values.push(customer_id || null); fields.push(`customer_id = $${values.length}`);
    }

    let job = owns.rows[0];
    if (fields.length > 0) {
      values.push(id);
      const result = await db.query(
        `UPDATE jobs SET ${fields.join(", ")} WHERE id = $${values.length}
         RETURNING id, title, notes, start_date, end_date, start_time, color, event_type, customer_id, created_at`,
        values
      );
      job = result.rows[0];
    }

    if (employee_ids !== undefined || crew_ids !== undefined) {
      const before = await db.query(`SELECT employee_id, seen_by_employee FROM job_assignments WHERE job_id = $1`, [id]);
      const beforeIds = new Set(before.rows.map((r) => r.employee_id));
      // Employees who were already assigned keep whatever "seen" state they
      // already had (editing the job's title/date shouldn't re-flag it as
      // new for someone who already looked at it) -- only genuinely new
      // assignees start out unseen.
      const beforeSeenMap = new Map(before.rows.map((r) => [r.employee_id, r.seen_by_employee]));

      const assignments = await expandAssignments({ employee_ids, crew_ids, companyId: req.companyId });
      await db.query(`DELETE FROM job_assignments WHERE job_id = $1`, [id]);
      if (assignments.size > 0) {
        await Promise.all(
          Array.from(assignments.entries()).map(([employeeId, crewId]) =>
            db.query(
              `INSERT INTO job_assignments (job_id, employee_id, assigned_via_crew_id, seen_by_employee)
               VALUES ($1, $2, $3, $4)`,
              [id, employeeId, crewId, beforeSeenMap.has(employeeId) ? beforeSeenMap.get(employeeId) : false]
            )
          )
        );
      }
      const newlyAdded = Array.from(assignments.keys()).filter((eid) => !beforeIds.has(eid));
      if (newlyAdded.length > 0) notifyAssigned(newlyAdded, job);
    }

    res.json(job);
  } catch (err) {
    console.error("PATCH /admin/jobs/:id failed:", err);
    res.status(500).json({ error: err.message || "Couldn't update event." });
  }
});

// DELETE /api/admin/jobs/:id
router.delete("/jobs/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(`DELETE FROM jobs WHERE id = $1 AND company_id = $2`, [id, req.companyId]);
    if (result.rowCount === 0) return res.status(404).json({ error: "Job not found" });
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /admin/jobs/:id failed:", err);
    res.status(500).json({ error: err.message || "Couldn't delete event." });
  }
});

// ---------- Time off requests ----------
// An employee submits a date range (a day, a week, whatever) with an
// optional note from the Schedule tab in their own app. It sits 'pending'
// until an admin approves or denies it here. Approving inserts a matching
// row into `jobs` (event_type 'time_off', bright yellow) so it shows up on
// the shared calendar exactly like any other event, and pushes the
// employee a notification either way. See routes/schedule.js for the
// employee-facing create/list/cancel endpoints.

// GET /api/admin/time-off-requests?status=pending
// Defaults to every request (any status), newest first, so the Schedule
// tab can show both a "needs review" list and a history. Pass ?status= to
// narrow it (the pending-requests badge count just checks the length of
// that filtered call rather than a separate endpoint).
router.get("/time-off-requests", async (req, res) => {
  try {
    const { status } = req.query;
    const conditions = [`t.company_id = $1`];
    const params = [req.companyId];
    if (status) {
      params.push(status);
      conditions.push(`t.status = $${params.length}`);
    }
    const result = await db.query(
      `SELECT t.id, t.employee_id, e.name AS employee_name, t.start_date, t.end_date, t.note,
              t.status, t.job_id, t.reviewed_at, t.created_at
       FROM time_off_requests t
       JOIN employees e ON e.id = t.employee_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY t.created_at DESC`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /admin/time-off-requests failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load time off requests." });
  }
});

// PATCH /api/admin/time-off-requests/:id
// Body: { status: "approved" | "denied" }. Only a still-'pending' request
// can be reviewed -- once decided, it's final (the employee would submit a
// fresh request rather than an admin flipping a decision back and forth).
router.patch("/time-off-requests/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!TIME_OFF_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${TIME_OFF_STATUSES.join(", ")}` });
    }

    const owns = await db.query(
      `SELECT t.*, e.name AS employee_name FROM time_off_requests t
       JOIN employees e ON e.id = t.employee_id
       WHERE t.id = $1 AND t.company_id = $2`,
      [id, req.companyId]
    );
    if (owns.rowCount === 0) return res.status(404).json({ error: "Request not found" });
    const request = owns.rows[0];
    if (request.status !== "pending") {
      return res.status(400).json({ error: "This request has already been reviewed." });
    }

    const dateRange =
      request.start_date === request.end_date
        ? request.start_date
        : `${request.start_date} to ${request.end_date}`;

    let jobId = null;
    if (status === "approved") {
      const jobResult = await db.query(
        `INSERT INTO jobs (company_id, title, notes, start_date, end_date, color, event_type)
         VALUES ($1, $2, $3, $4, $5, 'yellow', 'time_off')
         RETURNING id`,
        [req.companyId, `Time off — ${request.employee_name}`, request.note || null, request.start_date, request.end_date]
      );
      jobId = jobResult.rows[0].id;
      await db.query(
        `INSERT INTO job_assignments (job_id, employee_id) VALUES ($1, $2)`,
        [jobId, request.employee_id]
      );
    }

    const updated = await db.query(
      `UPDATE time_off_requests SET status = $1, job_id = $2, reviewed_at = now() WHERE id = $3
       RETURNING id, employee_id, start_date, end_date, note, status, job_id, reviewed_at, created_at`,
      [status, jobId, id]
    );

    sendPushToEmployee(request.employee_id, {
      title: status === "approved" ? "Time off approved" : "Time off request denied",
      body:
        status === "approved"
          ? `Your time off for ${dateRange} was approved.`
          : `Your time off request for ${dateRange} was denied.`,
      url: "/schedule",
    }).catch((err) => console.error("Failed to send time-off decision notification:", err.message));

    res.json(updated.rows[0]);
  } catch (err) {
    console.error("PATCH /admin/time-off-requests/:id failed:", err);
    res.status(500).json({ error: err.message || "Couldn't update time off request." });
  }
});

// ---------- Invoices ----------
// Invoices bill a customer for completed (or upcoming) work, with line
// items, configurable payment terms (Net 15/30/60/90 or due on receipt),
// and a PDF that gets emailed to the customer. Card/check payments aren't
// processed in-app yet -- "mark as paid" just records how payment came in
// (check, cash, a card run elsewhere, etc.) so the invoice's status stays
// accurate without actually moving any money.

function computeInvoiceTotals(lineItems, taxRate) {
  const subtotal = lineItems.reduce((sum, item) => sum + Number(item.quantity) * Number(item.unit_price), 0);
  const taxAmount = subtotal * (Number(taxRate) / 100);
  const total = subtotal + taxAmount;
  return {
    subtotal: Math.round(subtotal * 100) / 100,
    taxAmount: Math.round(taxAmount * 100) / 100,
    total: Math.round(total * 100) / 100,
  };
}

function computeDueDate(issueDate, paymentTerms) {
  const days = PAYMENT_TERMS_DAYS[paymentTerms] ?? 0;
  const d = new Date(`${issueDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Renders the invoice as a PDF, emails it to the customer (cc'ing this
// company's own admin email as a paper trail), and marks it "sent". Shared
// by the explicit "Send" button and by auto-send-on-save, so both paths
// stay identical. Throws on failure; err.status carries the HTTP status the
// caller should use if it turns the error into a response, err.expected
// marks failures that are a normal part of the flow (no email on file yet,
// invoice voided) rather than a real bug.
async function sendInvoiceNow(invoiceId, companyId) {
  const result = await db.query(
    `SELECT i.*, c.name AS customer_name, c.company_name AS customer_company_name, c.email AS customer_email, c.phone AS customer_phone,
            c.street AS customer_street, c.city AS customer_city, c.state AS customer_state, c.zip AS customer_zip
     FROM invoices i JOIN customers c ON c.id = i.customer_id
     WHERE i.id = $1 AND i.company_id = $2`,
    [invoiceId, companyId]
  );
  if (result.rowCount === 0) {
    const err = new Error("Invoice not found");
    err.status = 404;
    throw err;
  }
  const invoice = result.rows[0];
  if (invoice.status === "void") {
    const err = new Error("Can't send a voided invoice.");
    err.status = 400;
    err.expected = true;
    throw err;
  }
  if (!invoice.customer_email) {
    const err = new Error("This customer doesn't have an email on file.");
    err.status = 400;
    err.expected = true;
    throw err;
  }

  const itemsResult = await db.query(
    `SELECT description, quantity, unit_price FROM invoice_line_items WHERE invoice_id = $1 ORDER BY sort_order`,
    [invoiceId]
  );
  const companyResult = await db.query(
    `SELECT name, admin_email, logo_data, stripe_connect_status FROM companies WHERE id = $1`,
    [companyId]
  );
  const company = companyResult.rows[0];
  // Computed once and reused for both the PDF and the email below, so
  // there's exactly one place deciding whether this company can accept
  // online payments -- not two copies that could drift out of sync.
  const payUrl = canAcceptOnlinePayments(company.stripe_connect_status)
    ? `${FRONTEND_URL}/pay-invoice.html?id=${invoice.id}`
    : null;

  const pdfBuffer = await renderInvoicePdf({
    companyName: company.name,
    invoice,
    customer: {
      name: invoice.customer_name,
      company_name: invoice.customer_company_name,
      email: invoice.customer_email,
      phone: invoice.customer_phone,
      street: invoice.customer_street,
      city: invoice.customer_city,
      state: invoice.customer_state,
      zip: invoice.customer_zip,
    },
    lineItems: itemsResult.rows,
    logoBuffer: company.logo_data || null,
    payUrl,
  });

  await sendInvoiceEmail({
    to: invoice.customer_email,
    cc: company.admin_email,
    companyName: company.name,
    invoice,
    pdfBuffer,
    payUrl,
  });

  const updateResult = await db.query(
    `UPDATE invoices SET status = 'sent', sent_at = now() WHERE id = $1 RETURNING *`,
    [invoiceId]
  );
  return updateResult.rows[0];
}

// GET /api/admin/invoices
// Returns every invoice for this company, most recent first, with the
// customer's name joined in and an `is_overdue` flag computed on the fly
// (sent + past due date) rather than stored, so nothing needs a cron job
// to keep it in sync.
router.get("/invoices", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT i.id, i.invoice_number, i.status, i.payment_terms, i.payment_method, i.check_number,
              i.issue_date, i.due_date, i.subtotal, i.tax_rate, i.tax_amount, i.total,
              i.sent_at, i.paid_at, i.created_at, i.reminder_count, i.last_reminder_sent_at,
              i.allow_partial_payments, i.customer_id, c.name AS customer_name, c.company_name AS customer_company_name,
              (i.status = 'sent' AND i.due_date < CURRENT_DATE) AS is_overdue,
              COALESCE((SELECT SUM(ip.amount) FROM invoice_payments ip WHERE ip.invoice_id = i.id), 0) AS amount_paid
       FROM invoices i
       JOIN customers c ON c.id = i.customer_id
       WHERE i.company_id = $1
       ORDER BY i.invoice_number DESC`,
      [req.companyId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /admin/invoices failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load invoices." });
  }
});

// GET /api/admin/invoices/:id
// Full detail, including line items, the customer's contact info (used both
// for the edit form and to render/send the PDF), and -- for a partial-
// payments-enabled invoice -- the full payment ledger plus what's still
// owed.
router.get("/invoices/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      `SELECT i.*, c.name AS customer_name, c.company_name AS customer_company_name, c.email AS customer_email, c.phone AS customer_phone,
              c.street AS customer_street, c.city AS customer_city, c.state AS customer_state, c.zip AS customer_zip,
              (i.status = 'sent' AND i.due_date < CURRENT_DATE) AS is_overdue
       FROM invoices i
       JOIN customers c ON c.id = i.customer_id
       WHERE i.id = $1 AND i.company_id = $2`,
      [id, req.companyId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "Invoice not found" });

    const items = await db.query(
      `SELECT id, description, quantity, unit_price, (quantity * unit_price) AS amount
       FROM invoice_line_items WHERE invoice_id = $1 ORDER BY sort_order`,
      [id]
    );
    const payments = await db.query(
      `SELECT id, amount, payment_method, check_number, paid_at FROM invoice_payments WHERE invoice_id = $1 ORDER BY paid_at`,
      [id]
    );
    const amountPaid = payments.rows.reduce((sum, p) => sum + Number(p.amount), 0);
    const invoice = result.rows[0];
    res.json({
      ...invoice,
      line_items: items.rows,
      payments: payments.rows,
      amount_paid: amountPaid,
      balance_due: Math.max(0, Number(invoice.total) - amountPaid),
      payments_remaining: Math.max(0, MAX_INVOICE_PAYMENTS - payments.rowCount),
    });
  } catch (err) {
    console.error("GET /admin/invoices/:id failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load invoice." });
  }
});

// GET /api/admin/invoices/:id/pdf
// Regenerates the invoice PDF on demand (from the same data used to email
// it) and streams it back so Jeremy can see exactly what a customer
// received, for any invoice status -- including a draft that hasn't been
// sent yet, as a preview. Nothing is stored -- this is rendered fresh every
// time it's requested.
router.get("/invoices/:id/pdf", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      `SELECT i.*, c.name AS customer_name, c.company_name AS customer_company_name, c.email AS customer_email, c.phone AS customer_phone,
              c.street AS customer_street, c.city AS customer_city, c.state AS customer_state, c.zip AS customer_zip
       FROM invoices i
       JOIN customers c ON c.id = i.customer_id
       WHERE i.id = $1 AND i.company_id = $2`,
      [id, req.companyId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "Invoice not found" });
    const invoice = result.rows[0];

    const itemsResult = await db.query(
      `SELECT description, quantity, unit_price FROM invoice_line_items WHERE invoice_id = $1 ORDER BY sort_order`,
      [id]
    );
    const companyResult = await db.query(
      `SELECT name, logo_data, stripe_connect_status FROM companies WHERE id = $1`,
      [req.companyId]
    );
    const company = companyResult.rows[0];

    const pdfBuffer = await renderInvoicePdf({
      companyName: company.name,
      invoice,
      customer: {
        name: invoice.customer_name,
        company_name: invoice.customer_company_name,
        email: invoice.customer_email,
        phone: invoice.customer_phone,
        street: invoice.customer_street,
        city: invoice.customer_city,
        state: invoice.customer_state,
        zip: invoice.customer_zip,
      },
      lineItems: itemsResult.rows,
      logoBuffer: company.logo_data || null,
      payUrl: canAcceptOnlinePayments(company.stripe_connect_status)
        ? `${FRONTEND_URL}/pay-invoice.html?id=${invoice.id}`
        : null,
    });

    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", `inline; filename="invoice-${invoice.invoice_number}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error("GET /admin/invoices/:id/pdf failed:", err);
    res.status(500).json({ error: err.message || "Couldn't generate invoice PDF." });
  }
});

// POST /api/admin/invoices
// Body: { customer_id, job_id?, payment_terms, issue_date?, tax_rate?, notes?, line_items: [{description, quantity, unit_price}] }
// Saved as a draft, then immediately emailed to the customer -- the
// response's status will be "sent" if that succeeded. If the customer has
// no email on file (or sending otherwise fails), it's left as a draft and
// the response includes a `send_warning` explaining why, so nothing is
// silently lost -- the manual Send button can be used once that's fixed.
router.post("/invoices", async (req, res) => {
  const client = await db.pool.connect();
  try {
    const { customer_id, job_id, payment_terms, issue_date, tax_rate, notes, line_items, allow_partial_payments } = req.body;
    if (!customer_id) return res.status(400).json({ error: "customer_id is required" });
    if (!Array.isArray(line_items) || line_items.length === 0) {
      return res.status(400).json({ error: "At least one line item is required" });
    }
    const terms = payment_terms || "due_on_receipt";
    if (!PAYMENT_TERMS.includes(terms)) {
      return res.status(400).json({ error: `payment_terms must be one of: ${PAYMENT_TERMS.join(", ")}` });
    }
    for (const item of line_items) {
      if (!item.description || item.quantity == null || item.unit_price == null) {
        return res.status(400).json({ error: "Each line item needs description, quantity, and unit_price" });
      }
    }

    const ownsCustomer = await client.query(`SELECT id FROM customers WHERE id = $1 AND company_id = $2`, [customer_id, req.companyId]);
    if (ownsCustomer.rowCount === 0) return res.status(400).json({ error: "Customer not found" });

    let jobId = null;
    if (job_id) {
      const ownsJob = await client.query(`SELECT id FROM jobs WHERE id = $1 AND company_id = $2`, [job_id, req.companyId]);
      if (ownsJob.rowCount === 0) return res.status(400).json({ error: "Job not found" });
      jobId = job_id;
    }

    const issueDate = issue_date || new Date().toISOString().slice(0, 10);
    const dueDate = computeDueDate(issueDate, terms);
    const { subtotal, taxAmount, total } = computeInvoiceTotals(line_items, tax_rate || 0);

    await client.query("BEGIN");
    // Per-company advisory lock so two invoices created at the same instant
    // can't both land on the same invoice_number.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [req.companyId]);
    const numResult = await client.query(
      `SELECT COALESCE(MAX(invoice_number), 0) + 1 AS next FROM invoices WHERE company_id = $1`,
      [req.companyId]
    );
    const invoiceNumber = numResult.rows[0].next;

    const invoiceResult = await client.query(
      `INSERT INTO invoices (company_id, customer_id, job_id, invoice_number, payment_terms, issue_date, due_date, notes, subtotal, tax_rate, tax_amount, total, allow_partial_payments)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [req.companyId, customer_id, jobId, invoiceNumber, terms, issueDate, dueDate, notes || null, subtotal, tax_rate || 0, taxAmount, total, !!allow_partial_payments]
    );
    const invoice = invoiceResult.rows[0];

    for (let i = 0; i < line_items.length; i++) {
      const item = line_items[i];
      await client.query(
        `INSERT INTO invoice_line_items (invoice_id, description, quantity, unit_price, sort_order, catalog_item_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [invoice.id, item.description, item.quantity, item.unit_price, i, item.catalog_item_id || null]
      );
    }

    await client.query("COMMIT");

    // Reserves stock for any line item picked from a tracked catalog item --
    // this route is for an invoice created directly (not from a quote), so
    // nothing could already be holding these items. A quote converted to an
    // invoice goes through POST /quotes/:id/convert-to-invoice instead, which
    // only places a hold if a pull sheet hasn't already claimed it.
    await placeHoldsForLineItems(line_items, req.companyId);

    let finalInvoice = invoice;
    let sendWarning = null;
    try {
      finalInvoice = await sendInvoiceNow(invoice.id, req.companyId);
    } catch (sendErr) {
      if (!sendErr.expected) console.error("Auto-send on invoice creation failed:", sendErr);
      sendWarning = sendErr.message || "Couldn't send the invoice automatically.";
    }

    res.status(201).json({
      ...finalInvoice,
      line_items: line_items.map((it, i) => ({ ...it, sort_order: i })),
      send_warning: sendWarning,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("POST /admin/invoices failed:", err);
    res.status(500).json({ error: err.message || "Couldn't create invoice." });
  } finally {
    client.release();
  }
});

// PATCH /api/admin/invoices/:id
// Body: any of { customer_id, job_id, payment_terms, issue_date, tax_rate, notes, line_items }
// Only allowed while the invoice is still a draft -- once it's been sent,
// the numbers on the customer's copy shouldn't silently change out from
// under them. Void it and create a new one instead. After saving, this
// also attempts to auto-send -- useful for a draft that stayed a draft
// because the customer had no email on file yet (add one, then re-save).
router.patch("/invoices/:id", async (req, res) => {
  const client = await db.pool.connect();
  try {
    const { id } = req.params;
    const owns = await client.query(`SELECT * FROM invoices WHERE id = $1 AND company_id = $2`, [id, req.companyId]);
    if (owns.rowCount === 0) return res.status(404).json({ error: "Invoice not found" });
    if (owns.rows[0].status !== "draft") {
      return res.status(400).json({ error: "Only draft invoices can be edited. Void it and create a new one instead." });
    }
    const existing = owns.rows[0];
    const { customer_id, job_id, payment_terms, issue_date, tax_rate, notes, line_items, allow_partial_payments } = req.body;

    if (customer_id !== undefined) {
      const ownsCustomer = await client.query(`SELECT id FROM customers WHERE id = $1 AND company_id = $2`, [customer_id, req.companyId]);
      if (ownsCustomer.rowCount === 0) return res.status(400).json({ error: "Customer not found" });
    }
    if (job_id) {
      const ownsJob = await client.query(`SELECT id FROM jobs WHERE id = $1 AND company_id = $2`, [job_id, req.companyId]);
      if (ownsJob.rowCount === 0) return res.status(400).json({ error: "Job not found" });
    }
    const terms = payment_terms !== undefined ? payment_terms : existing.payment_terms;
    if (!PAYMENT_TERMS.includes(terms)) {
      return res.status(400).json({ error: `payment_terms must be one of: ${PAYMENT_TERMS.join(", ")}` });
    }

    // Fetched before any replacement so the old holds can be released after
    // commit, regardless of whether line_items is being replaced this call.
    const oldItemsResult = await client.query(
      `SELECT catalog_item_id, quantity FROM invoice_line_items WHERE invoice_id = $1`,
      [id]
    );
    const oldItemsForRelease = oldItemsResult.rows;

    let items = line_items;
    if (items !== undefined) {
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: "At least one line item is required" });
      }
      for (const item of items) {
        if (!item.description || item.quantity == null || item.unit_price == null) {
          return res.status(400).json({ error: "Each line item needs description, quantity, and unit_price" });
        }
      }
    } else {
      const currentItems = await client.query(
        `SELECT description, quantity, unit_price FROM invoice_line_items WHERE invoice_id = $1 ORDER BY sort_order`,
        [id]
      );
      items = currentItems.rows;
    }

    const issueDate = issue_date !== undefined ? issue_date : existing.issue_date.toISOString().slice(0, 10);
    const dueDate = computeDueDate(issueDate, terms);
    const taxRate = tax_rate !== undefined ? tax_rate : existing.tax_rate;
    const { subtotal, taxAmount, total } = computeInvoiceTotals(items, taxRate);

    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE invoices SET customer_id = $1, job_id = $2, payment_terms = $3, issue_date = $4, due_date = $5,
              notes = $6, tax_rate = $7, subtotal = $8, tax_amount = $9, total = $10, allow_partial_payments = $11
       WHERE id = $12
       RETURNING *`,
      [
        customer_id !== undefined ? customer_id : existing.customer_id,
        job_id !== undefined ? (job_id || null) : existing.job_id,
        terms,
        issueDate,
        dueDate,
        notes !== undefined ? notes : existing.notes,
        taxRate,
        subtotal,
        taxAmount,
        total,
        allow_partial_payments !== undefined ? !!allow_partial_payments : existing.allow_partial_payments,
        id,
      ]
    );

    if (line_items !== undefined) {
      await client.query(`DELETE FROM invoice_line_items WHERE invoice_id = $1`, [id]);
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        await client.query(
          `INSERT INTO invoice_line_items (invoice_id, description, quantity, unit_price, sort_order, catalog_item_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, item.description, item.quantity, item.unit_price, i, item.catalog_item_id || null]
        );
      }
    }

    await client.query("COMMIT");

    // Line items were replaced -- release the old reservation and place a
    // fresh one for the new quantities/items, rather than trying to diff old
    // vs. new (simpler and correct even if items were reordered/removed).
    if (line_items !== undefined) {
      await releaseHoldsForLineItems(oldItemsForRelease, req.companyId);
      await placeHoldsForLineItems(items, req.companyId);
    }

    let finalInvoice = result.rows[0];
    let sendWarning = null;
    try {
      finalInvoice = await sendInvoiceNow(id, req.companyId);
    } catch (sendErr) {
      if (!sendErr.expected) console.error("Auto-send on invoice update failed:", sendErr);
      sendWarning = sendErr.message || "Couldn't send the invoice automatically.";
    }

    res.json({ ...finalInvoice, send_warning: sendWarning });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("PATCH /admin/invoices/:id failed:", err);
    res.status(500).json({ error: err.message || "Couldn't update invoice." });
  } finally {
    client.release();
  }
});

// DELETE /api/admin/invoices/:id
// Only draft invoices can be deleted outright -- once sent, use void
// instead so the invoice number and history stay intact.
router.delete("/invoices/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const owns = await db.query(`SELECT status FROM invoices WHERE id = $1 AND company_id = $2`, [id, req.companyId]);
    if (owns.rowCount === 0) return res.status(404).json({ error: "Invoice not found" });
    if (owns.rows[0].status !== "draft") {
      return res.status(400).json({ error: "Only draft invoices can be deleted. Void it instead." });
    }
    const itemsForRelease = await db.query(
      `SELECT catalog_item_id, quantity FROM invoice_line_items WHERE invoice_id = $1`,
      [id]
    );
    await db.query(`DELETE FROM invoices WHERE id = $1`, [id]);
    await releaseHoldsForLineItems(itemsForRelease.rows, req.companyId);
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /admin/invoices/:id failed:", err);
    res.status(500).json({ error: err.message || "Couldn't delete invoice." });
  }
});

// POST /api/admin/invoices/:id/send
// Manual send/resend -- the same logic new invoices trigger automatically
// on save, exposed here for resending as a reminder, or for a draft that
// didn't auto-send the first time (e.g. the customer had no email on file
// yet).
router.post("/invoices/:id/send", async (req, res) => {
  try {
    const invoice = await sendInvoiceNow(req.params.id, req.companyId);
    res.json(invoice);
  } catch (err) {
    if (!err.expected) console.error("POST /admin/invoices/:id/send failed:", err);
    res.status(err.status || 500).json({ error: err.message || "Couldn't send invoice." });
  }
});

// PATCH /api/admin/invoices/:id/mark-paid
// Body: { payment_method, check_number? } -- payment_method is one of
// card/check/cash/other. Doesn't process any payment itself; this just
// records how payment came in (a check that arrived in the mail, a card run
// through a separate terminal, cash, etc.) so the invoice's status reflects
// reality. check_number is optional and only kept when payment_method is
// "check" -- lets an admin note which check paid an invoice for later
// reference/reconciliation against a bank statement.
router.patch("/invoices/:id/mark-paid", async (req, res) => {
  try {
    const { id } = req.params;
    const { payment_method, check_number } = req.body;
    if (!PAYMENT_METHODS.includes(payment_method)) {
      return res.status(400).json({ error: `payment_method must be one of: ${PAYMENT_METHODS.join(", ")}` });
    }
    const owns = await db.query(`SELECT status, total FROM invoices WHERE id = $1 AND company_id = $2`, [id, req.companyId]);
    if (owns.rowCount === 0) return res.status(404).json({ error: "Invoice not found" });
    if (owns.rows[0].status === "void") return res.status(400).json({ error: "Can't mark a voided invoice as paid." });
    if (owns.rows[0].status === "paid") return res.status(400).json({ error: "This invoice has already been paid in full." });

    // Settles whatever's still owed in one shot -- for a normal invoice
    // that's the whole total, but for a partial-payments invoice that
    // already has some money collected, it's just the remaining balance.
    // Same MAX_INVOICE_PAYMENTS cap as POST /invoices/:id/payments applies
    // here too, since this still adds one more row to the same ledger.
    const paymentsSoFar = await db.query(
      `SELECT COALESCE(SUM(amount), 0) AS paid, COUNT(*) AS cnt FROM invoice_payments WHERE invoice_id = $1`,
      [id]
    );
    const alreadyPaid = Number(paymentsSoFar.rows[0].paid);
    const paymentCount = Number(paymentsSoFar.rows[0].cnt);
    const remaining = Math.round((Number(owns.rows[0].total) - alreadyPaid) * 100) / 100;
    if (remaining <= 0) {
      return res.status(400).json({ error: "This invoice has already been paid in full." });
    }
    if (paymentCount >= MAX_INVOICE_PAYMENTS) {
      return res.status(400).json({ error: `This invoice has already reached the ${MAX_INVOICE_PAYMENTS}-payment limit -- void it or contact support instead of recording another payment.` });
    }

    const checkNumberValue = payment_method === "check" && check_number ? String(check_number).trim().slice(0, 50) || null : null;

    await db.query(
      `INSERT INTO invoice_payments (company_id, invoice_id, amount, payment_method, check_number) VALUES ($1, $2, $3, $4, $5)`,
      [req.companyId, id, remaining, payment_method, checkNumberValue]
    );

    const result = await db.query(
      `UPDATE invoices SET status = 'paid', payment_method = $1, check_number = $2, paid_at = now() WHERE id = $3 RETURNING *`,
      [payment_method, checkNumberValue, id]
    );
    // Paid means the reserved stock is actually gone now -- consume it
    // rather than just release the hold. Only whatever hasn't already been
    // physically pulled (via a fulfilled pull sheet for this invoice) gets
    // subtracted here, so a job that had its material pulled ahead of
    // payment isn't double-consumed.
    const paidItems = await db.query(
      `SELECT catalog_item_id, quantity FROM invoice_line_items WHERE invoice_id = $1`,
      [id]
    );
    await consumeRemainingAfterPulls(paidItems.rows, "invoice", id, req.companyId);
    res.json(result.rows[0]);
  } catch (err) {
    console.error("PATCH /admin/invoices/:id/mark-paid failed:", err);
    res.status(500).json({ error: err.message || "Couldn't mark invoice as paid." });
  }
});

// POST /api/admin/invoices/:id/payments
// Body: { amount, payment_method, check_number? }
// Records one installment toward an invoice that has partial payments
// turned on -- a normal invoice uses Mark Paid instead, which settles the
// whole remaining balance in one go. Up to MAX_INVOICE_PAYMENTS payments
// total, whether recorded here or paid online through Stripe (see
// routes/payments.js). The moment a payment brings the balance to exactly
// zero, this behaves just like Mark Paid -- status flips to 'paid' and the
// reserved stock is actually consumed; otherwise the invoice moves to
// 'partial' and inventory doesn't change yet.
router.post("/invoices/:id/payments", async (req, res) => {
  try {
    const { id } = req.params;
    const { amount, payment_method, check_number } = req.body;
    if (!PAYMENT_METHODS.includes(payment_method)) {
      return res.status(400).json({ error: `payment_method must be one of: ${PAYMENT_METHODS.join(", ")}` });
    }
    const amountNum = Number(amount);
    if (!(amountNum > 0)) {
      return res.status(400).json({ error: "Enter a payment amount greater than $0." });
    }

    const owns = await db.query(`SELECT status, total, allow_partial_payments FROM invoices WHERE id = $1 AND company_id = $2`, [id, req.companyId]);
    if (owns.rowCount === 0) return res.status(404).json({ error: "Invoice not found" });
    const invoiceRow = owns.rows[0];
    if (invoiceRow.status === "void") return res.status(400).json({ error: "Can't record a payment on a voided invoice." });
    if (invoiceRow.status === "paid") return res.status(400).json({ error: "This invoice has already been paid in full." });
    if (!invoiceRow.allow_partial_payments) {
      return res.status(400).json({ error: "Partial payments aren't turned on for this invoice -- use Mark Paid to settle it in full instead." });
    }

    const paymentsSoFar = await db.query(
      `SELECT COALESCE(SUM(amount), 0) AS paid, COUNT(*) AS cnt FROM invoice_payments WHERE invoice_id = $1`,
      [id]
    );
    const alreadyPaid = Number(paymentsSoFar.rows[0].paid);
    const paymentCount = Number(paymentsSoFar.rows[0].cnt);
    const remaining = Math.round((Number(invoiceRow.total) - alreadyPaid) * 100) / 100;

    if (paymentCount >= MAX_INVOICE_PAYMENTS) {
      return res.status(400).json({ error: `This invoice has already reached the ${MAX_INVOICE_PAYMENTS}-payment limit.` });
    }
    if (amountNum > remaining + 0.001) {
      return res.status(400).json({ error: `That's more than the $${remaining.toFixed(2)} still owed on this invoice.` });
    }

    const checkNumberValue = payment_method === "check" && check_number ? String(check_number).trim().slice(0, 50) || null : null;

    await db.query(
      `INSERT INTO invoice_payments (company_id, invoice_id, amount, payment_method, check_number) VALUES ($1, $2, $3, $4, $5)`,
      [req.companyId, id, amountNum, payment_method, checkNumberValue]
    );

    const newRemaining = Math.round((remaining - amountNum) * 100) / 100;
    const isPaidInFull = newRemaining <= 0.001;

    const result = await db.query(
      `UPDATE invoices
       SET status = $1, payment_method = $2, check_number = $3, paid_at = CASE WHEN $1 = 'paid' THEN now() ELSE paid_at END
       WHERE id = $4 RETURNING *`,
      [isPaidInFull ? "paid" : "partial", payment_method, checkNumberValue, id]
    );

    if (isPaidInFull) {
      const paidItems = await db.query(`SELECT catalog_item_id, quantity FROM invoice_line_items WHERE invoice_id = $1`, [id]);
      await consumeRemainingAfterPulls(paidItems.rows, "invoice", id, req.companyId);
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("POST /admin/invoices/:id/payments failed:", err);
    res.status(500).json({ error: err.message || "Couldn't record payment." });
  }
});

// POST /api/admin/invoices/:id/resend-receipt
// Body: { email } -- optional. Manually re-sends the same payment-received
// email normally sent automatically the instant an online payment clears
// (see markInvoicePaidFromStripe in routes/payments.js). This is the only
// way an in-person/phone payment (cash, check, card run elsewhere) ever gets
// a receipt at all, since those are marked paid by hand and never trigger
// that automatic email. If no email is given, falls back to the customer's
// email on file; lets the admin send to a different address instead
// (a coworker who handles the customer's books, etc.) without having to
// change the customer's own contact info to do it.
router.post("/invoices/:id/resend-receipt", async (req, res) => {
  try {
    const { id } = req.params;
    const emailOverride = (req.body.email || "").trim();

    const result = await db.query(
      `SELECT i.*, c.email AS customer_email
       FROM invoices i JOIN customers c ON c.id = i.customer_id
       WHERE i.id = $1 AND i.company_id = $2`,
      [id, req.companyId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "Invoice not found" });
    const invoice = result.rows[0];

    if (invoice.status !== "paid") {
      return res.status(400).json({ error: "This invoice hasn't been paid yet." });
    }
    const to = emailOverride || invoice.customer_email;
    if (!to) {
      return res.status(400).json({ error: "No email on file for this customer -- enter one to send the receipt to." });
    }

    const companyResult = await db.query(`SELECT name FROM companies WHERE id = $1`, [req.companyId]);
    await sendPaymentReceiptEmail({ to, companyName: companyResult.rows[0].name, invoice });
    res.json({ message: `Receipt sent to ${to}.` });
  } catch (err) {
    console.error("POST /admin/invoices/:id/resend-receipt failed:", err);
    res.status(500).json({ error: err.message || "Couldn't send receipt. Please try again." });
  }
});

// PATCH /api/admin/invoices/:id/void
// Voids an invoice (sent by mistake, job fell through, etc.) without
// deleting it, so the invoice number and history stay intact.
router.patch("/invoices/:id/void", async (req, res) => {
  try {
    const { id } = req.params;
    const owns = await db.query(`SELECT status FROM invoices WHERE id = $1 AND company_id = $2`, [id, req.companyId]);
    if (owns.rowCount === 0) return res.status(404).json({ error: "Invoice not found" });
    if (owns.rows[0].status === "paid") {
      return res.status(400).json({ error: "This invoice has already been paid in full and can't be voided. Any refund has to be handled separately." });
    }
    // Note for a partially-paid invoice: this only stops billing for
    // whatever's left and releases the still-outstanding hold -- it doesn't
    // refund what's already been collected. Any refund for money already in
    // hand has to be issued separately (Stripe dashboard, or by hand for a
    // manually-recorded payment).
    const result = await db.query(
      `UPDATE invoices SET status = 'void' WHERE id = $1 AND company_id = $2 RETURNING *`,
      [id, req.companyId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "Invoice not found" });
    // Voided before full payment -- release whatever stock this invoice had
    // reserved (a fully-paid invoice is blocked above -- mark-paid/the final
    // partial payment already consumed the hold, and rejects already-void
    // invoices, so there's no risk of double-releasing a consumed
    // reservation).
    const itemsForRelease = await db.query(
      `SELECT catalog_item_id, quantity FROM invoice_line_items WHERE invoice_id = $1`,
      [id]
    );
    await releaseHoldsForLineItems(itemsForRelease.rows, req.companyId);

    const invoice = result.rows[0];

    // If this invoice came from a quote, the quote shouldn't keep showing
    // as "accepted" once the work it was for has been called off -- mark it
    // void too (distinct from "declined", which means the customer said no;
    // this means the job/invoice itself got cancelled after being accepted).
    if (invoice.quote_id) {
      await db.query(`UPDATE quotes SET status = 'void' WHERE id = $1 AND company_id = $2`, [invoice.quote_id, req.companyId]);
    }

    // Any pull sheet still open (or reported-pulled but not yet fulfilled)
    // for this job is no longer relevant -- there's nothing left to pull
    // for a cancelled invoice. A fulfilled one is left alone since it's
    // already a real record of inventory that was actually removed.
    // Matches both a pull sheet already reassigned to this invoice, and one
    // that was built against the quote and never got that far.
    //
    // An invoice-sourced sheet doesn't hold its own separate reservation
    // (the invoice's own hold, just released above, already covers it), but
    // a quote-sourced one that never got relabeled -- e.g. built against the
    // quote and this invoice went straight to void before ever converting
    // cleanly -- does hold its own, so that one needs releasing here too.
    const staleSheets = await db.query(
      `SELECT id FROM pull_sheets
       WHERE company_id = $1 AND status != 'fulfilled' AND source_type = 'quote' AND source_id = $2`,
      [req.companyId, invoice.quote_id]
    );
    for (const sheet of staleSheets.rows) {
      const sheetItems = await db.query(`SELECT catalog_item_id, quantity FROM pull_sheet_items WHERE pull_sheet_id = $1`, [sheet.id]);
      await releaseHoldsForLineItems(sheetItems.rows, req.companyId);
    }
    await db.query(
      `DELETE FROM pull_sheets
       WHERE company_id = $1 AND status != 'fulfilled'
         AND ((source_type = 'invoice' AND source_id = $2) OR (source_type = 'quote' AND source_id = $3))`,
      [req.companyId, id, invoice.quote_id]
    );

    res.json(invoice);
  } catch (err) {
    console.error("PATCH /admin/invoices/:id/void failed:", err);
    res.status(500).json({ error: err.message || "Couldn't void invoice." });
  }
});

// ---------- Quotes ----------
// A quote (estimate) is priced up for a customer before any work is booked.
// It shares its line-item/tax/total math with invoices (computeInvoiceTotals
// works on either), but has its own sequential numbering, its own simpler
// draft -> sent -> accepted/declined status, and no payment concept at all
// -- it doesn't owe anything until it's converted into a job and/or an
// invoice. Like invoices, a new quote is auto-sent right after it's created
// (see sendQuoteNow, used by both POST /quotes and POST /quotes/:id/send) --
// if the customer has no email on file, or sending otherwise fails, the
// quote is still saved as a draft and the failure comes back as
// send_warning instead of blocking creation.

// GET /api/admin/quotes
router.get("/quotes", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT q.id, q.quote_number, q.status, q.issue_date, q.expiration_date,
              q.subtotal, q.tax_rate, q.tax_amount, q.total, q.sent_at, q.created_at,
              q.converted_job_id, q.converted_invoice_id,
              q.customer_id, c.name AS customer_name, c.company_name AS customer_company_name,
              (q.status = 'sent' AND q.expiration_date IS NOT NULL AND q.expiration_date < CURRENT_DATE) AS is_expired
       FROM quotes q
       JOIN customers c ON c.id = q.customer_id
       WHERE q.company_id = $1
       ORDER BY q.quote_number DESC`,
      [req.companyId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /admin/quotes failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load quotes." });
  }
});

// GET /api/admin/quotes/:id
router.get("/quotes/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      `SELECT q.*, c.name AS customer_name, c.company_name AS customer_company_name, c.email AS customer_email, c.phone AS customer_phone,
              c.street AS customer_street, c.city AS customer_city, c.state AS customer_state, c.zip AS customer_zip,
              (q.status = 'sent' AND q.expiration_date IS NOT NULL AND q.expiration_date < CURRENT_DATE) AS is_expired
       FROM quotes q
       JOIN customers c ON c.id = q.customer_id
       WHERE q.id = $1 AND q.company_id = $2`,
      [id, req.companyId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "Quote not found" });

    const items = await db.query(
      `SELECT id, description, quantity, unit_price, (quantity * unit_price) AS amount
       FROM quote_line_items WHERE quote_id = $1 ORDER BY sort_order`,
      [id]
    );
    res.json({ ...result.rows[0], line_items: items.rows });
  } catch (err) {
    console.error("GET /admin/quotes/:id failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load quote." });
  }
});

// GET /api/admin/quotes/:id/pdf
// Regenerated fresh on every request, same as the invoice PDF -- works for
// any status, including a draft, as a preview.
router.get("/quotes/:id/pdf", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      `SELECT q.*, c.name AS customer_name, c.company_name AS customer_company_name, c.email AS customer_email, c.phone AS customer_phone,
              c.street AS customer_street, c.city AS customer_city, c.state AS customer_state, c.zip AS customer_zip
       FROM quotes q
       JOIN customers c ON c.id = q.customer_id
       WHERE q.id = $1 AND q.company_id = $2`,
      [id, req.companyId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "Quote not found" });
    const quote = result.rows[0];

    const itemsResult = await db.query(
      `SELECT description, quantity, unit_price FROM quote_line_items WHERE quote_id = $1 ORDER BY sort_order`,
      [id]
    );
    const companyResult = await db.query(`SELECT name, logo_data FROM companies WHERE id = $1`, [req.companyId]);
    const company = companyResult.rows[0];

    const pdfBuffer = await renderQuotePdf({
      companyName: company.name,
      quote,
      customer: {
        name: quote.customer_name,
        company_name: quote.customer_company_name,
        email: quote.customer_email,
        phone: quote.customer_phone,
        street: quote.customer_street,
        city: quote.customer_city,
        state: quote.customer_state,
        zip: quote.customer_zip,
      },
      lineItems: itemsResult.rows,
      logoBuffer: company.logo_data || null,
    });

    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", `inline; filename="quote-${quote.quote_number}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error("GET /admin/quotes/:id/pdf failed:", err);
    res.status(500).json({ error: err.message || "Couldn't generate quote PDF." });
  }
});

// Shared by both the auto-send-on-create step (POST /quotes below) and the
// explicit POST /quotes/:id/send route -- mirrors sendInvoiceNow. Bail-outs
// that are a normal, expected part of quote life (wrong status to send from,
// no customer email on file) are tagged err.expected so callers don't log
// them as real bugs, just surface the message (as send_warning on creation,
// or a plain error response on an explicit send).
async function sendQuoteNow(quoteId, companyId) {
  const result = await db.query(
    `SELECT q.*, c.name AS customer_name, c.company_name AS customer_company_name, c.email AS customer_email, c.phone AS customer_phone,
            c.street AS customer_street, c.city AS customer_city, c.state AS customer_state, c.zip AS customer_zip
     FROM quotes q JOIN customers c ON c.id = q.customer_id
     WHERE q.id = $1 AND q.company_id = $2`,
    [quoteId, companyId]
  );
  if (result.rowCount === 0) {
    const err = new Error("Quote not found");
    err.status = 404;
    throw err;
  }
  const quote = result.rows[0];
  if (!["draft", "sent"].includes(quote.status)) {
    const err = new Error("Only draft or sent quotes can be sent.");
    err.status = 400;
    err.expected = true;
    throw err;
  }
  if (!quote.customer_email) {
    const err = new Error("This customer doesn't have an email on file.");
    err.status = 400;
    err.expected = true;
    throw err;
  }

  const itemsResult = await db.query(
    `SELECT description, quantity, unit_price FROM quote_line_items WHERE quote_id = $1 ORDER BY sort_order`,
    [quoteId]
  );
  const companyResult = await db.query(`SELECT name, admin_email, logo_data FROM companies WHERE id = $1`, [companyId]);
  const company = companyResult.rows[0];

  const pdfBuffer = await renderQuotePdf({
    companyName: company.name,
    quote,
    customer: {
      name: quote.customer_name,
      company_name: quote.customer_company_name,
      email: quote.customer_email,
      phone: quote.customer_phone,
      street: quote.customer_street,
      city: quote.customer_city,
      state: quote.customer_state,
      zip: quote.customer_zip,
    },
    lineItems: itemsResult.rows,
    logoBuffer: company.logo_data || null,
  });

  await sendQuoteEmail({
    to: quote.customer_email,
    cc: company.admin_email,
    companyName: company.name,
    quote,
    pdfBuffer,
  });

  const updateResult = await db.query(
    `UPDATE quotes SET status = 'sent', sent_at = now() WHERE id = $1 RETURNING *`,
    [quoteId]
  );
  return updateResult.rows[0];
}

// POST /api/admin/quotes
// Body: { customer_id, issue_date?, expiration_date?, tax_rate?, notes?, line_items: [{description, quantity, unit_price}] }
router.post("/quotes", async (req, res) => {
  const client = await db.pool.connect();
  try {
    const { customer_id, issue_date, expiration_date, tax_rate, notes, line_items } = req.body;
    if (!customer_id) return res.status(400).json({ error: "customer_id is required" });
    if (!Array.isArray(line_items) || line_items.length === 0) {
      return res.status(400).json({ error: "At least one line item is required" });
    }
    for (const item of line_items) {
      if (!item.description || item.quantity == null || item.unit_price == null) {
        return res.status(400).json({ error: "Each line item needs description, quantity, and unit_price" });
      }
    }

    const ownsCustomer = await client.query(`SELECT id FROM customers WHERE id = $1 AND company_id = $2`, [customer_id, req.companyId]);
    if (ownsCustomer.rowCount === 0) return res.status(400).json({ error: "Customer not found" });

    const issueDate = issue_date || new Date().toISOString().slice(0, 10);
    const { subtotal, taxAmount, total } = computeInvoiceTotals(line_items, tax_rate || 0);

    await client.query("BEGIN");
    // Per-company advisory lock -- same trick invoice_number uses -- so two
    // quotes created at the same instant can't collide on the same number.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [req.companyId]);
    const numResult = await client.query(
      `SELECT COALESCE(MAX(quote_number), 0) + 1 AS next FROM quotes WHERE company_id = $1`,
      [req.companyId]
    );
    const quoteNumber = numResult.rows[0].next;

    const quoteResult = await client.query(
      `INSERT INTO quotes (company_id, customer_id, quote_number, issue_date, expiration_date, notes, subtotal, tax_rate, tax_amount, total)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [req.companyId, customer_id, quoteNumber, issueDate, expiration_date || null, notes || null, subtotal, tax_rate || 0, taxAmount, total]
    );
    const quote = quoteResult.rows[0];

    for (let i = 0; i < line_items.length; i++) {
      const item = line_items[i];
      await client.query(
        `INSERT INTO quote_line_items (quote_id, description, quantity, unit_price, sort_order, catalog_item_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [quote.id, item.description, item.quantity, item.unit_price, i, item.catalog_item_id || null]
      );
    }

    await client.query("COMMIT");

    // A quote never reserves stock on its own -- it's just a proposal.
    // Inventory only actually gets held once a pull sheet is built for this
    // job or it's converted to an invoice (see POST /pull-sheets and POST
    // /quotes/:id/convert-to-invoice).

    let finalQuote = quote;
    let sendWarning = null;
    try {
      finalQuote = await sendQuoteNow(quote.id, req.companyId);
    } catch (sendErr) {
      if (!sendErr.expected) console.error("Auto-send on quote creation failed:", sendErr);
      sendWarning = sendErr.message || "Couldn't send the quote automatically.";
    }

    res.status(201).json({
      ...finalQuote,
      line_items: line_items.map((it, i) => ({ ...it, sort_order: i })),
      send_warning: sendWarning,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("POST /admin/quotes failed:", err);
    res.status(500).json({ error: err.message || "Couldn't create quote." });
  } finally {
    client.release();
  }
});

// PATCH /api/admin/quotes/:id
// Body: any of { customer_id, issue_date, expiration_date, tax_rate, notes, line_items }
// Editable while draft or sent (a quote commonly gets revised after going
// out, unlike a sent invoice) -- locked once accepted/declined so the record
// of what was actually agreed to (or turned down) doesn't shift underfoot.
router.patch("/quotes/:id", async (req, res) => {
  const client = await db.pool.connect();
  try {
    const { id } = req.params;
    const owns = await client.query(`SELECT * FROM quotes WHERE id = $1 AND company_id = $2`, [id, req.companyId]);
    if (owns.rowCount === 0) return res.status(404).json({ error: "Quote not found" });
    if (!["draft", "sent"].includes(owns.rows[0].status)) {
      return res.status(400).json({ error: "Only draft or sent quotes can be edited." });
    }
    const existing = owns.rows[0];
    const { customer_id, issue_date, expiration_date, tax_rate, notes, line_items } = req.body;

    if (customer_id !== undefined) {
      const ownsCustomer = await client.query(`SELECT id FROM customers WHERE id = $1 AND company_id = $2`, [customer_id, req.companyId]);
      if (ownsCustomer.rowCount === 0) return res.status(400).json({ error: "Customer not found" });
    }

    let items = line_items;
    if (items !== undefined) {
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: "At least one line item is required" });
      }
      for (const item of items) {
        if (!item.description || item.quantity == null || item.unit_price == null) {
          return res.status(400).json({ error: "Each line item needs description, quantity, and unit_price" });
        }
      }
    } else {
      const currentItems = await client.query(
        `SELECT description, quantity, unit_price FROM quote_line_items WHERE quote_id = $1 ORDER BY sort_order`,
        [id]
      );
      items = currentItems.rows;
    }

    const taxRate = tax_rate !== undefined ? tax_rate : existing.tax_rate;
    const { subtotal, taxAmount, total } = computeInvoiceTotals(items, taxRate);

    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE quotes SET customer_id = $1, issue_date = $2, expiration_date = $3,
              notes = $4, tax_rate = $5, subtotal = $6, tax_amount = $7, total = $8
       WHERE id = $9
       RETURNING *`,
      [
        customer_id !== undefined ? customer_id : existing.customer_id,
        issue_date !== undefined ? issue_date : existing.issue_date.toISOString().slice(0, 10),
        expiration_date !== undefined ? (expiration_date || null) : existing.expiration_date,
        notes !== undefined ? notes : existing.notes,
        taxRate,
        subtotal,
        taxAmount,
        total,
        id,
      ]
    );

    if (line_items !== undefined) {
      await client.query(`DELETE FROM quote_line_items WHERE quote_id = $1`, [id]);
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        await client.query(
          `INSERT INTO quote_line_items (quote_id, description, quantity, unit_price, sort_order, catalog_item_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, item.description, item.quantity, item.unit_price, i, item.catalog_item_id || null]
        );
      }
    }

    await client.query("COMMIT");

    // A quote never holds stock on its own, so editing its line items has no
    // inventory hold to update -- see the model comment atop utils/inventory.js.

    res.json(result.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("PATCH /admin/quotes/:id failed:", err);
    res.status(500).json({ error: err.message || "Couldn't update quote." });
  } finally {
    client.release();
  }
});

// DELETE /api/admin/quotes/:id
// Only drafts can be deleted outright, matching invoices.
router.delete("/quotes/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const owns = await db.query(`SELECT status FROM quotes WHERE id = $1 AND company_id = $2`, [id, req.companyId]);
    if (owns.rowCount === 0) return res.status(404).json({ error: "Quote not found" });
    if (owns.rows[0].status !== "draft") {
      return res.status(400).json({ error: "Only draft quotes can be deleted." });
    }

    // The quote itself never holds stock (see the model comment atop
    // utils/inventory.js) -- but a pull sheet could already have been built
    // against it even while still a draft, and that pull sheet does hold its
    // own reservation. Release that before it's cleaned up along with the
    // quote, same as the mark-declined path.
    const openSheets = await db.query(
      `SELECT id FROM pull_sheets WHERE company_id = $1 AND source_type = 'quote' AND source_id = $2 AND status != 'fulfilled'`,
      [req.companyId, id]
    );
    for (const sheet of openSheets.rows) {
      const sheetItems = await db.query(`SELECT catalog_item_id, quantity FROM pull_sheet_items WHERE pull_sheet_id = $1`, [sheet.id]);
      await releaseHoldsForLineItems(sheetItems.rows, req.companyId);
    }
    await db.query(`DELETE FROM pull_sheets WHERE company_id = $1 AND source_type = 'quote' AND source_id = $2 AND status != 'fulfilled'`, [req.companyId, id]);

    await db.query(`DELETE FROM quotes WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /admin/quotes/:id failed:", err);
    res.status(500).json({ error: err.message || "Couldn't delete quote." });
  }
});

// POST /api/admin/quotes/:id/send
// Emails the quote PDF to the customer and marks it "sent". Also used
// internally right after a quote is created (see sendQuoteNow above) --
// this route stays around for re-sending an already-sent quote, or manually
// sending one whose auto-send failed (e.g. customer had no email on file
// yet at creation time, added since).
router.post("/quotes/:id/send", async (req, res) => {
  try {
    const quote = await sendQuoteNow(req.params.id, req.companyId);
    res.json(quote);
  } catch (err) {
    if (!err.expected) console.error("POST /admin/quotes/:id/send failed:", err);
    res.status(err.status || 500).json({ error: err.message || "Couldn't send quote." });
  }
});

// PATCH /api/admin/quotes/:id/mark-accepted
// PATCH /api/admin/quotes/:id/mark-declined
// Records the customer's decision. Doesn't do anything else on its own --
// converting to a job/invoice is a separate explicit action (a customer
// might accept but the work doesn't get scheduled for weeks).
router.patch("/quotes/:id/mark-accepted", async (req, res) => {
  try {
    const result = await db.query(
      `UPDATE quotes SET status = 'accepted' WHERE id = $1 AND company_id = $2 RETURNING *`,
      [req.params.id, req.companyId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "Quote not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("PATCH /admin/quotes/:id/mark-accepted failed:", err);
    res.status(500).json({ error: err.message || "Couldn't mark quote as accepted." });
  }
});

router.patch("/quotes/:id/mark-declined", async (req, res) => {
  try {
    const result = await db.query(
      `UPDATE quotes SET status = 'declined' WHERE id = $1 AND company_id = $2 RETURNING *`,
      [req.params.id, req.companyId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "Quote not found" });

    // The quote itself never held any stock (see the model comment atop
    // utils/inventory.js) -- but any pull sheet still open (or
    // reported-pulled but not yet fulfilled) for it does, so release that
    // reservation before clearing the sheet out. A fulfilled one is left
    // alone since it's already a real record of inventory that was actually
    // removed.
    const openSheets = await db.query(
      `SELECT id FROM pull_sheets WHERE company_id = $1 AND source_type = 'quote' AND source_id = $2 AND status != 'fulfilled'`,
      [req.companyId, req.params.id]
    );
    for (const sheet of openSheets.rows) {
      const sheetItems = await db.query(`SELECT catalog_item_id, quantity FROM pull_sheet_items WHERE pull_sheet_id = $1`, [sheet.id]);
      await releaseHoldsForLineItems(sheetItems.rows, req.companyId);
    }
    await db.query(
      `DELETE FROM pull_sheets WHERE company_id = $1 AND source_type = 'quote' AND source_id = $2 AND status != 'fulfilled'`,
      [req.companyId, req.params.id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error("PATCH /admin/quotes/:id/mark-declined failed:", err);
    res.status(500).json({ error: err.message || "Couldn't mark quote as declined." });
  }
});

// POST /api/admin/quotes/:id/convert-to-job
// Body: { title?, notes?, start_date, end_date, start_time?, color?, event_type?, employee_ids?, crew_ids? }
// Schedules the quoted work as a job, carrying over the quote's customer.
// Reuses the same color/event_type validation and crew/employee assignment
// expansion as the regular jobs route. Records the link both ways (quote ->
// converted_job_id) and bumps the quote to "accepted" if it wasn't already,
// since scheduling the work implies the customer said yes.
router.post("/quotes/:id/convert-to-job", async (req, res) => {
  try {
    const { id } = req.params;
    const quoteResult = await db.query(`SELECT * FROM quotes WHERE id = $1 AND company_id = $2`, [id, req.companyId]);
    if (quoteResult.rowCount === 0) return res.status(404).json({ error: "Quote not found" });
    const quote = quoteResult.rows[0];

    const { title, notes, start_date, end_date, start_time, color, event_type, employee_ids, crew_ids } = req.body;
    if (!start_date || !end_date) {
      return res.status(400).json({ error: "start_date and end_date are required" });
    }
    const jobColor = color || "rust";
    if (!JOB_COLORS[jobColor]) {
      return res.status(400).json({ error: `color must be one of: ${Object.keys(JOB_COLORS).join(", ")}` });
    }
    const eventType = event_type || "job";
    if (!EVENT_TYPES.includes(eventType)) {
      return res.status(400).json({ error: `event_type must be one of: ${EVENT_TYPES.join(", ")}` });
    }
    if (start_time && !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(start_time)) {
      return res.status(400).json({ error: "start_time must be in HH:MM format" });
    }

    const jobTitle = title || `Quote #${quote.quote_number}`;
    const jobResult = await db.query(
      `INSERT INTO jobs (company_id, title, notes, start_date, end_date, start_time, color, event_type, customer_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, title, notes, start_date, end_date, start_time, color, event_type, customer_id, created_at`,
      [req.companyId, jobTitle, notes !== undefined ? notes : quote.notes, start_date, end_date, start_time || null, jobColor, eventType, quote.customer_id]
    );
    const job = jobResult.rows[0];

    const assignments = await expandAssignments({ employee_ids, crew_ids, companyId: req.companyId });
    if (assignments.size > 0) {
      await Promise.all(
        Array.from(assignments.entries()).map(([employeeId, crewId]) =>
          db.query(
            `INSERT INTO job_assignments (job_id, employee_id, assigned_via_crew_id)
             VALUES ($1, $2, $3)`,
            [job.id, employeeId, crewId]
          )
        )
      );
      notifyAssigned(Array.from(assignments.keys()), job);
    }

    const updatedQuote = await db.query(
      `UPDATE quotes SET converted_job_id = $1, status = CASE WHEN status IN ('draft', 'sent') THEN 'accepted' ELSE status END
       WHERE id = $2 RETURNING *`,
      [job.id, id]
    );

    res.status(201).json({ job, quote: updatedQuote.rows[0] });
  } catch (err) {
    console.error("POST /admin/quotes/:id/convert-to-job failed:", err);
    res.status(500).json({ error: err.message || "Couldn't convert quote to a scheduled job." });
  }
});

// POST /api/admin/quotes/:id/convert-to-invoice
// Body: { payment_terms?, issue_date? } -- everything else (customer, line
// items, tax rate) carries over from the quote. Created as a draft, same as
// any other invoice -- NOT auto-sent, so the terms/due date can be reviewed
// first. Links both ways (invoices.quote_id / quotes.converted_invoice_id)
// and bumps the quote to "accepted" if it wasn't already.
router.post("/quotes/:id/convert-to-invoice", async (req, res) => {
  const client = await db.pool.connect();
  try {
    const { id } = req.params;
    const quoteResult = await client.query(`SELECT * FROM quotes WHERE id = $1 AND company_id = $2`, [id, req.companyId]);
    if (quoteResult.rowCount === 0) return res.status(404).json({ error: "Quote not found" });
    const quote = quoteResult.rows[0];

    const itemsResult = await client.query(
      `SELECT description, quantity, unit_price, catalog_item_id FROM quote_line_items WHERE quote_id = $1 ORDER BY sort_order`,
      [id]
    );
    if (itemsResult.rowCount === 0) return res.status(400).json({ error: "This quote has no line items to invoice." });

    const { payment_terms, issue_date, allow_partial_payments } = req.body;
    const terms = payment_terms || "due_on_receipt";
    if (!PAYMENT_TERMS.includes(terms)) {
      return res.status(400).json({ error: `payment_terms must be one of: ${PAYMENT_TERMS.join(", ")}` });
    }
    const issueDate = issue_date || new Date().toISOString().slice(0, 10);
    const dueDate = computeDueDate(issueDate, terms);
    const { subtotal, taxAmount, total } = computeInvoiceTotals(itemsResult.rows, quote.tax_rate);

    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [req.companyId]);
    const numResult = await client.query(
      `SELECT COALESCE(MAX(invoice_number), 0) + 1 AS next FROM invoices WHERE company_id = $1`,
      [req.companyId]
    );
    const invoiceNumber = numResult.rows[0].next;

    const invoiceResult = await client.query(
      `INSERT INTO invoices (company_id, customer_id, quote_id, invoice_number, payment_terms, issue_date, due_date, notes, subtotal, tax_rate, tax_amount, total, allow_partial_payments)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [req.companyId, quote.customer_id, quote.id, invoiceNumber, terms, issueDate, dueDate, quote.notes, subtotal, quote.tax_rate, taxAmount, total, !!allow_partial_payments]
    );
    const invoice = invoiceResult.rows[0];

    for (let i = 0; i < itemsResult.rows.length; i++) {
      const item = itemsResult.rows[i];
      await client.query(
        `INSERT INTO invoice_line_items (invoice_id, description, quantity, unit_price, sort_order, catalog_item_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [invoice.id, item.description, item.quantity, item.unit_price, i, item.catalog_item_id]
      );
    }
    // Any pull sheet already built (and possibly fulfilled) against the
    // quote needs to follow the job to its new invoice id -- otherwise the
    // "how much has already been pulled for this job" lookup used by both
    // pull-sheet building and mark-paid would stop finding it, and the same
    // material could get consumed a second time once this invoice is paid.
    const priorSheets = await client.query(
      `SELECT id FROM pull_sheets WHERE source_type = 'quote' AND source_id = $1 AND company_id = $2`,
      [id, req.companyId]
    );
    await client.query(
      `UPDATE pull_sheets SET source_type = 'invoice', source_id = $1 WHERE source_type = 'quote' AND source_id = $2 AND company_id = $3`,
      [invoice.id, id, req.companyId]
    );

    const updatedQuote = await client.query(
      `UPDATE quotes SET converted_invoice_id = $1, status = CASE WHEN status IN ('draft', 'sent') THEN 'accepted' ELSE status END
       WHERE id = $2 RETURNING *`,
      [invoice.id, id]
    );

    await client.query("COMMIT");

    // The quote itself never held any stock (see the model comment atop
    // utils/inventory.js). If a pull sheet was already built against it --
    // whether still open or already fulfilled -- that pull sheet is (or
    // was) the thing holding this job's reservation, and it just followed
    // along to the invoice above, so there's nothing new to hold. Only when
    // there's never been a pull sheet for this job does converting to an
    // invoice need to place a fresh hold itself.
    // Diagnostics run in a prior round confirmed: no stale pull sheet blocks
    // this, the line item's catalog_item_id is present, and the UPDATE
    // inside placeHoldsForLineItems increments quantity_on_hold by exactly
    // the expected amount, in this same request. So the write itself is
    // correct -- the remaining mismatch is on the read/display side, not
    // here. See utils/inventory.js for the (still in place) per-item
    // diagnostic that would catch a 0-row UPDATE.
    if (priorSheets.rowCount === 0) {
      await placeHoldsForLineItems(itemsResult.rows, req.companyId);
    }

    res.status(201).json({ invoice: { ...invoice, line_items: itemsResult.rows }, quote: updatedQuote.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("POST /admin/quotes/:id/convert-to-invoice failed:", err);
    res.status(500).json({ error: err.message || "Couldn't convert quote to an invoice." });
  } finally {
    client.release();
  }
});

// ---------- Reports ----------
// GET /api/admin/reports/summary?start=YYYY-MM-DD&end=YYYY-MM-DD
// Aggregates for the Reports tab's preset time ranges (1 week, 1 month,
// etc.) and the this-year-vs-last-year comparison, which just calls this
// twice with two different ranges. "Invoiced" is billed amount (non-draft,
// non-void invoices by issue date); "Paid" is what was actually collected
// (paid invoices by the date they were marked paid) -- these intentionally
// aren't the same number, since something can be invoiced in one period and
// paid in a later one.
router.get("/reports/summary", async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: "start and end are required" });

    const laborResult = await db.query(
      `SELECT COALESCE(SUM(d.worked_seconds), 0) AS total_seconds
       FROM time_entry_durations d
       JOIN employees e ON e.id = d.employee_id
       WHERE e.company_id = $1 AND d.clock_in >= $2::date AND d.clock_in < ($3::date + INTERVAL '1 day')`,
      [req.companyId, start, end]
    );

    const invoicedResult = await db.query(
      `SELECT COALESCE(SUM(total), 0) AS sum_total, COUNT(*) AS cnt
       FROM invoices
       WHERE company_id = $1 AND status NOT IN ('draft', 'void')
         AND issue_date >= $2::date AND issue_date <= $3::date`,
      [req.companyId, start, end]
    );

    // Sums actual money collected in this range from the invoice_payments
    // ledger, not invoices.total/status='paid' -- a partial-payments invoice
    // can have money land in one period and not reach "paid" (or reach it in
    // a later period), so summing whichever invoices happen to be fully
    // settled as of paid_at would either miss that money or count all of it
    // in the wrong period. cnt is invoices (not payments) touched in this
    // range, since one invoice with 2 installments in the same range should
    // still read as "1 invoice", not 2.
    const paidResult = await db.query(
      `SELECT COALESCE(SUM(amount), 0) AS sum_total, COUNT(DISTINCT invoice_id) AS cnt
       FROM invoice_payments
       WHERE company_id = $1
         AND paid_at >= $2::date AND paid_at < ($3::date + INTERVAL '1 day')`,
      [req.companyId, start, end]
    );

    // Labor cost mirrors the labor_hours query above (same clock_in-based
    // range) but multiplies each employee's worked hours by their own
    // hourly_rate before summing, so employees with different pay rates
    // are costed correctly. Employees with no rate set (NULL) contribute $0
    // -- this undercounts true cost until a rate is filled in for everyone,
    // which is called out to Jeremy in the UI rather than silently guessed.
    const laborCostResult = await db.query(
      `SELECT COALESCE(SUM((d.worked_seconds / 3600.0) * COALESCE(e.hourly_rate, 0)), 0) AS total_cost
       FROM time_entry_durations d
       JOIN employees e ON e.id = d.employee_id
       WHERE e.company_id = $1 AND d.clock_in >= $2::date AND d.clock_in < ($3::date + INTERVAL '1 day')`,
      [req.companyId, start, end]
    );

    const expenseResult = await db.query(
      `SELECT COALESCE(SUM(amount), 0) AS sum_total, COUNT(*) AS cnt
       FROM expenses
       WHERE company_id = $1 AND expense_date >= $2::date AND expense_date <= $3::date`,
      [req.companyId, start, end]
    );

    // What Stripe (processing) and the platform (0.5% cut) actually took out
    // of online payments collected in this range -- money that was part of
    // the invoice total but never reached this company's own bank account.
    // Only invoices paid through Stripe have anything here (the columns are
    // NULL for cash/check/etc.), which COALESCE(...,0) on each column (not
    // just the sum) handles correctly.
    // NOTE: these two columns still accumulate on the invoice itself rather
    // than per-payment, so this stays keyed to status='paid'/paid_at (the
    // date the invoice was fully settled) rather than the ledger. For a
    // partial-payments invoice paid online in installments across more than
    // one period, that can attribute an earlier installment's fee to the
    // period the *final* installment landed in -- a minor known edge case,
    // not worth a schema change to fix for now.
    const feeResult = await db.query(
      `SELECT COALESCE(SUM(COALESCE(stripe_processing_fee, 0)), 0) AS stripe_fee_total,
              COALESCE(SUM(COALESCE(platform_fee, 0)), 0) AS platform_fee_total
       FROM invoices
       WHERE company_id = $1 AND status = 'paid'
         AND paid_at >= $2::date AND paid_at < ($3::date + INTERVAL '1 day')`,
      [req.companyId, start, end]
    );

    res.json({
      labor_hours: Number(laborResult.rows[0].total_seconds) / 3600,
      invoice_total: Number(invoicedResult.rows[0].sum_total),
      invoice_count: Number(invoicedResult.rows[0].cnt),
      paid_invoice_total: Number(paidResult.rows[0].sum_total),
      paid_invoice_count: Number(paidResult.rows[0].cnt),
      labor_cost: Number(laborCostResult.rows[0].total_cost),
      expense_total: Number(expenseResult.rows[0].sum_total),
      expense_count: Number(expenseResult.rows[0].cnt),
      stripe_fee_total: Number(feeResult.rows[0].stripe_fee_total),
      platform_fee_total: Number(feeResult.rows[0].platform_fee_total),
    });
  } catch (err) {
    console.error("GET /admin/reports/summary failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load report." });
  }
});

// GET /api/admin/reports/labor-breakdown?start=YYYY-MM-DD&end=YYYY-MM-DD
// Per-employee hours + cost for the same date range reports/summary uses --
// powers the drill-down when someone clicks the Labor hours or Gross Profit
// bubble. Only includes employees who actually worked in the range (an
// employee with zero hours has nothing to show here even if they have a
// rate set).
router.get("/reports/labor-breakdown", async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: "start and end are required" });

    const result = await db.query(
      `SELECT e.id AS employee_id, e.name AS employee_name, e.hourly_rate,
              SUM(d.worked_seconds) AS total_seconds
       FROM time_entry_durations d
       JOIN employees e ON e.id = d.employee_id
       WHERE e.company_id = $1 AND d.clock_in >= $2::date AND d.clock_in < ($3::date + INTERVAL '1 day')
       GROUP BY e.id, e.name, e.hourly_rate
       ORDER BY e.name`,
      [req.companyId, start, end]
    );

    res.json(result.rows.map(function(r) {
      const hours = Number(r.total_seconds) / 3600;
      const rate = r.hourly_rate === null ? null : Number(r.hourly_rate);
      return {
        employee_id: r.employee_id,
        employee_name: r.employee_name,
        hours: hours,
        hourly_rate: rate,
        cost: rate === null ? 0 : hours * rate,
      };
    }));
  } catch (err) {
    console.error("GET /admin/reports/labor-breakdown failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load labor breakdown." });
  }
});

// GET /api/admin/reports/payments?start=YYYY-MM-DD&end=YYYY-MM-DD
// One row per payment recorded against an invoice in this date range --
// pulled from the invoice_payments ledger, not invoices.total/status='paid'
// -- for the Transactions list on the Billing tab. Every installment of a
// partial-payments invoice shows up on the day it was actually collected,
// instead of the whole invoice only appearing once (or not at all) on
// whatever day it eventually reaches "paid".
router.get("/reports/payments", async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: "start and end are required" });

    const result = await db.query(
      `SELECT ip.id, ip.invoice_id, i.invoice_number, c.name AS customer_name, c.company_name AS customer_company_name,
              ip.amount, ip.payment_method, ip.check_number, ip.paid_at,
              i.status AS invoice_status, i.total AS invoice_total
       FROM invoice_payments ip
       JOIN invoices i ON i.id = ip.invoice_id
       JOIN customers c ON c.id = i.customer_id
       WHERE ip.company_id = $1
         AND ip.paid_at >= $2::date AND ip.paid_at < ($3::date + INTERVAL '1 day')
       ORDER BY ip.paid_at DESC`,
      [req.companyId, start, end]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("GET /admin/reports/payments failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load payments." });
  }
});

// GET /api/admin/reports/monthly-profit?months=6
// Gross AND Net Profit for each of the trailing N calendar months (default
// 6, current month included), for the bar chart under the Reports tab's
// stat cards. Uses the exact same definition as computeProfits() on the
// frontend (paid revenue minus labor cost minus Stripe/platform fees, then
// minus logged expenses for Net) so the chart always agrees with the stat
// cards above it. Grouped with date_trunc('month', ...) against a single
// cutoff date rather than EXTRACT(MONTH) -- that would incorrectly merge
// e.g. January of two different years when the trailing window crosses a
// year boundary, which a plain month-number match can't tell apart.
router.get("/reports/monthly-profit", async (req, res) => {
  try {
    const months = Math.min(Math.max(parseInt(req.query.months, 10) || 6, 1), 24);

    const now = new Date();
    const rangeStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));

    const [paidResult, laborCostResult, feeResult, expenseResult] = await Promise.all([
      // From the invoice_payments ledger (not invoices.total/status='paid')
      // so each installment of a partial-payments invoice lands in the month
      // it actually arrived, same reasoning as reports/summary above.
      db.query(
        `SELECT date_trunc('month', paid_at) AS month, COALESCE(SUM(amount), 0) AS paid_total
         FROM invoice_payments
         WHERE company_id = $1 AND paid_at >= $2
         GROUP BY 1`,
        [req.companyId, rangeStart]
      ),
      db.query(
        `SELECT date_trunc('month', d.clock_in) AS month,
                COALESCE(SUM((d.worked_seconds / 3600.0) * COALESCE(e.hourly_rate, 0)), 0) AS labor_cost
         FROM time_entry_durations d
         JOIN employees e ON e.id = d.employee_id
         WHERE e.company_id = $1 AND d.clock_in >= $2
         GROUP BY 1`,
        [req.companyId, rangeStart]
      ),
      db.query(
        `SELECT date_trunc('month', paid_at) AS month,
                COALESCE(SUM(COALESCE(stripe_processing_fee, 0)), 0) AS stripe_fee_total,
                COALESCE(SUM(COALESCE(platform_fee, 0)), 0) AS platform_fee_total
         FROM invoices
         WHERE company_id = $1 AND status = 'paid' AND paid_at >= $2
         GROUP BY 1`,
        [req.companyId, rangeStart]
      ),
      db.query(
        `SELECT date_trunc('month', expense_date) AS month, COALESCE(SUM(amount), 0) AS expense_total
         FROM expenses
         WHERE company_id = $1 AND expense_date >= $2
         GROUP BY 1`,
        [req.companyId, rangeStart]
      ),
    ]);

    const keyOf = (d) => {
      const dt = new Date(d);
      return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}`;
    };
    const paidByMonth = {}, laborByMonth = {}, feeByMonth = {}, expenseByMonth = {};
    paidResult.rows.forEach((r) => { paidByMonth[keyOf(r.month)] = Number(r.paid_total); });
    laborCostResult.rows.forEach((r) => { laborByMonth[keyOf(r.month)] = Number(r.labor_cost); });
    feeResult.rows.forEach((r) => {
      feeByMonth[keyOf(r.month)] = Number(r.stripe_fee_total) + Number(r.platform_fee_total);
    });
    expenseResult.rows.forEach((r) => { expenseByMonth[keyOf(r.month)] = Number(r.expense_total); });

    const result = [];
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      const paidTotal = paidByMonth[key] || 0;
      const laborCost = laborByMonth[key] || 0;
      const feesTotal = feeByMonth[key] || 0;
      const expenseTotal = expenseByMonth[key] || 0;
      const grossProfit = paidTotal - laborCost - feesTotal;
      const netProfit = grossProfit - expenseTotal;
      result.push({
        month: key,
        label: d.toLocaleString("en-US", { month: "short", timeZone: "UTC" }),
        gross_profit: grossProfit,
        net_profit: netProfit,
      });
    }

    res.json({ months: result });
  } catch (err) {
    console.error("GET /admin/reports/monthly-profit failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load monthly profit." });
  }
});

// GET /api/admin/reports/payment-breakdown
// All-time totals by payment method, for the "Sales by payment type" donut
// on the Billing tab (that widget isn't date-ranged, so neither is this).
// Summed from the invoice_payments ledger rather than invoices.total/
// status='paid' -- a partial-payments invoice's installments are counted as
// they actually arrive, by whichever method each one used, instead of the
// whole invoice being credited to a single method only once/if it's fully
// paid.
router.get("/reports/payment-breakdown", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT payment_method, COUNT(*) AS cnt, COALESCE(SUM(amount), 0) AS sum_total
       FROM invoice_payments
       WHERE company_id = $1
       GROUP BY payment_method`,
      [req.companyId]
    );
    const methods = result.rows.map(function(r) {
      return { payment_method: r.payment_method, count: Number(r.cnt), total: Number(r.sum_total) };
    });
    const total = methods.reduce(function(s, m) { return s + m.total; }, 0);
    const count = methods.reduce(function(s, m) { return s + m.count; }, 0);
    res.json({ methods, total, count });
  } catch (err) {
    console.error("GET /admin/reports/payment-breakdown failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load payment breakdown." });
  }
});

// ---------- Expenses ----------
// Simple manually-logged business costs (materials, insurance, rent, etc.)
// that feed into Net Profit on the Reports tab. Deliberately minimal --
// date, amount, optional description -- for quick logging rather than full
// bookkeeping.

// GET /api/admin/expenses
router.get("/expenses", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT e.id, e.expense_date, e.amount, e.description, e.created_at, e.job_id, j.title AS job_title
       FROM expenses e
       LEFT JOIN jobs j ON j.id = e.job_id
       WHERE e.company_id = $1 ORDER BY e.expense_date DESC, e.created_at DESC`,
      [req.companyId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /admin/expenses failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load expenses." });
  }
});

// POST /api/admin/expenses
// Body: { expense_date, amount, description?, job_id? }
router.post("/expenses", async (req, res) => {
  try {
    const { expense_date, amount, description, job_id } = req.body;
    if (!expense_date) return res.status(400).json({ error: "expense_date is required" });
    if (amount === undefined || amount === null || isNaN(Number(amount))) {
      return res.status(400).json({ error: "amount is required" });
    }
    if (job_id) {
      const ownsJob = await db.query(`SELECT id FROM jobs WHERE id = $1 AND company_id = $2`, [job_id, req.companyId]);
      if (ownsJob.rowCount === 0) return res.status(400).json({ error: "job not found" });
    }
    const result = await db.query(
      `INSERT INTO expenses (company_id, expense_date, amount, description, job_id) VALUES ($1, $2, $3, $4, $5)
       RETURNING id, expense_date, amount, description, created_at, job_id`,
      [req.companyId, expense_date, Number(amount), description || null, job_id || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("POST /admin/expenses failed:", err);
    res.status(500).json({ error: err.message || "Couldn't create expense." });
  }
});

// PATCH /api/admin/expenses/:id
// Body: { expense_date?, amount?, description?, job_id? } -- job_id: null unassigns
router.patch("/expenses/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { expense_date, amount, description, job_id } = req.body;
    const owns = await db.query(`SELECT id FROM expenses WHERE id = $1 AND company_id = $2`, [id, req.companyId]);
    if (owns.rowCount === 0) return res.status(404).json({ error: "Expense not found" });

    if (amount !== undefined && isNaN(Number(amount))) {
      return res.status(400).json({ error: "amount must be a number" });
    }
    if (job_id) {
      const ownsJob = await db.query(`SELECT id FROM jobs WHERE id = $1 AND company_id = $2`, [job_id, req.companyId]);
      if (ownsJob.rowCount === 0) return res.status(400).json({ error: "job not found" });
    }

    const fields = [];
    const values = [];
    if (expense_date !== undefined) { values.push(expense_date); fields.push(`expense_date = $${values.length}`); }
    if (amount !== undefined) { values.push(Number(amount)); fields.push(`amount = $${values.length}`); }
    if (description !== undefined) { values.push(description || null); fields.push(`description = $${values.length}`); }
    if (job_id !== undefined) { values.push(job_id || null); fields.push(`job_id = $${values.length}`); }
    if (fields.length === 0) return res.status(400).json({ error: "Nothing to update" });

    values.push(id, req.companyId);
    const result = await db.query(
      `UPDATE expenses SET ${fields.join(", ")} WHERE id = $${values.length - 1} AND company_id = $${values.length}
       RETURNING id, expense_date, amount, description, created_at, job_id`,
      values
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("PATCH /admin/expenses/:id failed:", err);
    res.status(500).json({ error: err.message || "Couldn't update expense." });
  }
});

// DELETE /api/admin/expenses/:id
router.delete("/expenses/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(`DELETE FROM expenses WHERE id = $1 AND company_id = $2`, [id, req.companyId]);
    if (result.rowCount === 0) return res.status(404).json({ error: "Expense not found" });
    res.status(204).end();
  } catch (err) {
    console.error("DELETE /admin/expenses/:id failed:", err);
    res.status(500).json({ error: err.message || "Couldn't delete expense." });
  }
});

// ---------- Catalog items ----------
// A reusable, per-company list of recurring invoice line items (name +
// default unit price) so common charges don't need to be re-typed on every
// invoice. Picking one just pre-fills a normal line item on the invoice --
// there's no ongoing link back to the catalog afterward.

// GET /api/admin/catalog-items
router.get("/catalog-items", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, unit_price, barcode, created_at,
              track_inventory, quantity_on_hand, quantity_on_hold, unit_cost, low_stock_threshold
       FROM catalog_items WHERE company_id = $1 ORDER BY name`,
      [req.companyId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /admin/catalog-items failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load catalog items." });
  }
});

// GET /api/admin/catalog-items/lookup-barcode/:barcode
// Powers "scan to restock/add": checks the company's own catalog first (an
// existing item -> the caller bumps its quantity_on_hand) before falling
// back to a free public UPC database to suggest a name for a brand-new item.
// The external lookup is best-effort only -- trade/industrial barcodes often
// aren't in these consumer-goods-oriented databases, so a miss there isn't
// an error, just an empty suggestion (the admin types the name in by hand).
router.get("/catalog-items/lookup-barcode/:barcode", async (req, res) => {
  try {
    const barcode = String(req.params.barcode || "").trim();
    if (!barcode) return res.status(400).json({ error: "barcode is required" });

    const existing = await db.query(
      `SELECT id, name, unit_price, barcode, created_at,
              track_inventory, quantity_on_hand, quantity_on_hold, unit_cost, low_stock_threshold
       FROM catalog_items WHERE company_id = $1 AND barcode = $2`,
      [req.companyId, barcode]
    );
    if (existing.rowCount > 0) {
      return res.json({ found_in_catalog: true, item: existing.rows[0] });
    }

    let suggestion = null;
    try {
      const upcResp = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(barcode)}`, {
        headers: { Accept: "application/json" },
      });
      if (upcResp.ok) {
        const upcData = await upcResp.json();
        const found = upcData.items && upcData.items[0];
        if (found) {
          suggestion = { name: found.title || found.brand || null, brand: found.brand || null };
        }
      }
    } catch (lookupErr) {
      console.error("UPC lookup failed (non-fatal):", lookupErr.message);
    }

    res.json({ found_in_catalog: false, suggestion });
  } catch (err) {
    console.error("GET /admin/catalog-items/lookup-barcode failed:", err);
    res.status(500).json({ error: err.message || "Couldn't look up that barcode." });
  }
});

// POST /api/admin/catalog-items
// Body: { name, unit_price, barcode? }
router.post("/catalog-items", async (req, res) => {
  try {
    const { name, unit_price, barcode } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });
    const cleanBarcode = barcode ? String(barcode).trim() : null;
    if (cleanBarcode) {
      const dupe = await db.query(
        `SELECT id FROM catalog_items WHERE company_id = $1 AND barcode = $2`,
        [req.companyId, cleanBarcode]
      );
      if (dupe.rowCount > 0) return res.status(400).json({ error: "Another catalog item already uses this barcode." });
    }
    const result = await db.query(
      `INSERT INTO catalog_items (company_id, name, unit_price, barcode) VALUES ($1, $2, $3, $4)
       RETURNING id, name, unit_price, barcode, created_at`,
      [req.companyId, name, Number(unit_price) || 0, cleanBarcode]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(400).json({ error: "Another catalog item already uses this barcode." });
    console.error("POST /admin/catalog-items failed:", err);
    res.status(500).json({ error: err.message || "Couldn't create catalog item." });
  }
});

// PATCH /api/admin/catalog-items/:id
// Body: any of { name?, unit_price?, track_inventory?, quantity_on_hand?,
// unit_cost?, low_stock_threshold? } -- the last four are set from the
// Inventory tab's Settings view rather than the regular Catalog editor.
// Directly editing quantity_on_hand here is also how a restock gets
// recorded (there's no separate "receive stock" action -- just bump the
// number). Turning low_stock_threshold back to null clears the alert (and
// resets the sent-flag so a future threshold wouldn't immediately re-fire
// off a stale flag).
router.patch("/catalog-items/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, unit_price, barcode, track_inventory, quantity_on_hand, unit_cost, low_stock_threshold } = req.body;
    const owns = await db.query(`SELECT id FROM catalog_items WHERE id = $1 AND company_id = $2`, [id, req.companyId]);
    if (owns.rowCount === 0) return res.status(404).json({ error: "Catalog item not found" });

    const fields = [];
    const values = [];
    if (name !== undefined) { values.push(name); fields.push(`name = $${values.length}`); }
    if (unit_price !== undefined) { values.push(Number(unit_price) || 0); fields.push(`unit_price = $${values.length}`); }
    if (barcode !== undefined) {
      const cleanBarcode = barcode ? String(barcode).trim() : null;
      if (cleanBarcode) {
        const dupe = await db.query(
          `SELECT id FROM catalog_items WHERE company_id = $1 AND barcode = $2 AND id != $3`,
          [req.companyId, cleanBarcode, id]
        );
        if (dupe.rowCount > 0) return res.status(400).json({ error: "Another catalog item already uses this barcode." });
      }
      values.push(cleanBarcode); fields.push(`barcode = $${values.length}`);
    }
    if (track_inventory !== undefined) { values.push(!!track_inventory); fields.push(`track_inventory = $${values.length}`); }
    if (quantity_on_hand !== undefined) {
      const qty = Math.max(0, Math.round(Number(quantity_on_hand)) || 0);
      values.push(qty); fields.push(`quantity_on_hand = $${values.length}`);
    }
    if (unit_cost !== undefined) { values.push(unit_cost === null || unit_cost === "" ? null : Number(unit_cost) || 0); fields.push(`unit_cost = $${values.length}`); }
    if (low_stock_threshold !== undefined) {
      const threshold = low_stock_threshold === null || low_stock_threshold === "" ? null : Math.max(0, Math.round(Number(low_stock_threshold)) || 0);
      values.push(threshold); fields.push(`low_stock_threshold = $${values.length}`);
      fields.push(`low_stock_alert_sent = false`);
    }

    let item = owns.rows[0];
    if (fields.length > 0) {
      values.push(id);
      const result = await db.query(
        `UPDATE catalog_items SET ${fields.join(", ")} WHERE id = $${values.length}
         RETURNING id, name, unit_price, barcode, created_at,
                   track_inventory, quantity_on_hand, quantity_on_hold, unit_cost, low_stock_threshold`,
        values
      );
      item = result.rows[0];
      // Restocking or changing the threshold can move an item across the
      // low-stock line in either direction -- re-check right away rather
      // than waiting for the next hold/consume to notice.
      if (quantity_on_hand !== undefined || low_stock_threshold !== undefined) {
        await checkLowStock(id, req.companyId);
      }
    }
    res.json(item);
  } catch (err) {
    if (err.code === "23505") return res.status(400).json({ error: "Another catalog item already uses this barcode." });
    console.error("PATCH /admin/catalog-items/:id failed:", err);
    res.status(500).json({ error: err.message || "Couldn't update catalog item." });
  }
});

// GET /api/admin/inventory
// Only catalog items with track_inventory = true. "Available" is computed
// here (on_hand - on_hold) rather than stored, so it's always consistent
// with whatever the last hold/consume operation left behind. The two
// summary figures mirror the Overview/Reports profit bubbles pattern:
// total inventory value (on-hand x cost, everything you currently own) and
// total on-hold value (the subset of that already spoken for by an open
// quote or unpaid invoice).
router.get("/inventory", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, unit_price, unit_cost, quantity_on_hand, quantity_on_hold, low_stock_threshold,
              (quantity_on_hand - quantity_on_hold) AS quantity_available
       FROM catalog_items
       WHERE company_id = $1 AND track_inventory = true
       ORDER BY name`,
      [req.companyId]
    );
    const items = result.rows;
    const totalValue = items.reduce((sum, it) => sum + Number(it.quantity_on_hand) * Number(it.unit_cost || 0), 0);
    const totalOnHoldValue = items.reduce((sum, it) => sum + Number(it.quantity_on_hold) * Number(it.unit_cost || 0), 0);
    res.json({ items, total_value: totalValue, total_on_hold_value: totalOnHoldValue });
  } catch (err) {
    console.error("GET /admin/inventory failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load inventory." });
  }
});

// GET /api/admin/catalog-items/:id/holds
// Lists every invoice or pull sheet currently responsible for this item's
// quantity_on_hold, so clicking an "on hold" number can answer "held by
// what, exactly". Quotes are never listed here -- a quote never holds stock
// on its own (see the model comment atop utils/inventory.js); only a pull
// sheet built against one, or converting it to an invoice, actually reserves
// anything. Only counts sources that still actually hold a reservation right
// now, matching the same rules placeHoldsForLineItems/releaseHoldsForLineItems
// apply everywhere else:
//   - Invoices: 'draft' or 'sent' only -- 'paid' already consumed the hold
//     (not still "on hold"), 'void' already released it.
//   - Pull sheets: not yet 'fulfilled', and only ones built from a quote or
//     standalone/manual -- one built from an invoice doesn't hold anything
//     of its own (the invoice's own hold, listed separately above, already
//     covers it), so listing it here too would double-count the same hold.
router.get("/catalog-items/:id/holds", async (req, res) => {
  try {
    const { id } = req.params;
    const owns = await db.query(`SELECT id FROM catalog_items WHERE id = $1 AND company_id = $2`, [id, req.companyId]);
    if (owns.rowCount === 0) return res.status(404).json({ error: "Item not found" });

    const result = await db.query(
      `SELECT 'invoice' AS source_type, i.id, ('Invoice #' || i.invoice_number) AS label, i.status, c.name AS customer_name, c.company_name AS customer_company_name, ili.quantity
       FROM invoice_line_items ili
       JOIN invoices i ON i.id = ili.invoice_id
       JOIN customers c ON c.id = i.customer_id
       WHERE ili.catalog_item_id = $1 AND i.company_id = $2 AND i.status IN ('draft', 'sent')
       UNION ALL
       SELECT 'pull_sheet' AS source_type, ps.id, ps.source_label AS label, ps.status, ps.customer_name, ps.customer_company_name, psi.quantity
       FROM pull_sheet_items psi
       JOIN pull_sheets ps ON ps.id = psi.pull_sheet_id
       WHERE psi.catalog_item_id = $1 AND ps.company_id = $2 AND ps.status != 'fulfilled' AND ps.source_type IN ('quote', 'manual')
       ORDER BY source_type, label`,
      [id, req.companyId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /admin/catalog-items/:id/holds failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load what's holding this item." });
  }
});

// GET /api/admin/pull-sheets/sources
// Lists the open quotes/invoices a pull sheet could be built from -- only
// ones that actually have at least one inventory-tracked catalog-linked line
// item (no point offering a job with nothing to pull), and excluding
// declined/void quotes / voided invoices. Powers the picker shown when
// Building a pull sheet.
router.get("/pull-sheets/sources", async (req, res) => {
  try {
    const quotes = await db.query(
      `SELECT q.id, q.quote_number AS number, q.status, c.name AS customer_name, c.company_name AS customer_company_name
       FROM quotes q
       JOIN customers c ON c.id = q.customer_id
       WHERE q.company_id = $1 AND q.status NOT IN ('declined', 'void')
         AND EXISTS (
           SELECT 1 FROM quote_line_items qli
           JOIN catalog_items ci ON ci.id = qli.catalog_item_id
           WHERE qli.quote_id = q.id AND ci.track_inventory = true
         )
       ORDER BY q.quote_number DESC`,
      [req.companyId]
    );
    const invoices = await db.query(
      `SELECT i.id, i.invoice_number AS number, i.status, c.name AS customer_name, c.company_name AS customer_company_name
       FROM invoices i
       JOIN customers c ON c.id = i.customer_id
       WHERE i.company_id = $1 AND i.status != 'void'
         AND EXISTS (
           SELECT 1 FROM invoice_line_items ili
           JOIN catalog_items ci ON ci.id = ili.catalog_item_id
           WHERE ili.invoice_id = i.id AND ci.track_inventory = true
         )
       ORDER BY i.invoice_number DESC`,
      [req.companyId]
    );
    res.json({ quotes: quotes.rows, invoices: invoices.rows });
  } catch (err) {
    console.error("GET /admin/pull-sheets/sources failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load quotes/invoices." });
  }
});

// GET /api/admin/pull-sheets
// Recent pull sheets (both open and fulfilled), newest first, for the list
// shown on the Inventory tab.
router.get("/pull-sheets", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT ps.id, ps.source_type, ps.source_id, ps.source_label, ps.customer_name, ps.customer_company_name, ps.status,
              ps.created_at, ps.fulfilled_at,
              COALESCE(SUM(psi.quantity), 0) AS item_count
       FROM pull_sheets ps
       LEFT JOIN pull_sheet_items psi ON psi.pull_sheet_id = ps.id
       WHERE ps.company_id = $1
       GROUP BY ps.id
       ORDER BY ps.created_at DESC
       LIMIT 200`,
      [req.companyId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /admin/pull-sheets failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load pull sheets." });
  }
});

// GET /api/admin/pull-sheets/:id
router.get("/pull-sheets/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(`SELECT * FROM pull_sheets WHERE id = $1 AND company_id = $2`, [id, req.companyId]);
    if (result.rowCount === 0) return res.status(404).json({ error: "Pull sheet not found" });
    const items = await db.query(
      `SELECT id, catalog_item_id, name, quantity, quantity_pulled FROM pull_sheet_items WHERE pull_sheet_id = $1 ORDER BY name`,
      [id]
    );
    res.json({ ...result.rows[0], items: items.rows });
  } catch (err) {
    console.error("GET /admin/pull-sheets/:id failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load pull sheet." });
  }
});

// GET /api/admin/pull-sheets/:id/pdf
// Regenerated fresh every time, same as the invoice/quote PDFs -- nothing is
// stored.
router.get("/pull-sheets/:id/pdf", async (req, res) => {
  try {
    const { id } = req.params;
    const sheetResult = await db.query(`SELECT * FROM pull_sheets WHERE id = $1 AND company_id = $2`, [id, req.companyId]);
    if (sheetResult.rowCount === 0) return res.status(404).json({ error: "Pull sheet not found" });
    const sheet = sheetResult.rows[0];
    const items = await db.query(
      `SELECT name, quantity FROM pull_sheet_items WHERE pull_sheet_id = $1 ORDER BY name`,
      [id]
    );
    const companyResult = await db.query(`SELECT name FROM companies WHERE id = $1`, [req.companyId]);

    const pdfBuffer = await renderPullSheetPdf({
      companyName: companyResult.rows[0] ? companyResult.rows[0].name : null,
      sheet,
      items: items.rows,
    });

    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", `inline; filename="pull-sheet-${id}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error("GET /admin/pull-sheets/:id/pdf failed:", err);
    res.status(500).json({ error: err.message || "Couldn't generate pull sheet PDF." });
  }
});

// POST /api/admin/pull-sheets
// Body: { source_type: 'quote'|'invoice', source_id }
// Builds a new pull sheet snapshotting the source's inventory-tracked line
// items. Each item's quantity is (that line item's quantity minus whatever a
// previously-fulfilled pull sheet for this same job already accounted for),
// so re-building a sheet for a partially-pulled job only asks for what's
// left, and the same units can never be pulled (and later consumed) twice.
router.post("/pull-sheets", async (req, res) => {
  try {
    const { source_type, source_id, items, label } = req.body;

    // Solo/standalone sheet: items picked by hand, not tied to any job. No
    // "already pulled" bookkeeping applies here (nothing to double-count
    // against), so this path is much simpler than the job-based one below.
    if (source_type === "manual") {
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: "Add at least one item to build a pull sheet." });
      }
      const catalogIds = items.map((i) => i.catalog_item_id).filter(Boolean);
      const catalogResult = await db.query(
        `SELECT id, name FROM catalog_items WHERE company_id = $1 AND track_inventory = true AND id = ANY($2::uuid[])`,
        [req.companyId, catalogIds]
      );
      const catalogById = new Map(catalogResult.rows.map((r) => [r.id, r.name]));
      const toPull = items
        .map((item) => ({
          catalog_item_id: item.catalog_item_id,
          name: catalogById.get(item.catalog_item_id),
          quantity: Math.max(0, Math.round(Number(item.quantity)) || 0),
        }))
        .filter((item) => item.catalog_item_id && item.name && item.quantity > 0);

      if (toPull.length === 0) {
        return res.status(400).json({ error: "None of those items are trackable, or all quantities were 0." });
      }

      const sheetResult = await db.query(
        `INSERT INTO pull_sheets (company_id, source_type, source_label)
         VALUES ($1, 'manual', $2) RETURNING *`,
        [req.companyId, (label && String(label).trim().slice(0, 200)) || "Solo pull sheet"]
      );
      const sheet = sheetResult.rows[0];

      for (const item of toPull) {
        await db.query(
          `INSERT INTO pull_sheet_items (pull_sheet_id, catalog_item_id, name, quantity) VALUES ($1, $2, $3, $4)`,
          [sheet.id, item.catalog_item_id, item.name, item.quantity]
        );
      }

      // A manual sheet isn't tied to any quote or invoice, so nothing else
      // could already be holding these items -- it places its own hold.
      await placeHoldsForLineItems(toPull, req.companyId);

      return res.status(201).json({ ...sheet, items: toPull });
    }

    if (!["quote", "invoice"].includes(source_type) || !source_id) {
      return res.status(400).json({ error: "source_type must be 'quote', 'invoice', or 'manual'." });
    }

    const table = source_type === "quote" ? "quotes" : "invoices";
    const lineItemsTable = source_type === "quote" ? "quote_line_items" : "invoice_line_items";
    const numberField = source_type === "quote" ? "quote_number" : "invoice_number";
    const fkField = source_type === "quote" ? "quote_id" : "invoice_id";

    const sourceResult = await db.query(
      `SELECT s.id, s.status, s.${numberField} AS number, c.name AS customer_name, c.company_name AS customer_company_name
       FROM ${table} s JOIN customers c ON c.id = s.customer_id
       WHERE s.id = $1 AND s.company_id = $2`,
      [source_id, req.companyId]
    );
    if (sourceResult.rowCount === 0) return res.status(404).json({ error: `${source_type === "quote" ? "Quote" : "Invoice"} not found` });
    const source = sourceResult.rows[0];

    const deadStatuses = source_type === "quote" ? ["declined", "void"] : ["void"];
    if (deadStatuses.includes(source.status)) {
      return res.status(400).json({ error: `This ${source_type} has been ${source.status} -- nothing to pull for it anymore.` });
    }

    // Building a second pull sheet for the same job only makes sense once
    // the first one has actually been fulfilled (see getPulledQuantities --
    // that's how a partial pull gets topped off later). While one's still
    // open or just reported-pulled, a second "Build Pull Sheet" click would
    // just create a confusing duplicate of the exact same not-yet-done
    // work, so block it here instead.
    const existingOpen = await db.query(
      `SELECT id FROM pull_sheets WHERE source_type = $1 AND source_id = $2 AND company_id = $3 AND status != 'fulfilled'`,
      [source_type, source_id, req.companyId]
    );
    if (existingOpen.rowCount > 0) {
      return res.status(400).json({ error: "This job already has an open pull sheet. Fulfill or cancel it before building another." });
    }

    const lineItemsResult = await db.query(
      `SELECT li.catalog_item_id, li.description, li.quantity
       FROM ${lineItemsTable} li
       JOIN catalog_items ci ON ci.id = li.catalog_item_id
       WHERE li.${fkField} = $1 AND ci.track_inventory = true`,
      [source_id]
    );

    const pulled = await getPulledQuantities(source_type, source_id, req.companyId);
    const toPull = lineItemsResult.rows
      .map((item) => ({
        catalog_item_id: item.catalog_item_id,
        name: item.description,
        quantity: Math.max(0, Math.round(Number(item.quantity)) - (pulled.get(item.catalog_item_id) || 0)),
      }))
      .filter((item) => item.quantity > 0);

    if (toPull.length === 0) {
      const message = lineItemsResult.rowCount === 0
        ? "This job has no inventory-tracked items."
        : "Everything on this job has already been pulled.";
      return res.status(400).json({ error: message });
    }

    const sourceLabel = `${source_type === "quote" ? "Quote" : "Invoice"} #${source.number}`;
    const sheetResult = await db.query(
      `INSERT INTO pull_sheets (company_id, source_type, source_id, source_label, customer_name, customer_company_name)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.companyId, source_type, source_id, sourceLabel, source.customer_name, source.customer_company_name]
    );
    const sheet = sheetResult.rows[0];

    for (const item of toPull) {
      await db.query(
        `INSERT INTO pull_sheet_items (pull_sheet_id, catalog_item_id, name, quantity) VALUES ($1, $2, $3, $4)`,
        [sheet.id, item.catalog_item_id, item.name, item.quantity]
      );
    }

    // A quote never holds any stock on its own (see the model comment atop
    // utils/inventory.js), so building a pull sheet against one is the first
    // thing that actually reserves it. An invoice, on the other hand, always
    // already holds its own line items from the moment it was created (or
    // converted from a quote) -- building a pull sheet from it doesn't place
    // a second hold on top of that one.
    if (source_type === "quote") {
      await placeHoldsForLineItems(toPull, req.companyId);
    }

    notifyPullSheetBuilt(sheet, source_type, source_id, req.companyId).catch((err) =>
      console.error("notifyPullSheetBuilt failed:", err.message)
    );

    res.status(201).json({ ...sheet, items: toPull });
  } catch (err) {
    console.error("POST /admin/pull-sheets failed:", err);
    res.status(500).json({ error: err.message || "Couldn't build pull sheet." });
  }
});

// PATCH /api/admin/pull-sheets/:id/fulfill
// Marks a pull sheet fulfilled and actually removes its items from stock --
// decrementing both quantity_on_hand and quantity_on_hold, same as an
// invoice being marked paid. This is the one moment a pull sheet changes any
// real inventory number; building one earlier was just a snapshot/checklist.
router.patch("/pull-sheets/:id/fulfill", async (req, res) => {
  try {
    const { id } = req.params;
    const sheetResult = await db.query(`SELECT * FROM pull_sheets WHERE id = $1 AND company_id = $2`, [id, req.companyId]);
    if (sheetResult.rowCount === 0) return res.status(404).json({ error: "Pull sheet not found" });
    const sheet = sheetResult.rows[0];
    if (sheet.status === "fulfilled") return res.status(400).json({ error: "This pull sheet has already been fulfilled." });

    // Prefer whatever the employee actually reported pulling (see PATCH
    // /api/schedule/pull-sheets/:id/pulled) over the originally requested
    // quantity -- e.g. they only had 8 in stock when 10 was asked for, or
    // grabbed a couple extra. Falls back to the requested quantity for any
    // item nobody ever reported on.
    const items = await db.query(`SELECT catalog_item_id, quantity, quantity_pulled FROM pull_sheet_items WHERE pull_sheet_id = $1`, [id]);
    const toConsume = items.rows.map((item) => ({
      catalog_item_id: item.catalog_item_id,
      quantity: item.quantity_pulled != null ? item.quantity_pulled : item.quantity,
    }));
    await consumeInventoryForLineItems(toConsume, req.companyId);

    const updated = await db.query(
      `UPDATE pull_sheets SET status = 'fulfilled', fulfilled_at = now() WHERE id = $1 RETURNING *`,
      [id]
    );
    res.json(updated.rows[0]);
  } catch (err) {
    console.error("PATCH /admin/pull-sheets/:id/fulfill failed:", err);
    res.status(500).json({ error: err.message || "Couldn't mark pull sheet as fulfilled." });
  }
});

// DELETE /api/admin/pull-sheets/:id
// Only an open (not-yet-fulfilled) pull sheet can be deleted -- deleting a
// fulfilled one would erase the record of inventory already having been
// physically removed, causing it to be double-consumed the next time this
// job's invoice is marked paid.
router.delete("/pull-sheets/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const sheetResult = await db.query(`SELECT status, source_type FROM pull_sheets WHERE id = $1 AND company_id = $2`, [id, req.companyId]);
    if (sheetResult.rowCount === 0) return res.status(404).json({ error: "Pull sheet not found" });
    const sheet = sheetResult.rows[0];
    if (sheet.status === "fulfilled") {
      return res.status(400).json({ error: "A fulfilled pull sheet can't be deleted." });
    }

    // A quote-sourced or manual/standalone sheet holds its own reservation
    // (placed when it was built -- see POST /pull-sheets), so cancelling it
    // needs to release that. An invoice-sourced one never held anything of
    // its own -- the invoice's hold covers it regardless of whether a pull
    // sheet exists -- so there's nothing to release for that case.
    if (sheet.source_type !== "invoice") {
      const items = await db.query(`SELECT catalog_item_id, quantity FROM pull_sheet_items WHERE pull_sheet_id = $1`, [id]);
      await releaseHoldsForLineItems(items.rows, req.companyId);
    }

    await db.query(`DELETE FROM pull_sheets WHERE id = $1 AND company_id = $2`, [id, req.companyId]);
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /admin/pull-sheets/:id failed:", err);
    res.status(500).json({ error: err.message || "Couldn't delete pull sheet." });
  }
});

// POST /api/admin/catalog-items/import
// Body: { items: [{ name, unit_price?, quantity_on_hand?, unit_cost? }, ...] }
// Bulk-imports catalog items from a spreadsheet (Excel or CSV, parsed
// client-side into plain objects and sent here). Mirrors the customer
// import route: rows missing a name are skipped.
//
// quantity_on_hand/unit_cost are optional, for importing an existing
// physical inventory count/cost sheet (rather than just a price list) in one
// pass. Providing either one turns tracking on for that item automatically,
// since there'd be no reason to supply a stock count for an item you don't
// want tracked.
//
// Rows whose name case-insensitively matches an existing catalog item are
// NOT simply skipped like a plain duplicate would be if the row carries a
// quantity or cost -- instead that existing item's inventory fields are
// backfilled/updated. This matters for re-running an import: if a sheet was
// first imported before inventory tracking existed (or before this file had
// quantity/cost columns), re-importing the same names with quantity/cost
// added now updates those already-created items instead of silently doing
// nothing. A duplicate row with no quantity/cost data is still just skipped,
// same as before.
router.post("/catalog-items/import", async (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "No items to import." });
    }
    if (items.length > 2000) {
      return res.status(400).json({ error: "That's more than 2000 rows at once -- please split the file up." });
    }

    const existing = await db.query(`SELECT id, name FROM catalog_items WHERE company_id = $1`, [req.companyId]);
    const existingByName = new Map(existing.rows.map((r) => [r.name.trim().toLowerCase(), r.id]));

    let imported = 0;
    let updated = 0;
    const skipped = [];

    for (let i = 0; i < items.length; i++) {
      const row = items[i] || {};
      const name = (row.name || "").trim();
      if (!name) {
        skipped.push({ row: i + 1, reason: "missing_name" });
        continue;
      }
      const key = name.toLowerCase();

      const hasQuantity = row.quantity_on_hand !== undefined && row.quantity_on_hand !== null && row.quantity_on_hand !== "";
      const hasCost = row.unit_cost !== undefined && row.unit_cost !== null && row.unit_cost !== "";
      const quantityOnHand = hasQuantity ? Math.max(0, Math.round(Number(row.quantity_on_hand)) || 0) : 0;
      const unitCost = hasCost ? Number(row.unit_cost) || 0 : null;
      const trackInventory = hasQuantity || hasCost;

      const existingId = existingByName.get(key);
      if (existingId) {
        if (!trackInventory) {
          skipped.push({ row: i + 1, reason: "duplicate", name });
          continue;
        }
        await db.query(
          `UPDATE catalog_items
           SET track_inventory = true,
               quantity_on_hand = CASE WHEN $1 THEN $2 ELSE quantity_on_hand END,
               unit_cost = CASE WHEN $3 THEN $4 ELSE unit_cost END
           WHERE id = $5 AND company_id = $6`,
          [hasQuantity, quantityOnHand, hasCost, unitCost, existingId, req.companyId]
        );
        updated++;
        continue;
      }

      const inserted = await db.query(
        `INSERT INTO catalog_items (company_id, name, unit_price, track_inventory, quantity_on_hand, unit_cost)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [req.companyId, name, Number(row.unit_price) || 0, trackInventory, quantityOnHand, unitCost]
      );
      existingByName.set(key, inserted.rows[0].id);
      imported++;
    }

    res.status(201).json({ imported, updated, skipped });
  } catch (err) {
    console.error("POST /admin/catalog-items/import failed:", err);
    res.status(500).json({ error: err.message || "Couldn't import catalog items." });
  }
});

// DELETE /api/admin/catalog-items/:id
router.delete("/catalog-items/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(`DELETE FROM catalog_items WHERE id = $1 AND company_id = $2`, [id, req.companyId]);
    if (result.rowCount === 0) return res.status(404).json({ error: "Catalog item not found" });
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /admin/catalog-items/:id failed:", err);
    res.status(500).json({ error: err.message || "Couldn't delete catalog item." });
  }
});

// ---------- Company logo ----------
// An optional logo shown on generated invoice PDFs, stored directly in
// Postgres as bytea rather than a separate file-storage service. Uploaded
// as base64 over the normal JSON API (no multipart handling needed) --
// server.js raises the JSON body limit to 6mb to make room for that.

const LOGO_MAX_BYTES = 3 * 1024 * 1024; // 3MB, before base64 inflation
const LOGO_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];

// GET /api/admin/company-logo
// Returns { logo: null } if none is set, otherwise { logo: "data:<mime>;base64,..." }
// ready to drop straight into an <img src>.
router.get("/company-logo", async (req, res) => {
  try {
    const result = await db.query(`SELECT logo_data, logo_mime_type FROM companies WHERE id = $1`, [req.companyId]);
    const row = result.rows[0];
    if (!row || !row.logo_data) return res.json({ logo: null });
    res.json({ logo: `data:${row.logo_mime_type};base64,${row.logo_data.toString("base64")}` });
  } catch (err) {
    console.error("GET /admin/company-logo failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load logo." });
  }
});

// PUT /api/admin/company-logo
// Body: { logo_base64, mime_type } -- logo_base64 is the raw base64 payload
// (no "data:...;base64," prefix).
router.put("/company-logo", async (req, res) => {
  try {
    const { logo_base64, mime_type } = req.body;
    if (!logo_base64 || !mime_type) {
      return res.status(400).json({ error: "logo_base64 and mime_type are required" });
    }
    if (!LOGO_MIME_TYPES.includes(mime_type)) {
      return res.status(400).json({ error: "Logo must be a PNG, JPEG, or WebP image." });
    }
    const buffer = Buffer.from(logo_base64, "base64");
    if (buffer.length > LOGO_MAX_BYTES) {
      return res.status(400).json({ error: "Logo must be 3MB or smaller." });
    }
    await db.query(`UPDATE companies SET logo_data = $1, logo_mime_type = $2 WHERE id = $3`, [buffer, mime_type, req.companyId]);
    res.json({ ok: true });
  } catch (err) {
    console.error("PUT /admin/company-logo failed:", err);
    res.status(500).json({ error: err.message || "Couldn't save logo." });
  }
});

// DELETE /api/admin/company-logo
router.delete("/company-logo", async (req, res) => {
  try {
    await db.query(`UPDATE companies SET logo_data = NULL, logo_mime_type = NULL WHERE id = $1`, [req.companyId]);
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /admin/company-logo failed:", err);
    res.status(500).json({ error: err.message || "Couldn't remove logo." });
  }
});

// ---------- Admin push subscriptions (for chat notifications) ----------
// POST /api/admin/push/subscribe
// Body: a PushSubscription object from the browser's Push API. Called once
// per device from the mobile admin web page.
router.post("/push/subscribe", async (req, res) => {
  try {
    const { endpoint, keys } = req.body;
    if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
      return res.status(400).json({ error: "A valid push subscription is required" });
    }
    await db.query(
      `INSERT INTO admin_push_subscriptions (company_id, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE SET company_id = $1, p256dh = $3, auth = $4`,
      [req.companyId, endpoint, keys.p256dh, keys.auth]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error("POST /admin/push/subscribe failed:", err);
    res.status(500).json({ error: err.message || "Couldn't save subscription." });
  }
});

// POST /api/admin/push/unsubscribe
// Body: { endpoint }
router.post("/push/unsubscribe", async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ error: "endpoint is required" });
    await db.query(`DELETE FROM admin_push_subscriptions WHERE endpoint = $1 AND company_id = $2`, [endpoint, req.companyId]);
    res.json({ ok: true });
  } catch (err) {
    console.error("POST /admin/push/unsubscribe failed:", err);
    res.status(500).json({ error: err.message || "Couldn't remove subscription." });
  }
});

// ---------- Chat ----------
// One thread per employee (there's only one admin per company). Employees
// only show up here if they're currently clocked in (so a brand-new
// conversation can be started) or already have message history (so past
// conversations stay visible after someone clocks out).
router.get("/chat/threads", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT e.id, e.name,
              (open_te.id IS NOT NULL) AS on_clock,
              lm.body AS last_message_body, lm.sender AS last_message_sender, lm.created_at AS last_message_at,
              COALESCE(uc.unread_count, 0)::int AS unread_count
       FROM employees e
       LEFT JOIN time_entries open_te ON open_te.employee_id = e.id AND open_te.clock_out IS NULL
       LEFT JOIN LATERAL (
         SELECT body, sender, created_at FROM chat_messages WHERE employee_id = e.id ORDER BY created_at DESC LIMIT 1
       ) lm ON true
       LEFT JOIN (
         SELECT employee_id, COUNT(*) AS unread_count FROM chat_messages
         WHERE sender = 'employee' AND read_by_admin = false GROUP BY employee_id
       ) uc ON uc.employee_id = e.id
       WHERE e.company_id = $1 AND e.active = true AND (open_te.id IS NOT NULL OR lm.created_at IS NOT NULL)
       ORDER BY (lm.created_at IS NULL), lm.created_at DESC, e.name`,
      [req.companyId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /admin/chat/threads failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load chats." });
  }
});

// GET /api/admin/chat/:employeeId/messages
// Marks the employee's messages in this thread as read.
router.get("/chat/:employeeId/messages", async (req, res) => {
  try {
    const { employeeId } = req.params;
    const owns = await db.query(`SELECT id FROM employees WHERE id = $1 AND company_id = $2`, [employeeId, req.companyId]);
    if (owns.rowCount === 0) return res.status(404).json({ error: "Employee not found" });

    const result = await db.query(
      `SELECT id, sender, body, created_at FROM chat_messages WHERE employee_id = $1 ORDER BY created_at`,
      [employeeId]
    );
    await db.query(
      `UPDATE chat_messages SET read_by_admin = true WHERE employee_id = $1 AND sender = 'employee' AND read_by_admin = false`,
      [employeeId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /admin/chat/:employeeId/messages failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load messages." });
  }
});

// POST /api/admin/chat/:employeeId/messages
// Body: { body }. Only allowed while the employee is currently clocked in.
router.post("/chat/:employeeId/messages", async (req, res) => {
  try {
    const { employeeId } = req.params;
    const { body } = req.body;
    if (!body || !body.trim()) return res.status(400).json({ error: "Message can't be empty." });

    const employee = await db.query(`SELECT id, name FROM employees WHERE id = $1 AND company_id = $2`, [employeeId, req.companyId]);
    if (employee.rowCount === 0) return res.status(404).json({ error: "Employee not found" });

    const openShift = await db.query(`SELECT id FROM time_entries WHERE employee_id = $1 AND clock_out IS NULL`, [employeeId]);
    if (openShift.rowCount === 0) {
      return res.status(400).json({ error: "This employee isn't clocked in right now, so they can't be messaged." });
    }

    const result = await db.query(
      `INSERT INTO chat_messages (company_id, employee_id, sender, body, read_by_admin, read_by_employee)
       VALUES ($1, $2, 'admin', $3, true, false)
       RETURNING id, sender, body, created_at`,
      [req.companyId, employeeId, body.trim()]
    );

    const company = await db.query(`SELECT name FROM companies WHERE id = $1`, [req.companyId]);
    const companyName = company.rows[0]?.name || "Your employer";
    sendPushToEmployee(employeeId, {
      title: `Message from ${companyName}`,
      body: body.trim().slice(0, 120),
      url: "/chat",
    }).catch((err) => console.error("Failed to send chat push notification:", err.message));

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("POST /admin/chat/:employeeId/messages failed:", err);
    res.status(500).json({ error: err.message || "Couldn't send message." });
  }
});

// ---------- Team Chat (admin as a participant) ----------
// The admin can start/join direct and group chats with employees, using the
// same employee_chat_* tables employees use to message each other -- the
// admin is just a participant row with is_admin = true / employee_id NULL
// instead of a real employee row. Unlike an employee sender, the admin has
// no clock-in gate on sending -- that rule only applies to employees
// messaging each other while off the clock.
router.get("/team-chat/threads", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT t.id, t.is_group, t.name,
         (SELECT json_agg(json_build_object('id', e.id, 'name', e.name) ORDER BY e.name)
            FROM employee_chat_participants p2
            JOIN employees e ON e.id = p2.employee_id
            WHERE p2.thread_id = t.id AND p2.employee_id IS NOT NULL) AS other_participants,
         (SELECT json_build_object('body', m.body, 'created_at', m.created_at, 'sender_employee_id', m.sender_employee_id, 'sender_is_admin', m.sender_is_admin)
            FROM employee_chat_messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,
         (SELECT COUNT(*)::int FROM employee_chat_messages m
            WHERE m.thread_id = t.id AND m.sender_is_admin = false
              AND (p.last_read_at IS NULL OR m.created_at > p.last_read_at)) AS unread_count
       FROM employee_chat_threads t
       JOIN employee_chat_participants p ON p.thread_id = t.id AND p.is_admin = true
       WHERE t.company_id = $1
       ORDER BY COALESCE((SELECT MAX(created_at) FROM employee_chat_messages m2 WHERE m2.thread_id = t.id), t.created_at) DESC`,
      [req.companyId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /admin/team-chat/threads failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load chats." });
  }
});

// GET /api/admin/team-chat/unread-count
router.get("/team-chat/unread-count", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT COUNT(*)::int AS count
       FROM employee_chat_messages m
       JOIN employee_chat_participants p ON p.thread_id = m.thread_id AND p.is_admin = true
       JOIN employee_chat_threads t ON t.id = m.thread_id
       WHERE t.company_id = $1 AND m.sender_is_admin = false
         AND (p.last_read_at IS NULL OR m.created_at > p.last_read_at)`,
      [req.companyId]
    );
    res.json({ count: result.rows[0].count });
  } catch (err) {
    console.error("GET /admin/team-chat/unread-count failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load unread count." });
  }
});

// POST /api/admin/team-chat/threads
// Body: { employee_ids: [uuid, ...], name? }. One id = a 1:1 DM with that
// employee (reuses an existing admin<->employee team thread if one already
// exists); 2+ ids = a new group chat including the admin and those
// employees, optionally named.
router.post("/team-chat/threads", async (req, res) => {
  try {
    const { employee_ids, name } = req.body;
    if (!Array.isArray(employee_ids) || employee_ids.length === 0) {
      return res.status(400).json({ error: "Select at least one employee." });
    }
    const uniqueIds = [...new Set(employee_ids)];
    const validCheck = await db.query(
      `SELECT id FROM employees WHERE company_id = $1 AND id = ANY($2::uuid[])`,
      [req.companyId, uniqueIds]
    );
    if (validCheck.rowCount !== uniqueIds.length) {
      return res.status(400).json({ error: "One or more selected employees weren't found." });
    }

    const isGroup = uniqueIds.length > 1;

    if (!isGroup) {
      const existing = await db.query(
        `SELECT t.id FROM employee_chat_threads t
         WHERE t.company_id = $1 AND t.is_group = false
           AND (SELECT COUNT(*) FROM employee_chat_participants p WHERE p.thread_id = t.id) = 2
           AND EXISTS (SELECT 1 FROM employee_chat_participants p WHERE p.thread_id = t.id AND p.is_admin = true)
           AND EXISTS (SELECT 1 FROM employee_chat_participants p WHERE p.thread_id = t.id AND p.employee_id = $2)`,
        [req.companyId, uniqueIds[0]]
      );
      if (existing.rowCount > 0) {
        return res.status(200).json({ id: existing.rows[0].id, existing: true });
      }
    }

    const threadResult = await db.query(
      `INSERT INTO employee_chat_threads (company_id, is_group, name, created_by_is_admin)
       VALUES ($1, $2, $3, true) RETURNING id`,
      [req.companyId, isGroup, isGroup ? (name || null) : null]
    );
    const threadId = threadResult.rows[0].id;

    const values = [threadId];
    const empPlaceholders = uniqueIds
      .map((empId) => {
        values.push(empId);
        return `($1, $${values.length})`;
      })
      .join(", ");
    await db.query(`INSERT INTO employee_chat_participants (thread_id, employee_id) VALUES ${empPlaceholders}`, values);
    await db.query(`INSERT INTO employee_chat_participants (thread_id, is_admin) VALUES ($1, true)`, [threadId]);

    res.status(201).json({ id: threadId, existing: false });
  } catch (err) {
    console.error("POST /admin/team-chat/threads failed:", err);
    res.status(500).json({ error: err.message || "Couldn't start chat." });
  }
});

// GET /api/admin/team-chat/threads/:id/messages
// Marks the thread read for the admin.
router.get("/team-chat/threads/:id/messages", async (req, res) => {
  try {
    const { id } = req.params;
    const participant = await db.query(
      `SELECT p.id FROM employee_chat_participants p
       JOIN employee_chat_threads t ON t.id = p.thread_id
       WHERE p.thread_id = $1 AND p.is_admin = true AND t.company_id = $2`,
      [id, req.companyId]
    );
    if (participant.rowCount === 0) return res.status(404).json({ error: "Chat not found" });

    const result = await db.query(
      `SELECT m.id, m.sender_employee_id, m.sender_is_admin,
              CASE WHEN m.sender_is_admin THEN 'Admin' ELSE e.name END AS sender_name,
              m.body, m.created_at
       FROM employee_chat_messages m
       LEFT JOIN employees e ON e.id = m.sender_employee_id
       WHERE m.thread_id = $1 ORDER BY m.created_at`,
      [id]
    );
    await db.query(`UPDATE employee_chat_participants SET last_read_at = now() WHERE thread_id = $1 AND is_admin = true`, [id]);
    res.json(result.rows);
  } catch (err) {
    console.error("GET /admin/team-chat/threads/:id/messages failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load messages." });
  }
});

// POST /api/admin/team-chat/threads/:id/messages
// Body: { body }. No clock-in gate -- see comment at the top of this section.
router.post("/team-chat/threads/:id/messages", async (req, res) => {
  try {
    const { id } = req.params;
    const { body } = req.body;
    if (!body || !body.trim()) return res.status(400).json({ error: "Message can't be empty." });

    const participant = await db.query(
      `SELECT p.id FROM employee_chat_participants p
       JOIN employee_chat_threads t ON t.id = p.thread_id
       WHERE p.thread_id = $1 AND p.is_admin = true AND t.company_id = $2`,
      [id, req.companyId]
    );
    if (participant.rowCount === 0) return res.status(404).json({ error: "Chat not found" });

    const result = await db.query(
      `INSERT INTO employee_chat_messages (thread_id, sender_is_admin, body) VALUES ($1, true, $2)
       RETURNING id, sender_employee_id, sender_is_admin, body, created_at`,
      [id, body.trim()]
    );

    await db.query(`UPDATE employee_chat_participants SET last_read_at = now() WHERE thread_id = $1 AND is_admin = true`, [id]);

    const company = await db.query(`SELECT name FROM companies WHERE id = $1`, [req.companyId]);
    const companyName = company.rows[0]?.name || "Your employer";

    const employees = await db.query(
      `SELECT employee_id FROM employee_chat_participants WHERE thread_id = $1 AND employee_id IS NOT NULL`,
      [id]
    );
    const thread = await db.query(`SELECT is_group, name FROM employee_chat_threads WHERE id = $1`, [id]);
    const title = thread.rows[0]?.is_group
      ? `${companyName} in ${thread.rows[0].name || "group chat"}`
      : `Message from ${companyName}`;
    employees.rows.forEach((row) => {
      sendPushToEmployee(row.employee_id, {
        title,
        body: body.trim().slice(0, 120),
        url: "/team",
      }).catch((err) => console.error("Failed to send team chat push notification:", err.message));
    });

    res.status(201).json({ ...result.rows[0], sender_name: "Admin" });
  } catch (err) {
    console.error("POST /admin/team-chat/threads/:id/messages failed:", err);
    res.status(500).json({ error: err.message || "Couldn't send message." });
  }
});

module.exports = router;