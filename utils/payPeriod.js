// Pay periods: 1st-15th and 16th-end of month.
function getPayPeriod(date = new Date()) {
  const y = date.getFullYear();
  const m = date.getMonth();

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

// Payday for a given pay period: the 1st (for the 16th-end period) or the
// 15th (for the 1st-15th period), whichever comes right after it ends.
function getPayDate(periodEnd) {
  const d = new Date(periodEnd);
  if (d.getDate() === 15) {
    return new Date(d.getFullYear(), d.getMonth(), 15);
  }
  // last day of month -> pay date is the 1st of next month
  return new Date(d.getFullYear(), d.getMonth() + 1, 1);
}

module.exports = { getPayPeriod, getPayDate };
