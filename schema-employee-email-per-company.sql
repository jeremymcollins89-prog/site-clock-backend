-- Employee emails were globally unique across ALL companies, which meant
-- two different companies could never both have an employee with the same
-- email address -- a real problem for a multi-tenant product. This migration
-- finds whatever the existing global unique constraint on employees.email is
-- named, drops it, and replaces it with a unique constraint scoped to
-- (company_id, email) instead, so emails only need to be unique within a
-- single company's roster.

DO $$
DECLARE
  existing_constraint text;
BEGIN
  SELECT tc.constraint_name INTO existing_constraint
  FROM information_schema.table_constraints tc
  JOIN information_schema.constraint_column_usage ccu
    ON tc.constraint_name = ccu.constraint_name
   AND tc.table_schema = ccu.table_schema
  WHERE tc.table_name = 'employees'
    AND tc.constraint_type = 'UNIQUE'
    AND ccu.column_name = 'email'
    AND ccu.table_name = 'employees';

  IF existing_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE employees DROP CONSTRAINT %I', existing_constraint);
  END IF;
END $$;

ALTER TABLE employees ADD CONSTRAINT employees_company_id_email_key UNIQUE (company_id, email);
