-- Pay period was hardcoded to semi-monthly (1st-15th, 16th-end of month) for
-- every company. This makes it configurable per company: semi_monthly,
-- biweekly, weekly, monthly, or a custom number of days -- with an anchor
-- date for the frequencies that need one to know where a period starts.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS pay_frequency TEXT NOT NULL DEFAULT 'semi_monthly';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS pay_period_anchor DATE;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS pay_period_custom_days INTEGER;
