const nodemailer = require("nodemailer");

// Configure via env vars — works with SMTP (e.g. Google Workspace, Postmark,
// SendGrid SMTP relay, etc). Swap for an HTTP-based provider SDK if you'd
// rather avoid SMTP.
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const OWNER_EMAIL = process.env.PAYROLL_EMAIL; // where timesheets get sent

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

// entries: rows from time_entry_durations for one employee + pay period
async function sendTimesheetEmail({ employee, period, entries }) {
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

  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: OWNER_EMAIL,
    cc: employee.email, // employee gets a copy of what was submitted
    subject: `Timesheet — ${employee.name} — ${fmtDate(period.start)} to ${fmtDate(period.end)}`,
    html,
  });
}

module.exports = { sendTimesheetEmail };
