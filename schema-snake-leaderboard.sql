-- Global Snake leaderboard -- the hidden easter-egg game in the employee app
-- (App.jsx's SnakeGame component, opened by tapping the header logo 7x).
-- Deliberately cross-company: one shared table, one shared leaderboard, so
-- whoever finds it competes against every company on the platform, not just
-- their own coworkers.
--
-- One row per employee holding only their personal best, not a row per game
-- played -- keeps the leaderboard a clean top-N of best scores rather than a
-- firehose of every attempt. employee_name/company_name are snapshotted at
-- save time (not joined live at read time) so the board still reads fine
-- even if an employee is later renamed, deactivated, or removed.

CREATE TABLE IF NOT EXISTS snake_scores (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id    UUID NOT NULL UNIQUE REFERENCES employees(id) ON DELETE CASCADE,
  employee_name  TEXT NOT NULL,
  company_name   TEXT,
  best_score     INTEGER NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_snake_scores_best ON snake_scores (best_score DESC);
