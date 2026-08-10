const express = require("express");
const router = express.Router();
const db = require("../db");
const requireAuth = require("../middleware/requireAuth");
const { sendPushToAdmin } = require("../utils/webPush");
const { setTyping, isTyping } = require("../utils/typingStore");

router.use(requireAuth);

// GET /api/chat/unread-count
// Lightweight, safe to poll -- does NOT mark anything as read. Used to show
// a badge on the Chat tab without silently clearing it in the background.
router.get("/unread-count", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT COUNT(*)::int AS count FROM chat_messages
       WHERE employee_id = $1 AND sender = 'admin' AND read_by_employee = false`,
      [req.employee.employee_id]
    );
    res.json({ count: result.rows[0].count });
  } catch (err) {
    console.error("GET /chat/unread-count failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load unread count." });
  }
});

// GET /api/chat/messages
// The employee's whole thread with the office. Marks the admin's messages
// as read -- call this when the Chat tab is actually opened, not for
// background polling (use /unread-count for that).
router.get("/messages", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, sender, body, created_at FROM chat_messages WHERE employee_id = $1 ORDER BY created_at`,
      [req.employee.employee_id]
    );
    await db.query(
      `UPDATE chat_messages SET read_by_employee = true WHERE employee_id = $1 AND sender = 'admin' AND read_by_employee = false`,
      [req.employee.employee_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /chat/messages failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load messages." });
  }
});

// POST /api/chat/messages
// Body: { body }. No clock-in requirement -- messaging the office should
// work any time, not just mid-shift.
router.post("/messages", async (req, res) => {
  try {
    const { body } = req.body;
    if (!body || !body.trim()) return res.status(400).json({ error: "Message can't be empty." });

    const employee = await db.query(`SELECT company_id, name FROM employees WHERE id = $1`, [req.employee.employee_id]);
    if (employee.rowCount === 0) return res.status(404).json({ error: "Employee not found" });
    const companyId = employee.rows[0].company_id;

    const result = await db.query(
      `INSERT INTO chat_messages (company_id, employee_id, sender, body, read_by_admin, read_by_employee)
       VALUES ($1, $2, 'employee', $3, false, true)
       RETURNING id, sender, body, created_at`,
      [companyId, req.employee.employee_id, body.trim()]
    );

    sendPushToAdmin(companyId, {
      title: `Message from ${employee.rows[0].name}`,
      body: body.trim().slice(0, 120),
      url: "/admin.html?view=chat",
    }).catch((err) => console.error("Failed to send admin chat push notification:", err.message));

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("POST /chat/messages failed:", err);
    res.status(500).json({ error: err.message || "Couldn't send message." });
  }
});

// POST /api/chat/typing
// Fire-and-forget "I'm typing right now" ping -- the client calls this
// (throttled) while the employee has text in the composer. No body needed;
// it's just a heartbeat keyed to whoever's making the request.
router.post("/typing", (req, res) => {
  setTyping(`direct:${req.employee.employee_id}:employee`, null);
  // A tiny JSON body rather than a bare 204 -- apiFetch always calls
  // res.json() on the response, which throws on a truly empty body.
  res.json({ ok: true });
});

// GET /api/chat/typing
// Is the admin currently typing in this employee's thread? Meant to be
// polled at a much faster interval than /unread-count, but only while the
// Chat tab is actually open -- see the ~2.5s poll in App.jsx's ChatView.
router.get("/typing", (req, res) => {
  res.json({ typing: isTyping(`direct:${req.employee.employee_id}:admin`) });
});

module.exports = router;
