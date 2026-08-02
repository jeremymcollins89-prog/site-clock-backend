-- Optional business/company name on a customer record, separate from the
-- contact's own name -- e.g. name = "John Smith", company_name = "Smith
-- Roofing LLC". Shown on the customer form, the customer list, and on
-- invoice/quote PDFs under the contact name.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS company_name TEXT;
