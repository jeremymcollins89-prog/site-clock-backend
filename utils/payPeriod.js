// Pay periods are configurable per company. `settings` is an object with
// pay_frequency ("semi_monthly" | "monthly" | "biweekly" | "weekly" | "custom"),
// and for the anchored frequencies (biweekly/weekly/custom), a
// pay_period_anchor (the start date of some known period) and, for custom,
// pay_period_custom_days (the length of a period in days).

function daysBetween(a, b) {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const utcA = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const utcB = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.floor((utcB - utcA) / MS_PER_DAY);
}

// Finds the start/end of whichever fixed-length period (anchored to a known
// start date) the given date falls into.
function anchoredPeriod(date, anchor, periodDays) {
  const diff = daysBetween(anchor, date);
  const periodIndex = Math.floor(diff / periodDays);
  const offset = periodIndex * periodDays;
  const start = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + offset, 0, 0, 0);
  const end = new Date(
    anchor.getFullYear(),
    anchor.getMonth(),
    anchor.getDate() + offset + periodDays - 1,
    23, 59, 59, 999
  );
  return { start, end };
}

function getPayPeriod(date = new Date(), settings = {}) {
  const frequency = settings.pay_frequency || "semi_monthly";
  const y = date.getFullYear();
  const m = date.getMonth();

  if (frequency === "monthly") {
    const lastDay = new Date(y, m + 1, 0).getDate();
    return {
      start: new Date(y, m, 1, 0, 0, 0),
      end: new Date(y, m, lastDay, 23, 59, 59, 999),
    };
  }

  if (frequency === "weekly" || frequency === "biweekly" || frequency === "custom") {
    const anchor = settings.pay_period_anchor ? new Date(settings.pay_period_anchor) : new Date(y, m, 1);
    const periodDays =
      frequency === "weekly" ? 7 :
      frequency === "biweekly" ? 14 :
      Number(settings.pay_period_custom_days) || 14;
    return anchoredPeriod(date, anchor, periodDays);
  }

  // Default / "semi_monthly": 1st-15th and 16th-end of month.
  if (date.getDate() <= 15) {
    return {
      start: new Date(y, m, 1, 0, 0, 0),
      end: new Date(y, m, 15, 23, 59, 59, 999),
    };
  }
  const lastDay = new Date(y, m + 1, 0).getDate();
  return {
    start: new Date(y, m, 16, 0, 0, 0),
    end: new Date(y, m, lastDay, 23, 59, 59, 999),
  };
}

// Payday for a given pay period. For semi-monthly, this follows the usual
// business convention (paid on the 15th, and on the 1st of the next month).
// For every other frequency, payday defaults to the day right after the
// period ends.
function getPayDate(periodEnd, settings = {}) {
  const frequency = settings.pay_frequency || "semi_monthly";
  const d = new Date(periodEnd);

  if (frequency === "semi_monthly") {
    if (d.getDate() === 15) {
      return new Date(d.getFullYear(), d.getMonth(), 15);
    }
    return new Date(d.getFullYear(), d.getMonth() + 1, 1);
  }

  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
}

const PAY_FREQUENCIES = ["semi_monthly", "biweekly", "weekly", "monthly", "custom"];

module.exports = { getPayPeriod, getPayDate, PAY_FREQUENCIES };
