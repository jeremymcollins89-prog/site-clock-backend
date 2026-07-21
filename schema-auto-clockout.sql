-- Lets each company set its own auto clock-out cutoff time (previously
-- hardcoded to 4:30pm for everyone). Run this once in Railway's Postgres
-- query box.

ALTER TABLE companies ADD COLUMN auto_clockout_time TIME NOT NULL DEFAULT '16:30:00';
