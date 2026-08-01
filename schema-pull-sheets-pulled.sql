-- Lets an employee record what they actually grabbed off the shelf for an
-- open pull sheet, distinct from what was originally requested
-- (pull_sheet_items.quantity). Reporting a pulled quantity is purely
-- informational -- it does NOT touch real inventory by itself. Only the
-- admin tapping "Mark fulfilled" actually consumes stock, and it now
-- prefers quantity_pulled (falling back to the originally requested
-- quantity for any item the employee never got to) -- see
-- PATCH /api/admin/pull-sheets/:id/fulfill.
--
-- Adds a 'pulled' status in between 'open' and 'fulfilled': 'open' means
-- nobody's reported anything yet, 'pulled' means an employee submitted
-- quantities and it's waiting on the admin to review and fulfill, and
-- 'fulfilled' is unchanged (inventory already consumed, final).
ALTER TABLE pull_sheet_items ADD COLUMN IF NOT EXISTS quantity_pulled INTEGER;

ALTER TABLE pull_sheets ADD COLUMN IF NOT EXISTS pulled_at TIMESTAMPTZ;
ALTER TABLE pull_sheets ADD COLUMN IF NOT EXISTS pulled_by_employee_id UUID REFERENCES employees(id) ON DELETE SET NULL;

ALTER TABLE pull_sheets DROP CONSTRAINT IF EXISTS pull_sheets_status_check;
ALTER TABLE pull_sheets ADD CONSTRAINT pull_sheets_status_check CHECK (status IN ('open', 'pulled', 'fulfilled'));
