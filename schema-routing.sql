-- Route planning: an admin picks an employee or a whole crew plus a date,
-- pulls in that day's scheduled jobs as candidate stops, and optimizes the
-- visiting order (round trip starting and ending at the shop). Stops can
-- then be manually reordered without losing the optimized result.

-- Geocoded once per customer (via Nominatim, see utils/geocode.js) and
-- cached here so a route build never has to re-geocode an address that
-- hasn't changed. Null until the first time it's needed.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS geocoded_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS delivery_routes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  route_date DATE NOT NULL,
  employee_id UUID REFERENCES employees(id) ON DELETE CASCADE,
  crew_id UUID REFERENCES crews(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'optimized')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  optimized_at TIMESTAMPTZ,
  -- Exactly one of employee_id/crew_id is set -- a route belongs to either
  -- a single employee or a whole team, never both and never neither.
  CONSTRAINT delivery_routes_owner_check CHECK (
    (employee_id IS NOT NULL AND crew_id IS NULL) OR
    (employee_id IS NULL AND crew_id IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS route_stops (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id UUID NOT NULL REFERENCES delivery_routes(id) ON DELETE CASCADE,
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  address_label TEXT,
  UNIQUE (route_id, job_id)
);

CREATE INDEX IF NOT EXISTS idx_delivery_routes_company_date ON delivery_routes (company_id, route_date);
CREATE INDEX IF NOT EXISTS idx_route_stops_route ON route_stops (route_id, sequence);
