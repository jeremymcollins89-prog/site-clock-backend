-- Flags a submitted time entry as having gone in automatically (the employee
-- didn't submit before payday) rather than by the employee tapping
-- "Submit Hours for Payroll" themselves. Used only for the email wording
-- today; kept as a real column (not inferred) so admin UI can show which
-- timesheets went out unattended if that's ever useful later.
ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS auto_submitted BOOLEAN NOT NULL DEFAULT false;
