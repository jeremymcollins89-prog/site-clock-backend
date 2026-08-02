const express = require("express");
const router = express.Router();
const db = require("../db");
const { getPayPeriod } = require("../utils/payPeriod");
const { submitTimesheetForEmployee } = require("../utils/timesheetSubmission");
const requireAuth = require("../middleware/requireAuth");

// POST /api/timesheets/submit
// Emails the current pay period's completed shifts to the payroll inbox
// (cc'ing the employee), then marks those entries as submitted so they
// don't get re-sent if the employee taps submit again.
router.post("/submit", requireAuth, async (req, res) => {
  const employee_id = req.employee.employee_id;

  const employeeResult = await db.query(
    `SELECT e.*, c.payroll_email, c.pay_frequency, c.pay_period_anchor, c.pay_period_custom_days, c.timezone
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

  const period = getPayPeriod(new Date(), {
    pay_frequency: employee.pay_frequency,
    pay_period_anchor: employee.pay_period_anchor,
    pay_period_custom_days: employee.pay_period_custom_days,
  });

  let result;
  try {
    result = await submitTimesheetForEmployee({ employee, payrollEmail: employee.payroll_email, period, timezone: employee.timezone });
  } catch (err) {
    console.error("Failed to send timesheet email:", err.message);
    return res.status(502).json({ error: `Couldn't send the timesheet email: ${err.message}` });
  }

  if (!result) {
    return res.status(400).json({ error: "No unsubmitted hours in the current pay period" });
  }

  res.json(result);
});

module.exports = router;
