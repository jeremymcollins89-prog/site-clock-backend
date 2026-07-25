-- Per-employee toggle: when true, the employee app plays a short fireworks
-- animation after that employee successfully clocks in. Off by default for
-- everyone; turned on per-person from the admin app's Edit employee modal.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS celebrate_clock_in BOOLEAN NOT NULL DEFAULT false;
