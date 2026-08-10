const express = require("express");
const router = express.Router();
const db = require("../db");
const requireAuth = require("../middleware/requireAuth");
const { sendPushToEmployee, sendPushToAdmin } = require("../utils/webPush");
const { setTyping, typingLabelsWithPrefix } = require("../utils/typingStore");

router.use(requireAuth);

// GET /api/team-chat/coworkers
// Other active employees at the same company, for starting a new DM or group.
// Deliberately does NOT include the admin -- messaging the admin still goes
// through the existing dedicated /api/chat channel, not a team-chat thread
// an employee creates themselves.
router.get("/coworkers", async (req, res) => {
  try {
    const me = await db.query(`SELECT company_id FROM employees WHERE id = $1`, [req.employee.employee_id]);
    if (me.rowCount === 0) return res.status(404).json({ error: "Employee not found" });
    const result = await db.query(
      `SELECT id, name FROM employees WHERE company_id = $1 AND active = true AND id != $2 ORDER BY name`,
      [me.rows[0].company_id, req.employee.employee_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /team-chat/coworkers failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load coworkers." });
  }
});

// GET /api/team-chat/unread-count
// Lightweight, safe to poll -- does NOT mark anything as read. Uses IS
// DISTINCT FROM (not !=) so that admin-sent messages, whose
// sender_employee_id is NULL, still count as "not mine" instead of being
// silently excluded by a plain NULL comparison.
router.get("/unread-count", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT COUNT(*)::int AS count
       FROM employee_chat_messages m
       JOIN employee_chat_participants p ON p.thread_id = m.thread_id AND p.employee_id = $1
       WHERE m.sender_employee_id IS DISTINCT FROM $1
         AND (p.last_read_at IS NULL OR m.created_at > p.last_read_at)`,
      [req.employee.employee_id]
    );
    res.json({ count: result.rows[0].count });
  } catch (err) {
    console.error("GET /team-chat/unread-count failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load unread count." });
  }
});

// GET /api/team-chat/threads
// Every thread (DM or group) this employee belongs to, with the other
// participant(s) -- including a labeled "Admin" entry if the admin is in the
// thread -- a preview of the last message, and a per-thread unread count.
router.get("/threads", async (req, res) => {
  try {
    const me = await db.query(`SELECT company_id FROM employees WHERE id = $1`, [req.employee.employee_id]);
    if (me.rowCount === 0) return res.status(404).json({ error: "Employee not found" });
    const companyId = me.rows[0].company_id;

    const result = await db.query(
      `SELECT t.id, t.is_group, t.name,
         (SELECT json_agg(x ORDER BY x.name) FROM (
            SELECT e.id::text AS id, e.name AS name
              FROM employee_chat_participants p2
              JOIN employees e ON e.id = p2.employee_id
             WHERE p2.thread_id = t.id AND p2.employee_id IS NOT NULL AND p2.employee_id != $1
            UNION ALL
            SELECT 'admin' AS id, 'Admin' AS name
              FROM employee_chat_participants p3
             WHERE p3.thread_id = t.id AND p3.is_admin = true
          ) x) AS other_participants,
         (SELECT json_build_object('body', m.body, 'created_at', m.created_at, 'sender_employee_id', m.sender_employee_id, 'sender_is_admin', m.sender_is_admin)
            FROM employee_chat_messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,
         (SELECT COUNT(*)::int FROM employee_chat_messages m
            WHERE m.thread_id = t.id AND m.sender_employee_id IS DISTINCT FROM $1
              AND (p.last_read_at IS NULL OR m.created_at > p.last_read_at)) AS unread_count
       FROM employee_chat_threads t
       JOIN employee_chat_participants p ON p.thread_id = t.id AND p.employee_id = $1
       WHERE t.company_id = $2
       ORDER BY COALESCE((SELECT MAX(created_at) FROM employee_chat_messages m2 WHERE m2.thread_id = t.id), t.created_at) DESC`,
      [req.employee.employee_id, companyId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /team-chat/threads failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load chats." });
  }
});

// POST /api/team-chat/threads
// Body: { employee_ids: [uuid, ...], name? }. One id = a 1:1 DM (reuses an
// existing thread between the same two people if one exists); 2+ ids = a
// new group chat, optionally named. Only ever includes other employees --
// not the admin (see /coworkers comment above).
router.post("/threads", async (req, res) => {
  try {
    const { employee_ids, name } = req.body;
    if (!Array.isArray(employee_ids) || employee_ids.length === 0) {
      return res.status(400).json({ error: "Select at least one coworker." });
    }

    const me = await db.query(`SELECT company_id FROM employees WHERE id = $1`, [req.employee.employee_id]);
    if (me.rowCount === 0) return res.status(404).json({ error: "Employee not found" });
    const companyId = me.rows[0].company_id;

    const uniqueIds = [...new Set(employee_ids)].filter((id) => id !== req.employee.employee_id);
    if (uniqueIds.length === 0) return res.status(400).json({ error: "Select at least one coworker." });

    const validCheck = await db.query(
      `SELECT id FROM employees WHERE company_id = $1 AND id = ANY($2::uuid[])`,
      [companyId, uniqueIds]
    );
    if (validCheck.rowCount !== uniqueIds.length) {
      return res.status(400).json({ error: "One or more selected coworkers weren't found." });
    }

    const isGroup = uniqueIds.length > 1;

    if (!isGroup) {
      const existing = await db.query(
        `SELECT t.id FROM employee_chat_threads t
         WHERE t.company_id = $1 AND t.is_group = false
           AND (SELECT COUNT(*) FROM employee_chat_participants p WHERE p.thread_id = t.id) = 2
           AND EXISTS (SELECT 1 FROM employee_chat_participants p WHERE p.thread_id = t.id AND p.employee_id = $2)
           AND EXISTS (SELECT 1 FROM employee_chat_participants p WHERE p.thread_id = t.id AND p.employee_id = $3)`,
        [companyId, req.employee.employee_id, uniqueIds[0]]
      );
      if (existing.rowCount > 0) {
        return res.status(200).json({ id: existing.rows[0].id, existing: true });
      }
    }

    const threadResult = await db.query(
      `INSERT INTO employee_chat_threads (company_id, is_group, name, created_by_employee_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [companyId, isGroup, isGroup ? (name || null) : null, req.employee.employee_id]
    );
    const threadId = threadResult.rows[0].id;

    const allParticipantIds = [req.employee.employee_id, ...uniqueIds];
    const values = [];
    const placeholders = allParticipantIds
      .map((empId) => {
        values.push(threadId, empId);
        return `($${values.length - 1}, $${values.length})`;
      })
      .join(", ");
    await db.query(`INSERT INTO employee_chat_participants (thread_id, employee_id) VALUES ${placeholders}`, values);

    res.status(201).json({ id: threadId, existing: false });
  } catch (err) {
    console.error("POST /team-chat/threads failed:", err);
    res.status(500).json({ error: err.message || "Couldn't start chat." });
  }
});

// GET /api/team-chat/threads/:id/messages
// Marks the thread read for this employee -- call when the thread is
// actually opened, not for background polling (use /unread-count for that).
router.get("/threads/:id/messages", async (req, res) => {
  try {
    const { id } = req.params;
    const participant = await db.query(
      `SELECT 1 FROM employee_chat_participants WHERE thread_id = $1 AND employee_id = $2`,
      [id, req.employee.employee_id]
    );
    if (participant.rowCount === 0) return res.status(404).json({ error: "Chat not found" });

    const result = await db.query(
      `SELECT m.id, m.sender_employee_id, m.sender_is_admin,
              CASE WHEN m.sender_is_admin THEN 'Admin' ELSE e.name END AS sender_name,
              m.body, m.created_at
       FROM employee_chat_messages m
       LEFT JOIN employees e ON e.id = m.sender_employee_id
       WHERE m.thread_id = $1 ORDER BY m.created_at`,
      [id]
    );
    await db.query(
      `UPDATE employee_chat_participants SET last_read_at = now() WHERE thread_id = $1 AND employee_id = $2`,
      [id, req.employee.employee_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /team-chat/threads/:id/messages failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load messages." });
  }
});

// POST /api/team-chat/threads/:id/messages
// Body: { body }. No clock-in requirement -- team chat works any time, same
// as the admin side of this same route in routes/admin.js.
router.post("/threads/:id/messages", async (req, res) => {
  try {
    const { id } = req.params;
    const { body } = req.body;
    if (!body || !body.trim()) return res.status(400).json({ error: "Message can't be empty." });

    const participant = await db.query(
      `SELECT 1 FROM employee_chat_participants WHERE thread_id = $1 AND employee_id = $2`,
      [id, req.employee.employee_id]
    );
    if (participant.rowCount === 0) return res.status(404).json({ error: "Chat not found" });

    const me = await db.query(`SELECT name, company_id FROM employees WHERE id = $1`, [req.employee.employee_id]);
    const senderName = me.rows[0]?.name || "A coworker";
    const companyId = me.rows[0]?.company_id;

    const result = await db.query(
      `INSERT INTO employee_chat_messages (thread_id, sender_employee_id, body) VALUES ($1, $2, $3)
       RETURNING id, sender_employee_id, sender_is_admin, body, created_at`,
      [id, req.employee.employee_id, body.trim()]
    );

    // So the sender's own message never counts toward their own unread badge.
    await db.query(
      `UPDATE employee_chat_participants SET last_read_at = now() WHERE thread_id = $1 AND employee_id = $2`,
      [id, req.employee.employee_id]
    );

    const otherEmployees = await db.query(
      `SELECT employee_id FROM employee_chat_participants
       WHERE thread_id = $1 AND employee_id IS NOT NULL AND employee_id != $2`,
      [id, req.employee.employee_id]
    );
    const adminParticipant = await db.query(
      `SELECT 1 FROM employee_chat_participants WHERE thread_id = $1 AND is_admin = true`,
      [id]
    );
    const thread = await db.query(`SELECT is_group, name FROM employee_chat_threads WHERE id = $1`, [id]);
    const title = thread.rows[0]?.is_group
      ? `${senderName} in ${thread.rows[0].name || "group chat"}`
      : `Message from ${senderName}`;

    otherEmployees.rows.forEach((row) => {
      sendPushToEmployee(row.employee_id, {
        title,
        body: body.trim().slice(0, 120),
        url: "/team",
      }).catch((err) => console.error("Failed to send team chat push notification:", err.message));
    });
    if (adminParticipant.rowCount > 0 && companyId) {
      sendPushToAdmin(companyId, {
        title,
        body: body.trim().slice(0, 120),
        url: "/admin.html?view=team-chat",
      }).catch((err) => console.error("Failed to send team chat admin push notification:", err.message));
    }

    res.status(201).json({ ...result.rows[0], sender_name: senderName });
  } catch (err) {
    console.error("POST /team-chat/threads/:id/messages failed:", err);
    res.status(500).json({ error: err.message || "Couldn't send message." });
  }
});

// POST /api/team-chat/threads/:id/typing
// Fire-and-forget "I'm typing right now" ping, throttled client-side.
router.post("/threads/:id/typing", async (req, res) => {
  try {
    const { id } = req.params;
    const participant = await db.query(
      `SELECT 1 FROM employee_chat_participants WHERE thread_id = $1 AND employee_id = $2`,
      [id, req.employee.employee_id]
    );
    if (participant.rowCount === 0) return res.status(404).json({ error: "Chat not found" });

    const me = await db.query(`SELECT name FROM employees WHERE id = $1`, [req.employee.employee_id]);
    setTyping(`team:${id}:emp:${req.employee.employee_id}`, me.rows[0]?.name || "Someone");
    // A tiny JSON body rather than a bare 204 -- apiFetch always calls
    // res.json() on the response, which throws on a truly empty body.
    res.json({ ok: true });
  } catch (err) {
    console.error("POST /team-chat/threads/:id/typing failed:", err);
    res.status(500).json({ error: err.message || "Couldn't update typing status." });
  }
});

// GET /api/team-chat/threads/:id/typing
// Names of everyone else currently typing in this thread (empty array if
// nobody is). A group thread can have more than one person typing at once,
// unlike the Direct channel's simple boolean.
router.get("/threads/:id/typing", async (req, res) => {
  try {
    const { id } = req.params;
    const participant = await db.query(
      `SELECT 1 FROM employee_chat_participants WHERE thread_id = $1 AND employee_id = $2`,
      [id, req.employee.employee_id]
    );
    if (participant.rowCount === 0) return res.status(404).json({ error: "Chat not found" });

    const typingNames = typingLabelsWithPrefix(`team:${id}:`, `team:${id}:emp:${req.employee.employee_id}`);
    res.json({ typingNames });
  } catch (err) {
    console.error("GET /team-chat/threads/:id/typing failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load typing status." });
  }
});

module.exports = router;
