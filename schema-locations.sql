CREATE TABLE employee_locations (
  employee_id    UUID PRIMARY KEY REFERENCES employees(id),
  lat            DOUBLE PRECISION NOT NULL,
  lng            DOUBLE PRECISION NOT NULL,
  recorded_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
