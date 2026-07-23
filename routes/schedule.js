const express = require("express");
const router = express.Router();
const db = require("../db");
const requireAuth = require("../middleware/requireAuth");

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
      `SELECT j.id, j.title, j.notes, j.start_date, j.end_date, j.color, j.event_type,
              c.name AS customer_name, c.phone AS customer_phone,
              c.street AS customer_street, c.city AS customer_city, c.state AS customer_state, c.zip AS customer_zip
       FROM jobs j
       JOIN employees e ON e.company_id = j.company_id
       LEFT JOIN customers c ON c.id = j.customer_id
       WHERE e.id = $1 AND j.end_date >= $2 AND j.start_date <= $3
       ORDER BY j.start_date, j.title`,
      [req.employee.employee_id, start, end]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /schedule/me failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load schedule." });
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

module.exports = router;
