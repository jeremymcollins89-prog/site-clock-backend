CREATE TABLE ping_requests (
  employee_id    UUID PRIMARY KEY REFERENCES employees(id),
  requested_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);