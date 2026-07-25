-- Direct chat between the company's admin and one employee at a time (one
-- thread per employee -- there's only one admin per company, see
-- companies.admin_email). Employees can only be *sent* a new message while
-- they're clocked in (checked in the route, not here), but history stays
-- visible either direction after they clock out.
CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  sender TEXT NOT NULL CHECK (sender IN ('admin', 'employee')),
  body TEXT NOT NULL,
  read_by_admin BOOLEAN NOT NULL DEFAULT false,
  read_by_employee BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_employee ON chat_messages (employee_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_messages_company ON chat_messages (company_id, created_at);
