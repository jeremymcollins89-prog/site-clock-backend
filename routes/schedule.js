const express = require("express");
const router = express.Router();
const db = require("../db");
const requireAuth = require("../middleware/requireAuth");
const { sendPushToAdmin } = require("../utils/webPush");

// GET /api/schedule/me?start=YYYY-MM-DD&end=YYYY-MM-DD
// Returns every job for the logged-in employee's company (not just ones
// they're personally assigned to), overlapping the given range, so everyone
// can see the full shared calendar. If start/end are omitted, defaults to
// today through 30 days out -- this is what the employee app's Schedule
// view uses. Push notifications for new/updated jobs still only go to the
// employees actually assigned to that job (see notifyAssigned in admin.js) --
// this broader visibility is just for the calendar view itself.
router.get("/me", requireAuth, async (req, res) => {
  try {
    let { start, end } = req.query;
    if (!start) {
      start = new Date().toISOString().slice(0, 10);
    }
    if (!end) {
      const d = new Date();
      d.setDate(d.getDate() + 30);
      end = d.toISOString().slice(0, 10);
    }

    const result = await db.query(
      `SELECT j.id, j.title, j.notes, j.start_date, j.end_date, j.start_time, j.color, j.event_type,
              c.name AS customer_name, c.phone AS customer_phone,
              c.street AS customer_street, c.city AS customer_city, c.state AS customer_state, c.zip AS customer_zip
       FROM jobs j
       JOIN employees e ON e.company_id = j.company_id
       LEFT JOIN customers c ON c.id = j.customer_id
       WHERE e.id = $1 AND j.end_date >= $2 AND j.start_date <= $3
       ORDER BY j.start_date, j.title`,
      [req.employee.employee_id, start, end]
    );

    // Opening the Schedule tab is what clears the "new assignment" badge --
    // mark every one of this employee's assignments as seen, independent of
    // the date range above (which only bounds what's shown, not what's
    // "theirs").
    await db.query(
      `UPDATE job_assignments SET seen_by_employee = true WHERE employee_id = $1 AND seen_by_employee = false`,
      [req.employee.employee_id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("GET /schedule/me failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load schedule." });
  }
});

// GET /api/schedule/unseen-count
// Lightweight, safe to poll -- does NOT mark anything as seen. Used to show
// a badge on the Schedule tab without silently clearing it in the
// background before the employee actually looks at it.
router.get("/unseen-count", requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT COUNT(*)::int AS count FROM job_assignments WHERE employee_id = $1 AND seen_by_employee = false`,
      [req.employee.employee_id]
    );
    res.json({ count: result.rows[0].count });
  } catch (err) {
    console.error("GET /schedule/unseen-count failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load unseen count." });
  }
});

// GET /api/schedule/customers
// Read-only customer directory for the logged-in employee's company --
// employees can look someone up (name/phone/email/address) but can't
// add, edit, or delete customers; that stays admin-only.
router.get("/customers", requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT c.id, c.name, c.phone, c.email, c.street, c.city, c.state, c.zip, c.notes
       FROM customers c
       JOIN employees e ON e.company_id = c.company_id
       WHERE e.id = $1
       ORDER BY c.name`,
      [req.employee.employee_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /schedule/customers failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load customers." });
  }
});

// ---------- Time off requests ----------
// An employee proposes a date range (a single day, a week, whatever) with
// an optional note explaining why, and it sits 'pending' until the admin
// approves or denies it (see PATCH /api/admin/time-off-requests/:id). Only
// once approved does it become a real calendar event -- these routes never
// touch `jobs` themselves.

// POST /api/schedule/time-off
// Body: { start_date, end_date, note? }
router.post("/time-off", requireAuth, async (req, res) => {
  try {
    const { start_date, end_date, note } = req.body;
    if (!start_date || !end_date) {
      return res.status(400).json({ error: "start_date and end_date are required" });
    }
    if (end_date < start_date) {
      return res.status(400).json({ error: "end_date can't be before start_date" });
    }

    const employeeResult = await db.query(
      `SELECT company_id, name FROM employees WHERE id = $1`,
      [req.employee.employee_id]
    );
    if (employeeResult.rowCount === 0) return res.status(404).json({ error: "Employee not found" });
    const { company_id: companyId, name: employeeName } = employeeResult.rows[0];

    const result = await db.query(
      `INSERT INTO time_off_requests (company_id, employee_id, start_date, end_date, note)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, employee_id, start_date, end_date, note, status, job_id, reviewed_at, created_at`,
      [companyId, req.employee.employee_id, start_date, end_date, note || null]
    );

    const dateRange = start_date === end_date ? start_date : `${start_date} to ${end_date}`;
    sendPushToAdmin(companyId, {
      title: "New time off request",
      body: `${employeeName} requested ${dateRange}${note ? ` — "${note}"` : ""}`,
      url: "/admin.html?tab=schedule",
    }).catch((err) => console.error("Failed to send time-off request notification:", err.message));

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("POST /schedule/time-off failed:", err);
    res.status(500).json({ error: err.message || "Couldn't submit time off request." });
  }
});

// GET /api/schedule/time-off
// Every request this employee has ever submitted, newest first, so they
// can see what's pending/approved/denied without asking the admin.
router.get("/time-off", requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, start_date, end_date, note, status, job_id, reviewed_at, created_at
       FROM time_off_requests
       WHERE employee_id = $1
       ORDER BY created_at DESC`,
      [req.employee.employee_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /schedule/time-off failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load time off requests." });
  }
});

// DELETE /api/schedule/time-off/:id
// Lets an employee withdraw their own request, but only while it's still
// 'pending' -- once an admin has approved or denied it, it's final.
router.delete("/time-off/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      `UPDATE time_off_requests SET status = 'cancelled'
       WHERE id = $1 AND employee_id = $2 AND status = 'pending'
       RETURNING id`,
      [id, req.employee.employee_id]
    );
    if (result.rowCount === 0) {
      return res.status(400).json({ error: "Request not found, or it's already been reviewed." });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /schedule/time-off/:id failed:", err);
    res.status(500).json({ error: err.message || "Couldn't cancel request." });
  }
});

module.exports = router;
