-- How long this employee's break is meant to be, in minutes. Used by the
-- employee app to show a "5 minutes left" reminder near the end of a break
-- (e.g. at the 25-minute mark for a 30-minute break, the 55-minute mark for
-- a 60-minute break). Set per employee by the admin, since break length can
-- vary by role/schedule. Defaults to 30 for existing employees.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS break_minutes INTEGER NOT NULL DEFAULT 30;
