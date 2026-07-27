-- How many hours a shift can run before the admin gets a "still clocked in"
-- push notification (see cron job in server.js + sendPushToAdmin in
-- utils/webPush.js). NULL turns the alert off entirely. Defaults to 10 to
-- match the threshold the Overview tab's "Over Xh -- check in?" badge always
-- used before this was configurable.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS long_shift_alert_hours INTEGER DEFAULT 10;

-- Marks that the long-shift push has already gone out for this specific
-- shift, so the cron job (which re-scans all open shifts periodically)
-- doesn't send a duplicate notification every time it runs. Reset
-- automatically on the next shift, since clock-in always creates a new row.
ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS long_shift_alert_sent BOOLEAN NOT NULL DEFAULT false;
