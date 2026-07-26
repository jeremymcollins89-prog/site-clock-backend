-- Supports Gross Profit / Net Profit on the Reports tab.
--
-- hourly_rate on employees: what each employee is paid per hour, so labor
-- cost for a date range can be computed as worked_seconds/3600 * hourly_rate
-- from the time entries already being tracked. Nullable -- an employee with
-- no rate set contributes $0 labor cost until someone fills it in.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS hourly_rate NUMERIC(10,2);

-- expenses: simple manually-logged business costs (materials, insurance,
-- rent, etc.) that get subtracted from Gross Profit to produce Net Profit.
-- Deliberately minimal -- just a date, an amount, and an optional note --
-- since this is meant for quick logging, not full bookkeeping.
CREATE TABLE IF NOT EXISTS expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  expense_date DATE NOT NULL,
  amount NUMERIC(10,2) NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_expenses_company ON expenses (company_id);
CREATE INDEX IF NOT EXISTS idx_expenses_company_date ON expenses (company_id, expense_date);
