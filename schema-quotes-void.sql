-- Adds a 'void' status for quotes, distinct from 'declined' (customer said
-- no) -- this is for when an invoice created from an accepted quote later
-- gets voided/cancelled for some other reason (billing mistake, job fell
-- through, duplicate, etc). Voiding an invoice now automatically marks its
-- originating quote 'void' too, so the quote record doesn't stay stuck
-- showing "accepted" forever after the work it was for got cancelled.
ALTER TABLE quotes DROP CONSTRAINT IF EXISTS quotes_status_check;
ALTER TABLE quotes ADD CONSTRAINT quotes_status_check CHECK (status IN ('draft', 'sent', 'accepted', 'declined', 'void'));
