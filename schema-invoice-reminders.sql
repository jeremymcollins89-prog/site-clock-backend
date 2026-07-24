-- Automatic reminder emails for unpaid invoices. reminder_count caps at 5
-- (enforced in application code, not a CHECK constraint, since the exact
-- cap may need to change later without a migration). last_reminder_sent_at
-- is what the daily reminder job uses to space reminders out, so it keeps
-- working correctly even if the job misses a day (it just catches up).

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS reminder_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS last_reminder_sent_at TIMESTAMPTZ;
