-- Optional check number captured when an invoice is marked paid by check
-- (see PATCH /api/admin/invoices/:id/mark-paid). Nullable since it's only
-- ever set when payment_method = 'check', and even then it's optional --
-- some admins won't have the check in hand when they mark it paid.

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS check_number TEXT;
