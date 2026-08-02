const db = require("../db");
const { getPayPeriod, getPayDate } = require("./payPeriod");
const { submitTimesheetForEmployee } = require("./timesheetSubmission");

// Runs once per company per day, at TARGET_LOCAL_HOUR in that company's own
// timezone (see server.js -- this is checked every hour, same pattern as
// invoiceReminders.js, so it only actually acts during the one matching pass
// each day). Catches any employee who forgot to tap "Submit Hours for
// Payroll" before payday: it walks forward, one pay period at a time, from
// their oldest unsubmitted completed shift, and for every period that has
// (a) fully ended and (b) already reached its payday, auto-submits whatever
// is still sitting there -- same email + same submitted_at flip as if the
// employee had hit submit themselves, just flagged auto_submitted so the
// email can say so. A period that's still open, or one that's ended but
// hasn't hit payday yet, is left alone -- that's still the employee's own
// window to submit it themselves.
const TARGET_LOCAL_HOUR = 6;

function localHourIn(timezone) {
  try {
    const hourStr = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      hour12: false,
    }).format(new Date());
    return Number(hourStr) % 24;
  } catch (err) {
    return -1;
  }
}

// Caps how many pay periods back a single employee can be walked in one
// pass -- purely a runaway-loop guard (e.g. a misconfigured custom period
// length); a real backlog this deep would mean months of unsubmitted hours,
// which is worth Jeremy noticing rather than silently mass-emailing anyway.
const MAX_PERIODS_PER_RUN = 36;

async function checkAndAutoSubmitTimesheets() {
  const companiesResult = await db.query(
    `SELECT id, timezone, pay_frequency, pay_period_anchor, pay_period_custom_days, payroll_email
     FROM companies WHERE payroll_email IS NOT NULL`
  );

  let submitted = 0;
  for (const company of companiesResult.rows) {
    try {
      if (localHourIn(company.timezone) !== TARGET_LOCAL_HOUR) continue;

      const settings = {
        pay_frequency: company.pay_frequency,
        pay_period_anchor: company.pay_period_anchor,
        pay_period_custom_days: company.pay_period_custom_days,
      };

      const employeesResult = await db.query(
        `SELECT DISTINCT e.id, e.name, e.email
         FROM employees e
         JOIN time_entries te ON te.employee_id = e.id
         WHERE e.company_id = $1 AND te.clock_out IS NOT NULL AND te.submitted_at IS NULL`,
        [company.id]
      );

      for (const employee of employeesResult.rows) {
        if (!employee.email) continue;

        const oldestResult = await db.query(
          `SELECT MIN(clock_out) AS earliest FROM time_entries
           WHERE employee_id = $1 AND clock_out IS NOT NULL AND submitted_at IS NULL`,
          [employee.id]
        );
        if (!oldestResult.rows[0].earliest) continue;

        let cursor = new Date(oldestResult.rows[0].earliest);
        const now = new Date();

        for (let i = 0; i < MAX_PERIODS_PER_RUN; i++) {
          const period = getPayPeriod(cursor, settings);
          if (period.end >= now) break; // still the current, still-open period -- leave it for the employee

          const payDate = getPayDate(period.end, settings);
          if (payDate > now) break; // period's over, but payday hasn't arrived yet

          const result = await submitTimesheetForEmployee({
            employee,
            payrollEmail: company.payroll_email,
            period,
            autoSubmitted: true,
          });
          if (result) submitted += result.submitted;

          cursor = new Date(period.end.getTime() + 24 * 60 * 60 * 1000); // move to the next period
        }
      }
    } catch (err) {
      console.error(`Auto-submit timesheet check failed for company ${company.id}:`, err.message);
    }
  }
  return submitted;
}

module.exports = { checkAndAutoSubmitTimesheets };
