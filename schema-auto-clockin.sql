-- Lets each company set an earliest time of day auto clock-in is allowed to
-- fire (mirrors the existing auto_clockout_time cutoff). Defaults to
-- midnight, which means "no restriction" -- auto clock-in behaves exactly
-- like it did before this column existed until an admin sets a real value.
-- Run this once in Railway's Postgres query box.

ALTER TABLE companies ADD COLUMN auto_clockin_time TIME NOT NULL DEFAULT '00:00:00';
