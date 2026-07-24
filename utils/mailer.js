const RESEND_API_KEY = process.env.RESEND_API_KEY;

// Falls back to Resend's shared sandbox address if RESEND_FROM isn't set in
// the environment, but production should always set RESEND_FROM to an
// address on the verified collbusinesssolutions.com domain.
const FROM_ADDRESS = process.env.RESEND_FROM || "Coll Timeclock <timesheets@collbusinesssolutions.com>";

// Where the employee PWA (and its static reset pages) are hosted. Used to
// build clickable links in reset emails.
const FRONTEND_URL = process.env.FRONTEND_URL || "https://site-clock-frontend-production.up.railway.app";

function fmtDuration(totalSeconds) {
  const totalMin = Math.round(totalSeconds / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h === 0 ? `${m}m` : `${h}h ${m}m`;
}

function fmtDate(d) {
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function fmtTime(d) {
  return new Date(d).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

// entries: rows from time_entry_durations for one employee + pay period.
// payrollEmail: this employee's own company's payroll inbox — never a
// global fallback, since that would risk sending one company's timesheet
// data to a different company's owner.
async function sendTimesheetEmail({ employee, period, entries, payrollEmail }) {
  const totalSeconds = entries.reduce((s, e) => s + Number(e.worked_seconds || 0), 0);

  const rows = entries
    .map(
      (e) => `
        <tr>
          <td style="padding:4px 8px;">${fmtDate(e.clock_in)}</td>
          <td style="padding:4px 8px;">${e.job_name}</td>
          <td style="padding:4px 8px;">${e.location_type === "in_town" ? "In town" : "Traveling"}</td>
          <td style="padding:4px 8px;">${fmtTime(e.clock_in)}–${fmtTime(e.clock_out)}</td>
          <td style="padding:4px 8px;">${fmtDuration(e.worked_seconds)}</td>
        </tr>`
    )
    .join("");

  const html = `
    <div style="font-family: -apple-system, sans-serif;">
      <h2>Timesheet — ${employee.name}</h2>
      <p>Pay period: ${fmtDate(period.start)} – ${fmtDate(period.end)}</p>
      <p><strong>Total: ${fmtDuration(totalSeconds)}</strong></p>
      <table style="border-collapse: collapse; width: 100%;">
        <thead>
          <tr style="text-align:left; border-bottom: 1px solid #ccc;">
            <th style="padding:4px 8px;">Date</th>
            <th style="padding:4px 8px;">Job</th>
            <th style="padding:4px 8px;">Location</th>
            <th style="padding:4px 8px;">Time</th>
            <th style="padding:4px 8px;">Worked</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM_ADDRESS,
      to: [payrollEmail],
      cc: [employee.email],
      subject: `Timesheet — ${employee.name} — ${fmtDate(period.start)} to ${fmtDate(period.end)}`,
      html,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Resend API error (${res.status}): ${errBody}`);
  }
}

// Sent when a company admin requests a password reset. The link opens a
// static page in the frontend site where they set a new password.
async function sendAdminPasswordResetEmail({ to, token }) {
  const resetUrl = `${FRONTEND_URL}/admin-reset-password.html?token=${token}`;
  const html = `
    <div style="font-family: -apple-system, sans-serif;">
      <h2>Reset your Site Clock admin password</h2>
      <p>Click the link below to set a new password. This link expires in 1 hour.</p>
      <p><a href="${resetUrl}">${resetUrl}</a></p>
      <p style="color:#8A8578; font-size:13px;">If you didn't request this, you can safely ignore this email.</p>
    </div>
  `;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM_ADDRESS,
      to: [to],
      subject: "Reset your Site Clock password",
      html,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Resend API error (${res.status}): ${errBody}`);
  }
}

// Sent when an employee requests a PIN reset. The link opens a static page
// in the frontend site where they set a new PIN. companyName is only passed
// in when this same email matched employees at more than one company, so the
// message can make clear which account this particular link resets.
async function sendEmployeePinResetEmail({ to, name, token, companyName }) {
  const resetUrl = `${FRONTEND_URL}/reset-pin.html?token=${token}`;
  const companyLine = companyName
    ? `<p>This link resets your PIN for your account at <strong>${companyName}</strong>. If you have accounts at more than one company using this same email, you'll get a separate email for each.</p>`
    : "";
  const html = `
    <div style="font-family: -apple-system, sans-serif;">
      <h2>Reset your Coll Timeclock PIN</h2>
      <p>Hi ${name}, click the link below to set a new PIN. This link expires in 1 hour.</p>
      ${companyLine}
      <p><a href="${resetUrl}">${resetUrl}</a></p>
      <p style="color:#8A8578; font-size:13px;">If you didn't request this, you can safely ignore this email.</p>
    </div>
  `;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM_ADDRESS,
      to: [to],
      subject: "Reset your Site Clock PIN",
      html,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Resend API error (${res.status}): ${errBody}`);
  }
}

const PAYMENT_TERMS_LABELS = {
  due_on_receipt: "Due on receipt",
  net_15: "Net 15",
  net_30: "Net 30",
  net_60: "Net 60",
  net_90: "Net 90",
};

function fmtMoney(n) {
  return `$${Number(n).toFixed(2)}`;
}

// Emails an invoice PDF to the customer, cc'ing the company's own admin
// email so there's always a paper trail of what went out. pdfBuffer is a
// Buffer (from utils/invoicePdf.js) attached as base64, the format Resend's
// API expects for attachments.
async function sendInvoiceEmail({ to, cc, companyName, invoice, pdfBuffer }) {
  const html = `
    <div style="font-family: -apple-system, sans-serif;">
      <h2>Invoice #${invoice.invoice_number} from ${companyName}</h2>
      <p>Amount due: <strong>${fmtMoney(invoice.total)}</strong></p>
      <p>Due date: ${fmtDate(invoice.due_date)} (${PAYMENT_TERMS_LABELS[invoice.payment_terms] || invoice.payment_terms})</p>
      <p>The full invoice is attached as a PDF.</p>
    </div>
  `;

  const body = {
    from: FROM_ADDRESS,
    to: [to],
    subject: `Invoice #${invoice.invoice_number} from ${companyName} — ${fmtMoney(invoice.total)} due ${fmtDate(invoice.due_date)}`,
    html,
    attachments: [
      {
        filename: `invoice-${invoice.invoice_number}.pdf`,
        content: pdfBuffer.toString("base64"),
      },
    ],
  };
  if (cc) body.cc = [cc];

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Resend API error (${res.status}): ${errBody}`);
  }
}

// Automatic follow-up for an unpaid invoice -- same PDF re-attached, but the
// subject/body make clear it's a reminder rather than the original send, and
// say where it falls in the capped sequence (max 5, see
// utils/invoiceReminders.js) so the customer isn't confused by "reminder 4".
async function sendInvoiceReminderEmail({ to, cc, companyName, invoice, pdfBuffer, reminderNumber, maxReminders }) {
  const isPastDue = new Date(invoice.due_date) < new Date();
  const html = `
    <div style="font-family: -apple-system, sans-serif;">
      <h2>Reminder: Invoice #${invoice.invoice_number} from ${companyName}</h2>
      <p>Amount due: <strong>${fmtMoney(invoice.total)}</strong></p>
      <p>${isPastDue
        ? `This invoice was due on ${fmtDate(invoice.due_date)} and hasn't been marked paid yet.`
        : `This invoice is due on ${fmtDate(invoice.due_date)}.`
      }</p>
      <p>The full invoice is attached again as a PDF.</p>
      <p style="color:#999; font-size:12px;">Reminder ${reminderNumber} of ${maxReminders}.</p>
    </div>
  `;

  const body = {
    from: FROM_ADDRESS,
    to: [to],
    subject: `Reminder: Invoice #${invoice.invoice_number} from ${companyName} — ${fmtMoney(invoice.total)} due ${fmtDate(invoice.due_date)}`,
    html,
    attachments: [
      {
        filename: `invoice-${invoice.invoice_number}.pdf`,
        content: pdfBuffer.toString("base64"),
      },
    ],
  };
  if (cc) body.cc = [cc];

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Resend API error (${res.status}): ${errBody}`);
  }
}

module.exports = {
  sendTimesheetEmail,
  sendAdminPasswordResetEmail,
  sendInvoiceReminderEmail,
  sendEmployeePinResetEmail,
  sendInvoiceEmail,
};