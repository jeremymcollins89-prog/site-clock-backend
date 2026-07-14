-- Time clock schema
-- Follows the POS project's conventions: UUID pks, append-only movement-style
-- tables rather than mutable running totals, derived values via views.

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- for gen_random_uuid()

CREATE TABLE employees (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT NOT NULL,
  email          TEXT NOT NULL,          -- where their own submit confirmations go, optional
  pin_hash       TEXT NOT NULL,          -- bcrypt hash of a short PIN for kiosk-style login
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per shift. clock_out is NULL while the employee is still working.
CREATE TABLE time_entries (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id    UUID NOT NULL REFERENCES employees(id),
  job_name       TEXT NOT NULL,
  location_type  TEXT NOT NULL CHECK (location_type IN ('in_town', 'traveling')),
  clock_in       TIMESTAMPTZ NOT NULL,
  clock_out      TIMESTAMPTZ,
  submitted_at   TIMESTAMPTZ,            -- set when included in a payroll submission
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_time_entries_employee ON time_entries(employee_id);
CREATE INDEX idx_time_entries_open ON time_entries(employee_id) WHERE clock_out IS NULL;

-- One row per break within a shift.
CREATE TABLE time_entry_breaks (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  time_entry_id  UUID NOT NULL REFERENCES time_entries(id) ON DELETE CASCADE,
  break_start    TIMESTAMPTZ NOT NULL,
  break_end      TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_breaks_entry ON time_entry_breaks(time_entry_id);

-- Derived durations, mirroring the invoice_balances pattern: never store
-- computed totals, always derive them from the source rows.
CREATE VIEW time_entry_durations AS
SELECT
  te.id                       AS time_entry_id,
  te.employee_id,
  te.job_name,
  te.location_type,
  te.clock_in,
  te.clock_out,
  te.submitted_at,
  COALESCE(SUM(
    EXTRACT(EPOCH FROM (COALESCE(b.break_end, now()) - b.break_start))
  ), 0)::BIGINT                                              AS break_seconds,
  CASE WHEN te.clock_out IS NULL THEN NULL ELSE
    EXTRACT(EPOCH FROM (te.clock_out - te.clock_in))::BIGINT
    - COALESCE(SUM(
        EXTRACT(EPOCH FROM (COALESCE(b.break_end, te.clock_out) - b.break_start))
      ), 0)::BIGINT
  END                                                         AS worked_seconds
FROM time_entries te
LEFT JOIN time_entry_breaks b ON b.time_entry_id = te.id
GROUP BY te.id;

-- Pay periods are computed in application code (1st-15th, 16th-end of month)
-- rather than stored, since they're a pure function of the date.
