-- Tracks the last time anyone at a company actually used the app in any
-- capacity (admin login/session or employee login/session), not just
-- clock-ins. Bumped by middleware/requireAdmin.js and middleware/requireAuth.js
-- on every authenticated request, throttled to once per hour per company so
-- it doesn't turn into a write-on-every-request situation. The platform
-- dashboard's "last used" / dormant-days figure (routes/platform.js) takes
-- the more recent of this and the last employee clock-in.

ALTER TABLE companies ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ;
