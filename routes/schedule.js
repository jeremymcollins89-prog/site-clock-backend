const express = require("express");
const router = express.Router();
const db = require("../db");
const requireAuth = require("../middleware/requireAuth");

// GET /api/schedule/me?start=YYYY-MM-DD&end=YYYY-MM-DD
// Returns jobs the logged-in employee is assigned to, overlapping the given
// range. If start/end are omitted, defaults to today through 30 days out --
// this is what the employee app's Schedule view uses.
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
       JOIN job_assignments ja ON ja.job_id = j.id
       LEFT JOIN customers c ON c.id = j.customer_id
       WHERE ja.employee_id = $1 AND j.end_date >= $2 AND j.start_date <= $3
       ORDER BY j.start_date, j.title`,
      [req.employee.employee_id, start, end]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /schedule/me failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load schedule." });
  }
});

module.exports = router;
