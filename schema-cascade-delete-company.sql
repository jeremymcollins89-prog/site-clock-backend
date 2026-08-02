-- Lets a whole company account actually be deleted from the platform app.
-- Four foreign keys were created without an ON DELETE rule, which defaults
-- to "block the delete" -- so today, DELETE FROM companies would error out
-- the instant it hit any company that has employees (i.e. every real one).
-- This widens just those four to CASCADE. Nothing about day-to-day behavior
-- changes -- this only matters when a company or employee is actually being
-- deleted, which normally never happens outside this new feature.

ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_company_id_fkey;
ALTER TABLE employees ADD CONSTRAINT employees_company_id_fkey
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE time_entries DROP CONSTRAINT IF EXISTS time_entries_employee_id_fkey;
ALTER TABLE time_entries ADD CONSTRAINT time_entries_employee_id_fkey
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE;

ALTER TABLE employee_locations DROP CONSTRAINT IF EXISTS employee_locations_employee_id_fkey;
ALTER TABLE employee_locations ADD CONSTRAINT employee_locations_employee_id_fkey
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE;

ALTER TABLE ping_requests DROP CONSTRAINT IF EXISTS ping_requests_employee_id_fkey;
ALTER TABLE ping_requests ADD CONSTRAINT ping_requests_employee_id_fkey
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE;
