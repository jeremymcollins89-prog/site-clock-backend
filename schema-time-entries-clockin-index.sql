-- Reports (summary, labor breakdown, monthly profit, the admin time-entries
-- list) all filter time_entries by employee_id + a clock_in date range.
-- There was only an index on employee_id alone, so those range filters had
-- to scan every row for the employee instead of seeking straight to the
-- range. Composite index covers both at once.
CREATE INDEX IF NOT EXISTS idx_time_entries_employee_clockin ON time_entries (employee_id, clock_in);
