const express = require("express");
const router = express.Router();
const db = require("../db"); // your existing pg Pool, adjust path to match your project
const requireAuth = require("../middleware/requireAuth");
const { setAutoClockinSuppressed, clearAutoClockinSuppressed } = require("../utils/autoClockinSuppression");
const { reverseGeocodeState } = require("../utils/geocode");
const { getPayPeriod } = require("../utils/payPeriod");

router.use(requireAuth); // every route below requires a valid employee token

// POST /api/time-entries/clock-in
router.post("/clock-in", async (req, res) => {
  try {
    const employee_id = req.employee.employee_id;
    const { job_name, location_type } = req.body;
    if (!job_name || !location_type) {
      return res.status(400).json({ error: "job_name and location_type are required" });
    }
    if (!["in_town", "traveling"].includes(location_type)) {
      return res.status(400).json({ error: "location_type must be 'in_town' or 'traveling'" });
    }

    const openShift = await db.query(
      `SELECT id FROM time_entries WHERE employee_id = $1 AND clock_out IS NULL`,
      [employee_id]
    );
    if (openShift.rowCount > 0) {
      return res.status(409).json({ error: "Employee already has an open shift" });
    }

    const result = await db.query(
      `INSERT INTO time_entries (employee_id, job_name, location_type, clock_in)
       VALUES ($1, $2, $3, now()) RETURNING *`,
      [employee_id, job_name, location_type]
    );

    // Any successful clock-in -- manual or auto -- makes a leftover
    // "don't auto clock-in" flag from a previous manual clock-out stale.
    // Not awaited-and-checked beyond logging: this is bookkeeping for the
    // *next* clock-out decision, never something this response depends on.
    clearAutoClockinSuppressed(employee_id).catch((err) =>
      console.error("Failed to clear auto_clockin_suppressed on clock-in:", err)
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("POST /time-entries/clock-in failed:", err);
    res.status(500).json({ error: "Couldn't clock in. Please try again." });
  }
});

// POST /api/time-entries/:id/break-start
router.post("/:id/break-start", async (req, res) => {
  try {
    const { id } = req.params;
    const employee_id = req.employee.employee_id;

    // Confirms this shift is actually the caller's own before touching it --
    // :id is just a UUID off the URL, so without this check any authenticated
    // employee (any company) who somehow got hold of another employee's
    // time_entries.id could start/end their breaks or clock them out.
    const ownEntry = await db.query(
      `SELECT id FROM time_entries WHERE id = $1 AND employee_id = $2 AND clock_out IS NULL`,
      [id, employee_id]
    );
    if (ownEntry.rowCount === 0) {
      return res.status(404).json({ error: "No open shift with that id" });
    }

    const openBreak = await db.query(
      `SELECT id FROM time_entry_breaks WHERE time_entry_id = $1 AND break_end IS NULL`,
      [id]
    );
    if (openBreak.rowCount > 0) {
      return res.status(409).json({ error: "Break already in progress" });
    }
    const result = await db.query(
      `INSERT INTO time_entry_breaks (time_entry_id, break_start)
       VALUES ($1, now()) RETURNING *`,
      [id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("POST /time-entries/:id/break-start failed:", err);
    res.status(500).json({ error: "Couldn't start break. Please try again." });
  }
});

// POST /api/time-entries/:id/break-end
router.post("/:id/break-end", async (req, res) => {
  try {
    const { id } = req.params;
    const employee_id = req.employee.employee_id;
    const result = await db.query(
      `UPDATE time_entry_breaks SET break_end = now()
       WHERE time_entry_id = $1 AND break_end IS NULL
         AND EXISTS (SELECT 1 FROM time_entries te WHERE te.id = $1 AND te.employee_id = $2)
       RETURNING *`,
      [id, employee_id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "No break in progress for this shift" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error("POST /time-entries/:id/break-end failed:", err);
    res.status(500).json({ error: "Couldn't end break. Please try again." });
  }
});

// POST /api/time-entries/:id/clock-out
router.post("/:id/clock-out", async (req, res) => {
  try {
    const { id } = req.params;
    const employee_id = req.employee.employee_id;
    // Only a genuinely manual clock-out (the employee tapping the button
    // themselves) should suppress auto clock-in afterward -- the automatic,
    // geofence-driven clock-out never sends this, since there's nothing to
    // suppress: they've already left, so auto clock-in won't fire again
    // until a fresh arrival anyway.
    const manual = req.body.manual === true;

    // close any dangling open break first (only if this shift is actually the caller's own)
    await db.query(
      `UPDATE time_entry_breaks SET break_end = now()
       WHERE time_entry_id = $1 AND break_end IS NULL
         AND EXISTS (SELECT 1 FROM time_entries te WHERE te.id = $1 AND te.employee_id = $2)`,
      [id, employee_id]
    );

    const result = await db.query(
      `UPDATE time_entries SET clock_out = now()
       WHERE id = $1 AND employee_id = $2 AND clock_out IS NULL
       RETURNING *`,
      [id, employee_id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "No open shift with that id" });
    }

    if (manual) {
      setAutoClockinSuppressed(employee_id).catch((err) =>
        console.error("Failed to set auto_clockin_suppressed on manual clock-out:", err)
      );
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("POST /time-entries/:id/clock-out failed:", err);
    res.status(500).json({ error: "Couldn't clock out. Please try again." });
  }
});

// POST /api/time-entries/clear-auto-clockin-suppression
// Called once a client (web app today, a native background client in the
// future) detects the employee has actually left the shop radius after a
// manual clock-out -- from that point on, a fresh arrival is a genuine new
// one, so the "don't auto clock-in" flag no longer applies. Safe to call
// even if the flag was never set (idempotent no-op).
router.post("/clear-auto-clockin-suppression", async (req, res) => {
  try {
    const employee_id = req.employee.employee_id;
    await clearAutoClockinSuppressed(employee_id);
    res.json({ ok: true });
  } catch (err) {
    console.error("POST /time-entries/clear-auto-clockin-suppression failed:", err);
    res.status(500).json({ error: "Couldn't update suppression state." });
  }
});

// GET /api/time-entries/pay-period
// Returns the start/end (ISO strings) of whichever pay period "now" falls
// into for this employee's company -- computed using the company's actual
// pay_frequency/anchor settings AND its own timezone (not the server's, and
// not the requesting device's clock), so this always matches what the
// backend will actually use when the employee taps "Submit Hours for
// Payroll" (routes/timesheets.js) or what the admin's Overview dashboard
// shows (routes/admin.js). The employee app should call this instead of
// computing period boundaries itself -- a client-side reimplementation of
// this logic (which is exactly what used to happen here) is very easy to
// get subtly wrong or out of sync with the real backend logic, and a wrong
// pay-frequency guess or the device's own local time can each shift the
// boundary a full period out of alignment near the edges.
router.get("/pay-period", async (req, res) => {
  try {
    const employee_id = req.employee.employee_id;
    const companyResult = await db.query(
      `SELECT c.pay_frequency, c.pay_period_anchor, c.pay_period_custom_days, c.timezone
       FROM employees e JOIN companies c ON c.id = e.company_id
       WHERE e.id = $1`,
      [employee_id]
    );
    if (companyResult.rowCount === 0) return res.status(404).json({ error: "Employee not found" });
    const company = companyResult.rows[0];
    const period = getPayPeriod(new Date(), {
      pay_frequency: company.pay_frequency,
      pay_period_anchor: company.pay_period_anchor,
      pay_period_custom_days: company.pay_period_custom_days,
    }, company.timezone);
    res.json({ start: period.start.toISOString(), end: period.end.toISOString() });
  } catch (err) {
    console.error("GET /time-entries/pay-period failed:", err);
    res.status(500).json({ error: "Couldn't determine the current pay period." });
  }
});

// GET /api/time-entries?start=&end=
// Only returns the open shift (if any) plus completed shifts that haven't
// been submitted for payroll yet -- once submitHours() (POST
// /api/timesheets/submit) marks a shift's submitted_at, it drops out of
// this list entirely. The row still lives in the database for payroll and
// admin reporting; this just keeps the employee's on-screen history from
// re-showing hours they already turned in, without waiting for the pay
// period itself to roll over.
router.get("/", async (req, res) => {
  try {
    const employee_id = req.employee.employee_id;
    const { start, end } = req.query;
    const conditions = [`employee_id = $1`, `(clock_out IS NULL OR submitted_at IS NULL)`];
    const params = [employee_id];

    // Same fix as routes/admin.js's GET /time-entries: end is a plain
    // "YYYY-MM-DD" date, and clock_in <= that casts to midnight, silently
    // excluding anything on the end day itself with a clock_in after 00:00.
    // "< end + 1 day" makes the end day fully inclusive.
    if (start) {
      params.push(start);
      conditions.push(`clock_in >= $${params.length}::date`);
    }
    if (end) {
      params.push(end);
      conditions.push(`clock_in < ($${params.length}::date + INTERVAL '1 day')`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await db.query(
      `SELECT * FROM time_entry_durations ${where} ORDER BY clock_in DESC`,
      params
    );
    const rows = result.rows;

    // If the currently open shift also has an open break, attach when that
    // break started -- the app uses this to restore "on break" (rather than
    // just "working") when it's closed and reopened mid-break.
    const openRow = rows.find((r) => !r.clock_out);
    if (openRow) {
      const breakResult = await db.query(
        `SELECT break_start FROM time_entry_breaks WHERE time_entry_id = $1 AND break_end IS NULL`,
        [openRow.time_entry_id]
      );
      openRow.open_break_start = breakResult.rowCount > 0 ? breakResult.rows[0].break_start : null;
    }

    res.json(rows);
  } catch (err) {
    console.error("GET /time-entries failed:", err);
    res.status(500).json({ error: "Couldn't load time entries. Please try again." });
  }
});

router.post("/ping-location", async (req, res) => {
  try {
    const employee_id = req.employee.employee_id;
    const { lat, lng } = req.body;
    if (typeof lat !== "number" || typeof lng !== "number") {
      return res.status(400).json({ error: "lat and lng are required numbers" });
    }

    const openShift = await db.query(
      `SELECT id FROM time_entries WHERE employee_id = $1 AND clock_out IS NULL`,
      [employee_id]
    );
    if (openShift.rowCount === 0) {
      return res.json({ stored: false, reason: "not clocked in" });
    }

    await db.query(
      `INSERT INTO employee_locations (employee_id, lat, lng, recorded_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (employee_id) DO UPDATE SET lat = $2, lng = $3, recorded_at = now()`,
      [employee_id, lat, lng]
    );
    res.json({ stored: true });
  } catch (err) {
    console.error("POST /time-entries/ping-location failed:", err);
    res.status(500).json({ error: "Couldn't record location." });
  }
});

router.get("/ping-status", async (req, res) => {
  try {
    const employee_id = req.employee.employee_id;
    const result = await db.query(
      `SELECT pr.requested_at, l.recorded_at
       FROM ping_requests pr
       LEFT JOIN employee_locations l ON l.employee_id = pr.employee_id
       WHERE pr.employee_id = $1`,
      [employee_id]
    );
    if (result.rowCount === 0) return res.json({ shouldPing: false });
    const { requested_at, recorded_at } = result.rows[0];
    const shouldPing = !recorded_at || new Date(requested_at) > new Date(recorded_at);
    res.json({ shouldPing });
  } catch (err) {
    console.error("GET /time-entries/ping-status failed:", err);
    res.status(500).json({ error: "Couldn't check ping status." });
  }
});

// GET /api/time-entries/travel-check?lat=&lng=
// Powers the employee app's auto-default of the manual "In Town" / "Traveling"
// toggle shown before clocking in (see location_type on POST /clock-in): the
// app calls this with the employee's current GPS position, we reverse-geocode
// it to a state and compare against this company's cached shop_state (set
// whenever the admin saves a shop location -- see PATCH /admin/shop-location
// and utils/geocode.js's reverseGeocodeState), and tell the client which way
// to default. The client still lets the employee tap the other option
// manually -- this only decides which one is pre-selected.
//
// Returns `traveling: null` (rather than guessing) whenever we can't make a
// confident comparison: no shop location configured yet, or the employee's
// own position couldn't be resolved to a state (e.g. offline, GPS still
// warming up, or just outside OSM's coverage). The client treats null as
// "leave the default alone."
router.get("/travel-check", async (req, res) => {
  try {
    const employee_id = req.employee.employee_id;
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: "lat and lng are required numbers" });
    }

    const companyResult = await db.query(
      `SELECT c.shop_state FROM employees e JOIN companies c ON c.id = e.company_id WHERE e.id = $1`,
      [employee_id]
    );
    if (companyResult.rowCount === 0) return res.status(404).json({ error: "Employee not found" });
    const shopState = companyResult.rows[0].shop_state;
    if (!shopState) return res.json({ traveling: null, reason: "shop location not configured" });

    const employeeState = await reverseGeocodeState(lat, lng);
    if (!employeeState) return res.json({ traveling: null, reason: "couldn't resolve current location" });

    res.json({
      traveling: employeeState.toUpperCase() !== shopState.toUpperCase(),
      employee_state: employeeState,
      shop_state: shopState,
    });
  } catch (err) {
    console.error("GET /time-entries/travel-check failed:", err);
    // Non-fatal by design -- a broken auto-detect should never block the
    // clock-in screen from rendering, so this still returns 200/null rather
    // than an error the client would have to specifically ignore.
    res.json({ traveling: null, reason: "lookup failed" });
  }
});

module.exports = router;
