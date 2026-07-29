-- Lets an admin turn off the Gross/Net Profit bubbles on the Overview tab's
-- home screen (Settings tab toggle) if they'd rather not see profit figures
-- there. Defaults to on (true) so existing companies keep seeing the bubbles
-- they already had, matching the "add a feature, don't silently break what's
-- there" pattern used for other settings in this file set.

ALTER TABLE companies ADD COLUMN IF NOT EXISTS show_profit_bubbles BOOLEAN NOT NULL DEFAULT true;
