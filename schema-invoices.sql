-- Invoicing feature: invoices with line items, tied to a customer and
-- optionally the scheduled job they came from. invoice_number is sequential
-- per company (each company's invoices start at 1, independent of every
-- other company on the platform) -- enforced with a per-company advisory
-- lock in the route handler so two invoices created at the same instant
-- can't collide on the same number.
--
-- "Overdue" is intentionally not a stored status -- it's derived at query
-- time from due_date < today AND status = 'sent', so there's no cron job
-- needed to keep it in sync.

CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
  invoice_number INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'paid', 'void')),
  payment_terms TEXT NOT NULL DEFAULT 'due_on_receipt'
    CHECK (payment_terms IN ('due_on_receipt', 'net_15', 'net_30', 'net_60', 'net_90')),
  payment_method TEXT CHECK (payment_method IN ('card', 'check', 'cash', 'other')),
  issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date DATE NOT NULL,
  notes TEXT,
  subtotal NUMERIC(10,2) NOT NULL DEFAULT 0,
  tax_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  total NUMERIC(10,2) NOT NULL DEFAULT 0,
  sent_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, invoice_number)
);

CREATE TABLE IF NOT EXISTS invoice_line_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  quantity NUMERIC(10,2) NOT NULL DEFAULT 1,
  unit_price NUMERIC(10,2) NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_invoices_company ON invoices (company_id);
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices (customer_id);
CREATE INDEX IF NOT EXISTS idx_invoice_line_items_invoice ON invoice_line_items (invoice_id);
