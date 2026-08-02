require("dotenv").config();
const Sentry = require("@sentry/node");

// Error monitoring: reports crashes and unhandled errors to Sentry instead
// of them only showing up if a customer happens to complain. SENTRY_DSN is
// set as an environment variable in Railway, not hardcoded here.
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 1.0,
});

// Async route handlers that throw without a try/catch don't get picked up
// by Express's normal error handling -- that's exactly what caused the
// "Failed to fetch" timesheet bug earlier (a hung request instead of a
// clean error). These two handlers make sure Sentry at least hears about
// it when that happens anywhere else in the app, even though the specific
// route still needs its own try/catch to return a clean response to the
// client (the way timesheets.js was fixed).
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
  Sentry.captureException(reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  Sentry.captureException(err);
});

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const cron = require("node-cron");
const companyRoutes = require("./routes/companies");
const authRoutes = require("./routes/auth");
const timeEntryRoutes = require("./routes/timeEntries");
const timesheetRoutes = require("./routes/timesheets");
const adminRoutes = require("./routes/admin");
const pushRoutes = require("./routes/push");
const scheduleRoutes = require("./routes/schedule");
const chatRoutes = require("./routes/chat");
const teamChatRoutes = require("./routes/teamChat");
const { router: paymentsRoutes, handleStripeWebhook, handleStripeConnectWebhook } = require("./routes/payments");
const connectRoutes = require("./routes/connect");
const platformRoutes = require("./routes/platform");
const routingRoutes = require("./routes/routing");
const attachmentsRoutes = require("./routes/attachments");
const { checkAndSendReminders } = require("./utils/invoiceReminders");
const { checkAndSendLongShiftAlerts } = require("./utils/longShiftAlerts");
const { checkAndAutoSubmitTimesheets } = require("./utils/autoSubmitTimesheets");

const app = express();

// Railway sits in front of this server as a reverse proxy, so without this,
// every request looks like it comes from Railway's own IP -- which would
// make the login rate limiter below (keyed by IP) treat every visitor as
// the same "user" and block everyone together after one person's failed
// attempts. This tells Express to trust the first hop's X-Forwarded-For
// header so req.ip is the real caller.
app.set("trust proxy", 1);

// Sets a handful of standard security response headers (no more X-Powered-By
// giving away the framework, no framing by other sites, etc). CSP is turned
// off because this server only ever returns JSON -- the actual web pages are
// served separately by the frontend -- and CORP is relaxed to cross-origin
// since the frontend calls this API from a different Railway domain.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
}));

// Restricts which *browser* origins can read responses from this API --
// the known frontend domain (admin.html/platform.html/the React PWA all
// live there) plus common local dev ports. Requests with no Origin header
// at all (curl, server-to-server calls, and Electron's own fetch from a
// file:// page, which Chromium sends as a "null" origin) are still let
// through same as before -- this isn't a real session-hijack boundary
// anyway since auth here is a Bearer token, not a cookie, so a strange
// website can't ride an existing login; this just stops some other site's
// JS from being able to read this API's responses cross-origin at all.
const FRONTEND_URL = process.env.FRONTEND_URL || "https://site-clock-frontend-production.up.railway.app";
const ALLOWED_ORIGINS = [FRONTEND_URL, "http://localhost:5173", "http://localhost:3000"];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || origin === "null" || ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error("Not allowed by CORS"));
  },
}));

// Stripe webhook signature verification needs the raw, untouched request
// body -- so this route is registered with its own express.raw() middleware
// *before* the global express.json() below ever gets a chance to parse it.
// Express matches routes in registration order, so a POST to this exact
// path never reaches express.json() at all.
app.post("/api/payments/webhook", express.raw({ type: "application/json" }), handleStripeWebhook);

// Second webhook destination, for events Stripe fires on *connected*
// accounts (see routes/connect.js) -- Stripe requires this to be a
// separate "Connected accounts" destination in the dashboard, signed with
// its own secret, even though it can point at a different path on the same
// server.
app.post("/api/payments/connect-webhook", express.raw({ type: "application/json" }), handleStripeConnectWebhook);

// Raised from the 100kb default so a base64-encoded company logo upload
// (see PUT /api/admin/company-logo) or a job/invoice attachment upload (see
// routes/attachments.js, capped at 10MB per file pre-base64) doesn't get
// rejected before it even reaches the route handler's own size validation.
// Base64 inflates the original file size by ~1/3, so 10MB -> ~13.3MB; 15mb
// leaves headroom for the rest of the JSON payload around it.
app.use(express.json({ limit: "15mb" }));

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.use("/api/auth", authRoutes);
app.use("/api/time-entries", timeEntryRoutes);
app.use("/api/timesheets", timesheetRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/companies", companyRoutes);
app.use("/api/push", pushRoutes);
app.use("/api/schedule", scheduleRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/team-chat", teamChatRoutes);
app.use("/api/payments", paymentsRoutes);
app.use("/api/connect", connectRoutes);
app.use("/api/platform", platformRoutes);
app.use("/api/admin/routing", routingRoutes);
app.use("/api/admin/attachments", attachmentsRoutes);

// Must come after all routes, before any other error-handling middleware.
Sentry.setupExpressErrorHandler(app);

// Final safety net: makes sure any error that reaches here still gets a
// clean JSON response instead of the request just hanging.
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Something went wrong. Please try again." });
});

// Runs at the top of every hour to send automatic reminder emails for
// unpaid invoices. It runs hourly (rather than once a day at a fixed UTC
// time) so each company gets its reminders around 9am *its own* local
// time -- see the TARGET_LOCAL_HOUR check in utils/invoiceReminders.js,
// which is what actually decides whether it's the right moment for any
// given company, using that company's saved timezone.
cron.schedule("0 * * * *", () => {
  checkAndSendReminders()
    .then((sent) => console.log(`Invoice reminder job sent ${sent} reminder(s).`))
    .catch((err) => {
      console.error("Invoice reminder job failed:", err);
      Sentry.captureException(err);
    });
});

// Runs every 10 minutes so a company's long_shift_alert_hours setting (see
// GET/PATCH /api/admin/long-shift-alert, 1-24, or off) fires reasonably
// close to the threshold rather than only once an hour -- someone who sets
// a 1-hour alert would otherwise wait up to an extra 59 minutes for it.
cron.schedule("*/10 * * * *", () => {
  checkAndSendLongShiftAlerts()
    .then((sent) => console.log(`Long shift alert job sent ${sent} alert(s).`))
    .catch((err) => {
      console.error("Long shift alert job failed:", err);
      Sentry.captureException(err);
    });
});

// Runs hourly, same pattern as the invoice reminder job above -- catches any
// employee who didn't submit their hours before payday and auto-submits
// them so payroll still gets sent on time. TARGET_LOCAL_HOUR in
// utils/autoSubmitTimesheets.js decides the actual moment per company, using
// that company's own timezone.
cron.schedule("0 * * * *", () => {
  checkAndAutoSubmitTimesheets()
    .then((sent) => console.log(`Auto-submit timesheet job submitted ${sent} entrie(s).`))
    .catch((err) => {
      console.error("Auto-submit timesheet job failed:", err);
      Sentry.captureException(err);
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Site Clock API listening on port ${PORT}`));