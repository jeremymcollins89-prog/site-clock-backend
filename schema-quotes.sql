-- Quotes (estimates) feature: same shape as invoices (line items, sequential
-- per-company numbering, PDF + email) but for work that hasn't been booked
-- yet. A quote can be converted into a scheduled job and/or an invoice once
-- the customer accepts -- converted_job_id/converted_invoice_id record where
-- it ended up, and invoices.quote_id (added below) records the reverse link
-- so an invoice created from a quote can show "from Quote #12".
--
-- Status is a simple draft -> sent -> accepted/declined flow. There's no
-- "expired" status stored -- like invoices' is_overdue, it's derived at query
-- time from expiration_date < today AND status = 'sent'.

CREATE TABLE IF NOT EXISTS quotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  quote_number INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'accepted', 'declined')),
  issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
  expiration_date DATE,
  notes TEXT,
  subtotal NUMERIC(10,2) NOT NULL DEFAULT 0,
  tax_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  total NUMERIC(10,2) NOT NULL DEFAULT 0,
  sent_at TIMESTAMPTZ,
  converted_job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
  converted_invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, quote_number)
);

CREATE TABLE IF NOT EXISTS quote_line_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id UUID NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  quantity NUMERIC(10,2) NOT NULL DEFAULT 1,
  unit_price NUMERIC(10,2) NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_quotes_company ON quotes (company_id);
CREATE INDEX IF NOT EXISTS idx_quotes_customer ON quotes (customer_id);
CREATE INDEX IF NOT EXISTS idx_quote_line_items_quote ON quote_line_items (quote_id);

-- Reverse link so an invoice created from a quote can say "converted from
-- Quote #N" -- mirrors invoices.job_id, which links an invoice back to the
-- job it was billed for.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS quote_id UUID REFERENCES quotes(id) ON DELETE SET NULL;
