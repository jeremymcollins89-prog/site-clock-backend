-- Adds "forgot password" (admin) and "forgot PIN" (employee) support.
-- Run this once in Railway's Postgres query box.

ALTER TABLE companies ADD COLUMN reset_token_hash TEXT;
ALTER TABLE companies ADD COLUMN reset_token_expires TIMESTAMPTZ;

ALTER TABLE employees ADD COLUMN reset_token_hash TEXT;
ALTER TABLE employees ADD COLUMN reset_token_expires TIMESTAMPTZ;
