CREATE TABLE companies (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL,
  admin_email       TEXT NOT NULL UNIQUE,
  admin_password_hash TEXT NOT NULL,
  shop_lat          DOUBLE PRECISION,
  shop_lng          DOUBLE PRECISION,
  shop_radius_m     DOUBLE PRECISION NOT NULL DEFAULT 152,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE employees ADD COLUMN company_id UUID REFERENCES companies(id);
ALTER TABLE employees ADD CONSTRAINT employees_email_unique UNIQUE (email);

-- Existing data belongs to your business — create your company row and
-- attach your current employees to it. Run this AFTER the signup step
-- below creates your company, then update the UUID here to match.
-- UPDATE employees SET company_id = 'YOUR-NEW-COMPANY-UUID' WHERE company_id IS NULL;