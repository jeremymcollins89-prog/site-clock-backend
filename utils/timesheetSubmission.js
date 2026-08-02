const db = require("../db");
const { sendTimesheetEmail } = require("./mailer");

// Shared by the employee-triggered "Submit Hours for Payroll" button
// (routes/timesheets.js) and the auto-submit cron job
// (autoSubmitTimesheets.js), so both paths compute, email, and mark-submitted
// identically. The only difference between the two callers is whether
// autoSubmitted is true, which just changes the email's wording.
//
// Returns null (does nothing, sends nothing) if there's nothing unsubmitted
// in this period -- callers decide what that means for them (the manual
// route turns it into a 400, the cron job just moves on).
async function submitTimesheetForEmployee({ employee, payrollEmail, period, autoSubmitted = false, timezone }) {
  const entriesResult = await db.query(
    `SELECT * FROM time_entry_durations
     WHERE employee_id = $1
       AND clock_out IS NOT NULL
       AND clock_out BETWEEN $2 AND $3
       AND submitted_at IS NULL
     ORDER BY clock_in ASC`,
    [employee.id, period.start, period.end]
  );

  if (entriesResult.rowCount === 0) return null;

  await sendTimesheetEmail({ employee, period, entries: entriesResult.rows, payrollEmail, autoSubmitted, timezone });

  const ids = entriesResult.rows.map((e) => e.time_entry_id);
  await db.query(
    `UPDATE time_entries SET submitted_at = now(), auto_submitted = $2 WHERE id = ANY($1::uuid[])`,
    [ids, autoSubmitted]
  );

  return { submitted: entriesResult.rowCount, period };
}

module.exports = { submitTimesheetForEmployee };
