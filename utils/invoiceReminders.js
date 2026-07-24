const db = require("../db");
const { renderInvoicePdf } = require("./invoicePdf");
const { sendInvoiceReminderEmail } = require("./mailer");

// Automatic reminder emails for unpaid ("sent") invoices. First reminder
// fires on or after the due date; each one after that waits at least this
// many days from the last reminder, capped at MAX_REMINDERS total. Timing
// is driven by elapsed time since last_reminder_sent_at rather than an
// exact calendar-day match, so a missed run of the job just catches up on
// the next run instead of skipping a reminder entirely.
const REMINDER_INTERVAL_DAYS = 7;
const MAX_REMINDERS = 5;

// This job runs once an hour (see server.js) and only actually sends for a
// given company once it's this hour in *that company's own* timezone --
// not the server's, and not any one company's. That's what lets a company
// in, say, Los Angeles get its reminders around 9am Pacific instead of
// whatever hour happens to be 9am in Colorado.
const TARGET_LOCAL_HOUR = 9;

function daysBetween(earlier, later) {
  return Math.floor((later.getTime() - earlier.getTime()) / (1000 * 60 * 60 * 24));
}

function isEligibleForReminder(invoice, today) {
  if (invoice.reminder_count >= MAX_REMINDERS) return false;
  if (invoice.reminder_count === 0) {
    return daysBetween(new Date(invoice.due_date), today) >= 0;
  }
  if (!invoice.last_reminder_sent_at) return true; // shouldn't happen, but don't get stuck
  return daysBetween(new Date(invoice.last_reminder_sent_at), today) >= REMINDER_INTERVAL_DAYS;
}

// Returns the current local hour (0-23) in the given IANA timezone. Falls
// back to treating an invalid/unrecognized zone as "always eligible" hour
// (-1, which never matches TARGET_LOCAL_HOUR) rather than throwing --
// a bad timezone value on one company shouldn't crash the whole job.
function localHourIn(timezone) {
  try {
    const hourStr = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      hour12: false,
    }).format(new Date());
    return Number(hourStr) % 24; // "24" at midnight in some locales
  } catch (err) {
    return -1;
  }
}

// Scans every company's unpaid, sent invoices and sends a reminder to any
// that are due *and* whose company is currently at TARGET_LOCAL_HOUR local
// time. Errors on one invoice are logged and skipped rather than aborting
// the whole batch, so one bad row can't block reminders for everyone else.
async function checkAndSendReminders() {
  const today = new Date();
  const result = await db.query(
    `SELECT i.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
            c.street AS customer_street, c.city AS customer_city, c.state AS customer_state, c.zip AS customer_zip,
            comp.name AS company_name, comp.admin_email AS company_admin_email, comp.logo_data AS company_logo_data,
            comp.timezone AS company_timezone
     FROM invoices i
     JOIN customers c ON c.id = i.customer_id
     JOIN companies comp ON comp.id = i.company_id
     WHERE i.status = 'sent' AND i.reminder_count < $1`,
    [MAX_REMINDERS]
  );

  let sent = 0;
  for (const invoice of result.rows) {
    try {
      if (!invoice.customer_email) continue;
      if (localHourIn(invoice.company_timezone) !== TARGET_LOCAL_HOUR) continue;
      if (!isEligibleForReminder(invoice, today)) continue;

      const itemsResult = await db.query(
        `SELECT description, quantity, unit_price FROM invoice_line_items WHERE invoice_id = $1 ORDER BY sort_order`,
        [invoice.id]
      );

      const pdfBuffer = await renderInvoicePdf({
        companyName: invoice.company_name,
        invoice,
        customer: {
          name: invoice.customer_name,
          email: invoice.customer_email,
          phone: invoice.customer_phone,
          street: invoice.customer_street,
          city: invoice.customer_city,
          state: invoice.customer_state,
          zip: invoice.customer_zip,
        },
        lineItems: itemsResult.rows,
        logoBuffer: invoice.company_logo_data || null,
      });

      const reminderNumber = invoice.reminder_count + 1;
      await sendInvoiceReminderEmail({
        to: invoice.customer_email,
        cc: invoice.company_admin_email,
        companyName: invoice.company_name,
        invoice,
        pdfBuffer,
        reminderNumber,
        maxReminders: MAX_REMINDERS,
      });

      await db.query(
        `UPDATE invoices SET reminder_count = reminder_count + 1, last_reminder_sent_at = now() WHERE id = $1`,
        [invoice.id]
      );
      sent += 1;
    } catch (err) {
      console.error(`Invoice reminder failed for invoice ${invoice.id}:`, err);
    }
  }
  return sent;
}

module.exports = { checkAndSendReminders, MAX_REMINDERS, REMINDER_INTERVAL_DAYS, TARGET_LOCAL_HOUR };
