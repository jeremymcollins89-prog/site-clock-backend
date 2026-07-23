const express = require("express");
const router = express.Router();
const db = require("../db");
const requireAuth = require("../middleware/requireAuth");
const { VAPID_PUBLIC_KEY } = require("../utils/webPush");

// GET /api/push/vapid-public-key
// Public -- the employee app needs this to subscribe to push notifications.
router.get("/vapid-public-key", (req, res) => {
  if (!VAPID_PUBLIC_KEY) {
    return res.status(503).json({ error: "Push notifications aren't configured yet" });
  }
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

// POST /api/push/subscribe
// Body: a PushSubscription object from the browser's Push API
// (endpoint, keys.p256dh, keys.auth). Called once per device.
router.post("/subscribe", requireAuth, async (req, res) => {
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
    return res.status(400).json({ error: "A valid push subscription is required" });
  }

  await db.query(
    `INSERT INTO push_subscriptions (employee_id, endpoint, p256dh, auth)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE SET employee_id = $1, p256dh = $3, auth = $4`,
    [req.employee.employee_id, endpoint, keys.p256dh, keys.auth]
  );
  res.status(201).json({ ok: true });
});

// POST /api/push/unsubscribe
// Body: { endpoint }
router.post("/unsubscribe", requireAuth, async (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) return res.status(400).json({ error: "endpoint is required" });
  await db.query(`DELETE FROM push_subscriptions WHERE endpoint = $1 AND employee_id = $2`, [
    endpoint,
    req.employee.employee_id,
  ]);
  res.json({ ok: true });
});

module.exports = router;
