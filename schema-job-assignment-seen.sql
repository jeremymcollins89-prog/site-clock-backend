-- Lets the employee app show a "new assignment" badge on the Schedule tab,
-- the same way Chat shows unread counts. false means the employee hasn't
-- opened their Schedule tab since being assigned to this job.
ALTER TABLE job_assignments ADD COLUMN IF NOT EXISTS seen_by_employee BOOLEAN NOT NULL DEFAULT false;
