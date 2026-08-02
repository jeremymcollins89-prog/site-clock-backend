-- Partial payments: an invoice can optionally be paid in more than one
-- installment (deposit + a few more, up to a hard cap of 4 payments total,
-- enforced in the route handlers). invoice_payments is the ledger of every
-- individual payment against an invoice -- whether it's the one-and-only
-- payment on a normal invoice, or one of several partial ones. It's now the
-- source of truth for "how much has actually been collected, and when" --
-- Reports sums from here instead of from invoices.total, so money shows up
-- in whichever period it actually arrived in rather than all at once.

CREATE TABLE IF NOT EXISTS invoice_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  amount NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('card', 'check', 'cash', 'other', 'online')),
  check_number TEXT,
  stripe_checkout_session_id TEXT,
  stripe_payment_intent_id TEXT,
  paid_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invoice_payments_invoice ON invoice_payments (invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoice_payments_company ON invoice_payments (company_id);

-- Decided when the invoice is created (or while still draft/sent) --
-- whether the customer is allowed to pay this one off in installments
-- instead of all at once. Locked once any payment has been recorded, so a
-- job partway through a payment plan can't have the rules changed under it.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS allow_partial_payments BOOLEAN NOT NULL DEFAULT false;

-- Widen status to add 'partial' -- some money collected, balance still
-- remaining. Sits between 'sent' and 'paid'; inventory isn't consumed and
-- the invoice isn't "paid" for reporting purposes until the balance actually
-- reaches zero (see routes/admin.js and routes/payments.js).
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_status_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_status_check CHECK (status IN ('draft', 'sent', 'partial', 'paid', 'void'));

-- Backfill: one ledger row per invoice that's already fully paid, using the
-- invoice's own existing total/payment_method/paid_at, so historical Reports
-- don't go blank the moment reporting switches over to reading from this
-- table. Guarded so it's safe to run more than once (skips anything that
-- already has a ledger row).
INSERT INTO invoice_payments (company_id, invoice_id, amount, payment_method, check_number, stripe_checkout_session_id, stripe_payment_intent_id, paid_at)
SELECT i.company_id, i.id, i.total, COALESCE(i.payment_method, 'other'), i.check_number, i.stripe_checkout_session_id, i.stripe_payment_intent_id, COALESCE(i.paid_at, i.created_at)
FROM invoices i
WHERE i.status = 'paid'
  AND NOT EXISTS (SELECT 1 FROM invoice_payments ip WHERE ip.invoice_id = i.id);
