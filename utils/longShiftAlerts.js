const db = require("../db");
const { sendPushToAdmin } = require("./webPush");

// Scans every open shift (time_entries with no clock_out yet) and pushes the
// admin a "still clocked in" notification once it crosses that company's own
// long_shift_alert_hours setting (1-24, or NULL to turn the alert off --
// see GET/PATCH /api/admin/long-shift-alert). Runs on a timer in server.js
// rather than only when the admin happens to have the app open, since the
// whole point is catching a forgotten clock-out even if nobody's looking.
//
// long_shift_alert_sent on the row keeps this idempotent across runs -- a
// 10-minute polling interval would otherwise re-notify on every single pass
// for as long as the employee stays clocked in.
async function checkAndSendLongShiftAlerts() {
  const result = await db.query(
    `SELECT te.id AS time_entry_id, te.employee_id, te.clock_in, e.name AS employee_name, e.company_id,
            c.long_shift_alert_hours
     FROM time_entries te
     JOIN employees e ON e.id = te.employee_id
     JOIN companies c ON c.id = e.company_id
     WHERE te.clock_out IS NULL
       AND te.long_shift_alert_sent = false
       AND c.long_shift_alert_hours IS NOT NULL
       AND te.clock_in <= now() - (c.long_shift_alert_hours || ' hours')::interval`
  );

  let sent = 0;
  for (const row of result.rows) {
    try {
      await sendPushToAdmin(row.company_id, {
        title: "Long shift alert",
        body: `${row.employee_name} has been clocked in for over ${row.long_shift_alert_hours} hour${row.long_shift_alert_hours === 1 ? "" : "s"} — check in?`,
        url: "/admin.html?view=overview",
      });
      await db.query(`UPDATE time_entries SET long_shift_alert_sent = true WHERE id = $1`, [row.time_entry_id]);
      sent++;
    } catch (err) {
      console.error(`Failed to send long-shift alert for time entry ${row.time_entry_id}:`, err.message);
    }
  }
  return sent;
}

module.exports = { checkAndSendLongShiftAlerts };
