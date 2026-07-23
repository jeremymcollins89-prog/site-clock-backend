const webpush = require("web-push");
const db = require("../db");

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    "mailto:jeremymcollins89@gmail.com",
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
}

// Sends a push notification to every device an employee has subscribed on.
// If a subscription has gone stale (the browser/OS unregistered it -- this
// happens naturally over time, e.g. an app was uninstalled), Web Push
// returns a 404/410 for it, and we clean it up so it stops being retried.
async function sendPushToEmployee(employeeId, { title, body, url }) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    console.error("Push not sent: VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY are not configured");
    return;
  }

  const result = await db.query(
    `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE employee_id = $1`,
    [employeeId]
  );

  const payload = JSON.stringify({ title, body, url: url || "/" });

  await Promise.all(
    result.rows.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          payload
        );
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await db.query(`DELETE FROM push_subscriptions WHERE id = $1`, [sub.id]);
        } else {
          console.error(`Push failed for subscription ${sub.id}:`, err.message);
        }
      }
    })
  );
}

module.exports = { sendPushToEmployee, VAPID_PUBLIC_KEY };
