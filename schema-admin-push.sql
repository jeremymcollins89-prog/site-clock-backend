-- Push subscriptions for the admin side of chat -- mirrors push_subscriptions
-- (which is per-employee), but keyed by company_id since there's one admin
-- login per company. Lets the mobile admin web page get a real phone
-- notification for a new employee chat message even when it isn't open,
-- the same way the employee app already does for schedule alerts.
CREATE TABLE IF NOT EXISTS admin_push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_push_subscriptions_company ON admin_push_subscriptions (company_id);
