-- Job scheduling feature: crews (reusable named groups of employees),
-- scheduled jobs (color-coded, spanning one or more days), per-employee
-- assignments (whether added directly or via a crew), and push notification
-- subscriptions so employees can be notified when they're scheduled.

CREATE TABLE IF NOT EXISTS crews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crew_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  crew_id UUID NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  UNIQUE (crew_id, employee_id)
);

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  notes TEXT,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  color TEXT NOT NULL DEFAULT 'rust',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS job_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  assigned_via_crew_id UUID REFERENCES crews(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, employee_id)
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_jobs_company_dates ON jobs (company_id, start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_job_assignments_employee ON job_assignments (employee_id);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_employee ON push_subscriptions (employee_id);
