-- Online invoice payments via Stripe Checkout. stripe_checkout_session_id is
-- set when a customer clicks "Pay now"; stripe_payment_intent_id is filled in
-- once Stripe confirms the payment (via webhook), which is also the only
-- path allowed to set payment_method = 'online' -- it's never a manual
-- option in the "Mark as paid" dropdown, so 'online' reliably means "the
-- customer actually paid through Stripe," not "someone picked this option."

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS stripe_checkout_session_id TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT;

CREATE INDEX IF NOT EXISTS idx_invoices_stripe_checkout_session ON invoices (stripe_checkout_session_id);

-- Widen the existing payment_method check constraint to allow 'online'.
-- Dropping/re-adding under the same name is safe to re-run.
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_payment_method_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_payment_method_check
  CHECK (payment_method IN ('card', 'check', 'cash', 'other', 'online'));
