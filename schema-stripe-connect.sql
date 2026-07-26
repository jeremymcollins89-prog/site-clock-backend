-- Stripe Connect (Standard accounts). Each company connects its own Stripe
-- account so its customers' invoice payments land directly in that
-- company's bank account, not Jeremy's. stripe_account_id is Stripe's
-- "acct_..." id for that connected account, set once the company completes
-- Stripe's OAuth onboarding (see routes/connect.js). stripe_connect_status
-- is a simple human-readable flag for the admin UI -- 'connected' or NULL
-- (never connected).

ALTER TABLE companies ADD COLUMN IF NOT EXISTS stripe_account_id TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS stripe_connect_status TEXT;

CREATE INDEX IF NOT EXISTS idx_companies_stripe_account ON companies (stripe_account_id);
