const express = require("express");
const router = express.Router();
const db = require("../db"); // your existing pg Pool, adjust path to match your project
const requireAuth = require("../middleware/requireAuth");

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
    const result = await db.query(
      `UPDATE time_entry_breaks SET break_end = now()
       WHERE time_entry_id = $1 AND break_end IS NULL
       RETURNING *`,
      [id]
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

    // close any dangling open break first
    await db.query(
      `UPDATE time_entry_breaks SET break_end = now()
       WHERE time_entry_id = $1 AND break_end IS NULL`,
      [id]
    );

    const result = await db.query(
      `UPDATE time_entries SET clock_out = now()
       WHERE id = $1 AND clock_out IS NULL
       RETURNING *`,
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "No open shift with that id" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error("POST /time-entries/:id/clock-out failed:", err);
    res.status(500).json({ error: "Couldn't clock out. Please try again." });
  }
});

// GET /api/time-entries?start=&end=
router.get("/", async (req, res) => {
  try {
    const employee_id = req.employee.employee_id;
    const { start, end } = req.query;
    const conditions = [`employee_id = $1`];
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

module.exports = router;
