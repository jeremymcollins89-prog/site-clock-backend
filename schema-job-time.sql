-- Optional time-of-day for scheduled jobs/appointments. NULL means "no
-- specific time" -- shown as an untimed / all-day item on the calendar
-- rather than slotted into an hour.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS start_time TIME NULL;
