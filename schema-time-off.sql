-- Employee-submitted time-off requests, reviewed by the company's admin.
-- A request starts 'pending'. Approving it inserts a matching row into
-- `jobs` (event_type 'time_off', color 'yellow' -- see jobColors.js) so it
-- shows up on the shared calendar the same way any other event does;
-- job_id links back here so later deleting that calendar event doesn't
-- orphan the request's own history. Denying or the employee cancelling
-- a still-pending request never touches `jobs` at all.
CREATE TABLE IF NOT EXISTS time_off_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'cancelled')),
  job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_time_off_requests_company ON time_off_requests (company_id, status);
CREATE INDEX IF NOT EXISTS idx_time_off_requests_employee ON time_off_requests (employee_id);

-- jobs.event_type was CHECK-constrained to ('job','personal','other') --
-- widen it to also allow 'time_off' for the auto-created calendar event
-- (and for an admin manually blocking out time off the same way, without
-- going through a request at all).
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_event_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_event_type_check CHECK (event_type IN ('job', 'personal', 'other', 'time_off'));
