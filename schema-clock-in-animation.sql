-- Replaces the old boolean celebrate_clock_in with a per-employee choice of
-- which clock-in animation (if any) plays: 'none', 'fireworks', or
-- 'birthday'. Existing employees who had fireworks turned on keep it.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS clock_in_animation TEXT NOT NULL DEFAULT 'none';
UPDATE employees SET clock_in_animation = 'fireworks' WHERE celebrate_clock_in = true AND clock_in_animation = 'none';
