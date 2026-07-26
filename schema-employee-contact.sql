-- Adds contact info (phone + address) to employees, so the admin apps can
-- show a clickable contact card (call/email/directions) on each employee --
-- mirrors the same street/city/state/zip split already used for customers.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS street TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS state TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS zip TEXT;
