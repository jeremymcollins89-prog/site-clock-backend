-- Reworks the employee-to-employee chat tables (from schema-employee-chat.sql)
-- so a thread participant or message sender can be EITHER an employee OR the
-- company's admin -- needed so the admin can also start/join direct and
-- group team chats, not just employees messaging each other.
--
-- This feature was only just introduced and shouldn't have any real
-- conversations in it yet, so this migration simply drops and recreates the
-- three tables with the corrected shape rather than trying to ALTER a
-- composite primary key in place. If you have real team-chat messages you
-- need to keep, stop and ask before running this.

DROP TABLE IF EXISTS employee_chat_messages CASCADE;
DROP TABLE IF EXISTS employee_chat_participants CASCADE;
DROP TABLE IF EXISTS employee_chat_threads CASCADE;

CREATE TABLE employee_chat_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  is_group BOOLEAN NOT NULL DEFAULT false,
  name TEXT,
  created_by_employee_id UUID REFERENCES employees(id) ON DELETE SET NULL,
  created_by_is_admin BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A participant row represents either one employee OR the admin (never both,
-- never neither) -- enforced by the check constraint below.
CREATE TABLE employee_chat_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES employee_chat_threads(id) ON DELETE CASCADE,
  employee_id UUID REFERENCES employees(id) ON DELETE CASCADE,
  is_admin BOOLEAN NOT NULL DEFAULT false,
  last_read_at TIMESTAMPTZ,
  CONSTRAINT employee_chat_participants_one_kind CHECK (
    (employee_id IS NOT NULL AND is_admin = false) OR (employee_id IS NULL AND is_admin = true)
  )
);

-- At most one row per employee per thread, and at most one admin row per
-- thread (there's only one admin login per company anyway).
CREATE UNIQUE INDEX idx_echat_participants_employee_unique
  ON employee_chat_participants (thread_id, employee_id) WHERE employee_id IS NOT NULL;
CREATE UNIQUE INDEX idx_echat_participants_admin_unique
  ON employee_chat_participants (thread_id) WHERE is_admin = true;
CREATE INDEX idx_echat_participants_employee ON employee_chat_participants (employee_id);

-- A message's sender is likewise either one employee OR the admin.
CREATE TABLE employee_chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES employee_chat_threads(id) ON DELETE CASCADE,
  sender_employee_id UUID REFERENCES employees(id) ON DELETE CASCADE,
  sender_is_admin BOOLEAN NOT NULL DEFAULT false,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT employee_chat_messages_one_kind CHECK (
    (sender_employee_id IS NOT NULL AND sender_is_admin = false) OR (sender_employee_id IS NULL AND sender_is_admin = true)
  )
);

CREATE INDEX idx_echat_messages_thread ON employee_chat_messages (thread_id, created_at);
CREATE INDEX idx_echat_threads_company ON employee_chat_threads (company_id);
