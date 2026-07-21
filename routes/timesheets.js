const express = require("express");
const router = express.Router();
const db = require("../db");
const { getPayPeriod } = require("../utils/payPeriod");
const { sendTimesheetEmail } = require("../utils/mailer");
const requireAuth = require("../middleware/requireAuth");

// POST /api/timesheets/submit
// Emails the current pay period's completed shifts to the payroll inbox
// (cc'ing the employee), then marks those entries as submitted so they
// don't get re-sent if the employee taps submit again.
router.post("/submit", requireAuth, async (req, res) => {
  const employee_id = req.employee.employee_id;

  const employeeResult = await db.query(
    `SELECT e.*, c.payroll_email
     FROM employees e
     LEFT JOIN companies c ON c.id = e.company_id
     WHERE e.id = $1`,
    [employee_id]
  );
  if (employeeResult.rowCount === 0) {
    return res.status(404).json({ error: "Employee not found" });
  }
  const employee = employeeResult.rows[0];

  if (!employee.payroll_email) {
    return res.status(400).json({
      error: "Payroll email hasn't been set up for your company yet. Ask your admin to set it in the desktop app's Settings tab.",
    });
  }

  const period = getPayPeriod(new Date());

  const entriesResult = await db.query(
    `SELECT * FROM time_entry_durations
     WHERE employee_id = $1
       AND clock_out IS NOT NULL
       AND clock_out BETWEEN $2 AND $3
       AND submitted_at IS NULL
     ORDER BY clock_in ASC`,
    [employee_id, period.start, period.end]
  );

  if (entriesResult.rowCount === 0) {
    return res.status(400).json({ error: "No unsubmitted hours in the current pay period" });
  }

  try {
    await sendTimesheetEmail({ employee, period, entries: entriesResult.rows, payrollEmail: employee.payroll_email });
  } catch (err) {
    console.error("Failed to send timesheet email:", err.message);
    return res.status(502).json({ error: `Couldn't send the timesheet email: ${err.message}` });
  }

  const ids = entriesResult.rows.map((e) => e.time_entry_id);
  await db.query(
    `UPDATE time_entries SET submitted_at = now() WHERE id = ANY($1::uuid[])`,
    [ids]
  );

  res.json({
    submitted: entriesResult.rowCount,
    period,
  });
});

module.exports = router;
