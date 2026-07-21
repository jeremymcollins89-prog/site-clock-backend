const RESEND_API_KEY = process.env.RESEND_API_KEY;

// Resend's shared sending address — works immediately with no domain setup.
// Once you verify your own domain on resend.com, swap this for something
// like "timesheets@yourdomain.com".
const FROM_ADDRESS = process.env.RESEND_FROM || "Site Clock <onboarding@resend.dev>";

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
// in the frontend site where they set a new PIN.
async function sendEmployeePinResetEmail({ to, name, token }) {
  const resetUrl = `${FRONTEND_URL}/reset-pin.html?token=${token}`;
  const html = `
    <div style="font-family: -apple-system, sans-serif;">
      <h2>Reset your Site Clock PIN</h2>
      <p>Hi ${name}, click the link below to set a new PIN. This link expires in 1 hour.</p>
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

module.exports = { sendTimesheetEmail, sendAdminPasswordResetEmail, sendEmployeePinResetEmail };