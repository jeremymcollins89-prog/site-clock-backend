-- Lets an admin designate specific employees who can manage inventory from
-- their own employee app: scan barcodes to restock/add catalog items, and
-- edit quantities directly. Off by default -- purely opt-in per employee,
-- toggled from the Edit Employee form (see routes/admin.js PATCH
-- /employees/:id), addable and removable at any time.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS can_manage_inventory BOOLEAN NOT NULL DEFAULT false;
