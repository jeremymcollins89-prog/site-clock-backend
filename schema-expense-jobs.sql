-- Lets an expense optionally be tied to a specific job/appointment, so
-- costs (materials, subcontractors, etc.) can be attributed to the job they
-- were spent on. Nullable -- general business expenses (rent, insurance)
-- aren't tied to any one job. ON DELETE SET NULL so deleting a job never
-- deletes the expense record, just detaches it from that job.
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS job_id UUID REFERENCES jobs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_expenses_job ON expenses (job_id);
