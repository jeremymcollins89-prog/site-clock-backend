const db = require("../db");
const { renderInvoicePdf } = require("./invoicePdf");
const { sendInvoiceReminderEmail } = require("./mailer");

// Automatic reminder emails for unpaid ("sent") invoices. First reminder
// fires on or after the due date; each one after that waits at least this
// many days from the last reminder, capped at MAX_REMINDERS total. Timing
// is driven by elapsed time since last_reminder_sent_at rather than an
// exact calendar-day match, so a missed run of the daily job (deploy,
// restart, etc.) just catches up on the next run instead of skipping a
// reminder entirely.
const REMINDER_INTERVAL_DAYS = 7;
const MAX_REMINDERS = 5;

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

// Scans every company's unpaid, sent invoices and sends a reminder to any
// that are due. Errors on one invoice are logged and skipped rather than
// aborting the whole batch, so one bad row can't block reminders for
// everyone else.
async function checkAndSendReminders() {
  const today = new Date();
  const result = await db.query(
    `SELECT i.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
            c.street AS customer_street, c.city AS customer_city, c.state AS customer_state, c.zip AS customer_zip,
            comp.name AS company_name, comp.admin_email AS company_admin_email, comp.logo_data AS company_logo_data
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

module.exports = { checkAndSendReminders, MAX_REMINDERS, REMINDER_INTERVAL_DAYS };
