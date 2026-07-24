-- Per-company IANA timezone (e.g. "America/Denver", "America/New_York"),
-- used to decide *when* automated emails go out for that company (right
-- now: invoice reminders) so a company isn't stuck on Colorado's clock.
-- Defaults to America/Denver so existing behavior for the original company
-- doesn't change; every other company should set their own in Settings.

ALTER TABLE companies ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'America/Denver';
