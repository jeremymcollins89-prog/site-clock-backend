-- Direct messaging and group chat BETWEEN employees of the same company
-- (separate from chat_messages, which is the admin<->single-employee
-- channel). A thread can be a 1:1 DM (is_group = false, exactly 2
-- participants) or a named group chat (is_group = true, name set,
-- 2+ participants). Sending a message is only allowed while the sender is
-- clocked in (enforced in the route, not here) -- but history stays
-- readable for everyone after they clock out, same as the admin channel.

CREATE TABLE IF NOT EXISTS employee_chat_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  is_group BOOLEAN NOT NULL DEFAULT false,
  name TEXT,
  created_by UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS employee_chat_participants (
  thread_id UUID NOT NULL REFERENCES employee_chat_threads(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  last_read_at TIMESTAMPTZ,
  PRIMARY KEY (thread_id, employee_id)
);

CREATE TABLE IF NOT EXISTS employee_chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES employee_chat_threads(id) ON DELETE CASCADE,
  sender_employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_employee_chat_participants_employee ON employee_chat_participants (employee_id);
CREATE INDEX IF NOT EXISTS idx_employee_chat_messages_thread ON employee_chat_messages (thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_employee_chat_threads_company ON employee_chat_threads (company_id);
