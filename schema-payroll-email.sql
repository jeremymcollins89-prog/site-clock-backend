-- Lets each company set its own payroll inbox (previously a single global
-- PAYROLL_EMAIL env var shared by every company on the platform — a real
-- problem now that more than one company can sign up). Run this once in
-- Railway's Postgres query box.

ALTER TABLE companies ADD COLUMN payroll_email TEXT;
