-- A company's saved "default pull sheet format" -- the reusable item list
-- (names, catalog links, section groupings, and order) that both "Start
-- from my format" and the format editor operate on. One row per company
-- (company_id UNIQUE): there's only ever a single default format at a time,
-- and editing it replaces its items rather than creating a new format row
-- each time it's saved.
--
-- This is deliberately just structure -- no quantities. Quantities are
-- filled in fresh each time an actual pull sheet is built from the format
-- (see pull_sheets/pull_sheet_items), since what's needed for one shipment
-- rarely matches the next, but the list of possible items, how they're
-- grouped, and what order they're in tends to stay the same.
CREATE TABLE IF NOT EXISTS pull_sheet_formats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pull_sheet_format_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  format_id UUID NOT NULL REFERENCES pull_sheet_formats(id) ON DELETE CASCADE,
  -- Nullable, same as pull_sheet_items -- if the linked catalog item is
  -- later deleted, the format row survives (name is snapshotted) but can no
  -- longer be used to build a real pull sheet until re-linked.
  catalog_item_id UUID REFERENCES catalog_items(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  -- A free-text grouping label ("Ceiling Grid CLASS ONE", "Hardware", etc.)
  -- -- consecutive items sharing the same section_name are rendered under
  -- one header. Null/blank means "no section" (rendered ungrouped).
  section_name TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_pull_sheet_format_items_format ON pull_sheet_format_items (format_id, sort_order);

-- Actual pull sheets (pull_sheet_items) gain the same two columns, so a
-- sheet built from a saved format keeps its section grouping and order all
-- the way through the admin's detail view, the PDF, and the employee's
-- report-back view -- instead of always being re-sorted alphabetically.
ALTER TABLE pull_sheet_items ADD COLUMN IF NOT EXISTS section_name TEXT;
ALTER TABLE pull_sheet_items ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
