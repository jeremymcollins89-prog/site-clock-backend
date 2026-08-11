-- Optional assignment of a solo/manual pull sheet to a specific employee.
-- This does NOT restrict visibility (every employee can still see every open
-- pull sheet, per the existing company-wide-visibility design in
-- schedule.js) -- it only drives a targeted push notification and an
-- "assigned to you" display badge so the intended puller knows to act.
ALTER TABLE pull_sheets ADD COLUMN IF NOT EXISTS assigned_employee_id UUID REFERENCES employees(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_pull_sheets_assigned_employee ON pull_sheets (assigned_employee_id);
