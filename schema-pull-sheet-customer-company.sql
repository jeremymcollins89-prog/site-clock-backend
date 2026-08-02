-- Snapshotted alongside the existing customer_name column, same reasoning:
-- captured at build time so the pull sheet still reads sensibly if the
-- customer's company name is later changed or the source quote/invoice is
-- deleted. Lets the pull sheet (list, detail view, PDF) show the company
-- name first, same treatment as invoices/quotes.
ALTER TABLE pull_sheets ADD COLUMN IF NOT EXISTS customer_company_name TEXT;
