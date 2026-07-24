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
const cron = require("node-cron");
const companyRoutes = require("./routes/companies");
const authRoutes = require("./routes/auth");
const timeEntryRoutes = require("./routes/timeEntries");
const timesheetRoutes = require("./routes/timesheets");
const adminRoutes = require("./routes/admin");
const pushRoutes = require("./routes/push");
const scheduleRoutes = require("./routes/schedule");
const { checkAndSendReminders } = require("./utils/invoiceReminders");

const app = express();

app.use(cors());
// Raised from the 100kb default so a base64-encoded company logo upload
// (see PUT /api/admin/company-logo) doesn't get rejected before it even
// reaches the route handler's own size validation.
app.use(express.json({ limit: "6mb" }));

app.get("/api/health", (req, res) => res.json({ ok: true }));

// Temporary route to confirm Sentry is wired up correctly. Visiting this
// throws an error on purpose so it shows up in the Sentry dashboard. Safe
// to delete once you've confirmed it works.
app.get("/api/debug-sentry", () => {
  throw new Error("Test error - confirming Sentry is receiving errors");
});

app.use("/api/auth", authRoutes);
app.use("/api/time-entries", timeEntryRoutes);
app.use("/api/timesheets", timesheetRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/companies", companyRoutes);
app.use("/api/push", pushRoutes);
app.use("/api/schedule", scheduleRoutes);

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Site Clock API listening on port ${PORT}`));