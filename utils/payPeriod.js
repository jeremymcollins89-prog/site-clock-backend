// Pay periods are configurable per company. `settings` is an object with
// pay_frequency ("semi_monthly" | "monthly" | "biweekly" | "weekly" | "custom"),
// and for the anchored frequencies (biweekly/weekly/custom), a
// pay_period_anchor (the start date of some known period) and, for custom,
// pay_period_custom_days (the length of a period in days).
//
// Every boundary below is computed in the COMPANY's own timezone (the
// `timezone` param, an IANA name like "America/Denver"), not the server's.
// The server runs in UTC (or whatever its host defaults to); if period
// boundaries were computed using the server's local time, a shift late at
// night in the company's own timezone could land on the "wrong" UTC
// calendar day and get silently misattributed to the wrong pay period --
// off by however many hours the company is offset from the server, right at
// every period boundary. getDatePartsInTimezone/zonedTimeToUtc below exist
// specifically to avoid that.

// Returns the wall-clock date/time parts that `date` (an absolute instant)
// falls on in the given IANA timezone -- e.g. late-night UTC can still be
// "yesterday" in Denver, which is exactly the case this exists to get right.
function getDatePartsInTimezone(date, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone || "UTC",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const parts = {};
  for (const { type, value } of fmt.formatToParts(date)) {
    if (type !== "literal") parts[type] = value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month) - 1, // JS Date months are 0-indexed
    day: Number(parts.day),
    // Some engines format midnight as "24" instead of "00" for hour12:false.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

// The inverse of the above: builds the UTC instant corresponding to a
// specific wall-clock date/time in the given IANA timezone. Uses a
// guess-and-correct approach -- treat the wall-clock values as if they were
// already UTC, see how far off that guess actually lands when read back in
// the target timezone, and correct by the difference. This re-derives the
// real UTC offset at that specific instant (rather than assuming a fixed
// one), so it stays correct across DST transitions.
function zonedTimeToUtc(year, month, day, hour, minute, second, ms, timeZone) {
  const guess = new Date(Date.UTC(year, month, day, hour, minute, second, ms));
  const seenAsLocal = getDatePartsInTimezone(guess, timeZone);
  const guessInterpretedAsUtc = Date.UTC(
    seenAsLocal.year, seenAsLocal.month, seenAsLocal.day,
    seenAsLocal.hour, seenAsLocal.minute, seenAsLocal.second, ms
  );
  const offsetMs = guessInterpretedAsUtc - guess.getTime();
  return new Date(guess.getTime() - offsetMs);
}

function startOfDayInTz(year, month, day, timeZone) {
  return zonedTimeToUtc(year, month, day, 0, 0, 0, 0, timeZone);
}
function endOfDayInTz(year, month, day, timeZone) {
  return zonedTimeToUtc(year, month, day, 23, 59, 59, 999, timeZone);
}
function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

// Days between two Postgres DATE values -- pure calendar-day arithmetic,
// read with UTC getters since a DATE column has no time-of-day or timezone
// component of its own (it round-trips through pg as midnight UTC
// regardless of the company's actual timezone). Not timezone conversion --
// just counting whole days between two calendar dates.
function daysBetweenCalendarDates(a, b) {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const utcA = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const utcB = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  return Math.floor((utcB - utcA) / MS_PER_DAY);
}

// Finds the start/end of whichever fixed-length period (anchored to a known
// start date) the given calendar day (year/month/day, as seen in the
// company's timezone) falls into. `anchor` is a Postgres DATE value -- see
// daysBetweenCalendarDates for why it's read with UTC getters rather than
// run through zonedTimeToUtc (it has no time-of-day/timezone component to
// convert; it's just a calendar date).
function anchoredPeriod(year, month, day, anchor, periodDays, timeZone) {
  const dayAsUtcDate = new Date(Date.UTC(year, month, day));
  const diff = daysBetweenCalendarDates(anchor, dayAsUtcDate);
  const periodIndex = Math.floor(diff / periodDays);
  const offset = periodIndex * periodDays;

  const startDate = new Date(anchor.getTime());
  startDate.setUTCDate(startDate.getUTCDate() + offset);
  const endDate = new Date(anchor.getTime());
  endDate.setUTCDate(endDate.getUTCDate() + offset + periodDays - 1);

  return {
    start: startOfDayInTz(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate(), timeZone),
    end: endOfDayInTz(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate(), timeZone),
  };
}

function getPayPeriod(date = new Date(), settings = {}, timezone = "UTC") {
  const frequency = settings.pay_frequency || "semi_monthly";
  const { year: y, month: m, day: d } = getDatePartsInTimezone(date, timezone);

  if (frequency === "monthly") {
    return {
      start: startOfDayInTz(y, m, 1, timezone),
      end: endOfDayInTz(y, m, lastDayOfMonth(y, m), timezone),
    };
  }

  if (frequency === "weekly" || frequency === "biweekly" || frequency === "custom") {
    const anchor = settings.pay_period_anchor ? new Date(settings.pay_period_anchor) : new Date(Date.UTC(y, m, 1));
    const periodDays =
      frequency === "weekly" ? 7 :
      frequency === "biweekly" ? 14 :
      Number(settings.pay_period_custom_days) || 14;
    return anchoredPeriod(y, m, d, anchor, periodDays, timezone);
  }

  // Default / "semi_monthly": 1st-15th and 16th-end of month.
  if (d <= 15) {
    return { start: startOfDayInTz(y, m, 1, timezone), end: endOfDayInTz(y, m, 15, timezone) };
  }
  return { start: startOfDayInTz(y, m, 16, timezone), end: endOfDayInTz(y, m, lastDayOfMonth(y, m), timezone) };
}

// Payday for a given pay period, in the company's own timezone. For
// semi-monthly, this follows the usual business convention (paid on the
// 15th, and on the 1st of the next month). For every other frequency,
// payday defaults to the day right after the period ends.
function getPayDate(periodEnd, settings = {}, timezone = "UTC") {
  const frequency = settings.pay_frequency || "semi_monthly";
  const { year: y, month: m, day: d } = getDatePartsInTimezone(periodEnd, timezone);

  if (frequency === "semi_monthly") {
    if (d === 15) return startOfDayInTz(y, m, 15, timezone);
    const nextMonth = new Date(Date.UTC(y, m + 1, 1));
    return startOfDayInTz(nextMonth.getUTCFullYear(), nextMonth.getUTCMonth(), 1, timezone);
  }

  const nextDay = new Date(Date.UTC(y, m, d + 1));
  return startOfDayInTz(nextDay.getUTCFullYear(), nextDay.getUTCMonth(), nextDay.getUTCDate(), timezone);
}

const PAY_FREQUENCIES = ["semi_monthly", "biweekly", "weekly", "monthly", "custom"];

module.exports = { getPayPeriod, getPayDate, PAY_FREQUENCIES };
