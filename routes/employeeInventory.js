const express = require("express");
const router = express.Router();
const db = require("../db");
const requireAuth = require("../middleware/requireAuth");
const { checkLowStock } = require("../utils/inventory");
const { lookupExternalProductSuggestion } = require("../utils/barcodeLookup");

// Employee-facing inventory management -- gated on employees.can_manage_inventory
// (see schema-employee-inventory-permission.sql), toggled per employee from the
// Edit Employee form in either admin app. Everything here is a narrower mirror
// of the admin-only catalog-items/inventory routes in routes/admin.js: same
// underlying table, same barcode-lookup flow, just reached via an employee JWT
// (requireAuth) instead of requireAdmin, and refusing to proceed at all unless
// this specific employee has been granted the permission -- an employee token
// alone is not enough.
//
// Every route re-fetches company_id + can_manage_inventory from the employees
// table rather than trusting anything cached client-side or embedded in the
// token (the JWT payload is just { employee_id, name } -- see utils/auth.js --
// so there's nothing to trust there anyway). This also means revoking the
// permission from the admin side takes effect on the employee's very next
// request, without waiting for their 180-day token to expire.
async function requireInventoryPermission(req, res, next) {
  try {
    const result = await db.query(
      `SELECT company_id, can_manage_inventory FROM employees WHERE id = $1`,
      [req.employee.employee_id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "Employee not found" });
    if (!result.rows[0].can_manage_inventory) {
      return res.status(403).json({ error: "You don't have inventory permissions. Ask an admin to turn this on for your account." });
    }
    req.companyId = result.rows[0].company_id;
    next();
  } catch (err) {
    console.error("requireInventoryPermission check failed:", err);
    res.status(500).json({ error: "Couldn't verify inventory permissions." });
  }
}

router.use(requireAuth, requireInventoryPermission);

// GET /api/employee-inventory/items
// Only catalog items with track_inventory = true -- same shape as the admin
// app's GET /admin/inventory, minus the total-value summary figures (those
// are a back-office/profit concept, not something the scanning flow needs).
router.get("/items", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, barcode, unit_price, unit_cost, quantity_on_hand, quantity_on_hold, low_stock_threshold,
              (quantity_on_hand - quantity_on_hold) AS quantity_available
       FROM catalog_items
       WHERE company_id = $1 AND track_inventory = true
       ORDER BY name`,
      [req.companyId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /employee-inventory/items failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load inventory." });
  }
});

// GET /api/employee-inventory/lookup-barcode/:barcode
// Identical behavior to the admin version -- see routes/admin.js for the
// full comment on the own-catalog-first / public-UPC-fallback strategy.
router.get("/lookup-barcode/:barcode", async (req, res) => {
  try {
    const barcode = String(req.params.barcode || "").trim();
    if (!barcode) return res.status(400).json({ error: "barcode is required" });

    const existing = await db.query(
      `SELECT id, name, unit_price, barcode, created_at,
              track_inventory, quantity_on_hand, quantity_on_hold, unit_cost, low_stock_threshold
       FROM catalog_items WHERE company_id = $1 AND barcode = $2`,
      [req.companyId, barcode]
    );
    if (existing.rowCount > 0) {
      return res.json({ found_in_catalog: true, item: existing.rows[0] });
    }

    const suggestion = await lookupExternalProductSuggestion(barcode);

    res.json({ found_in_catalog: false, suggestion });
  } catch (err) {
    console.error("GET /employee-inventory/lookup-barcode failed:", err);
    res.status(500).json({ error: err.message || "Couldn't look up that barcode." });
  }
});

// POST /api/employee-inventory/catalog-items
// Body: { name, barcode? }
// Creates a brand-new catalog item from a scanned barcode with no existing
// match. Deliberately narrower than the admin route: no unit_price here
// (that's a billing/quoting concern, not something scan-to-stock needs to
// set), and track_inventory/quantity_on_hand/unit_cost are applied in a
// follow-up PATCH call from the same scan flow, same as the admin UI does.
router.post("/catalog-items", async (req, res) => {
  try {
    const { name, barcode } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });
    const cleanBarcode = barcode ? String(barcode).trim() : null;
    if (cleanBarcode) {
      const dupe = await db.query(
        `SELECT id FROM catalog_items WHERE company_id = $1 AND barcode = $2`,
        [req.companyId, cleanBarcode]
      );
      if (dupe.rowCount > 0) return res.status(400).json({ error: "Another catalog item already uses this barcode." });
    }
    const result = await db.query(
      `INSERT INTO catalog_items (company_id, name, unit_price, barcode) VALUES ($1, $2, 0, $3)
       RETURNING id, name, unit_price, barcode, created_at`,
      [req.companyId, name, cleanBarcode]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(400).json({ error: "Another catalog item already uses this barcode." });
    console.error("POST /employee-inventory/catalog-items failed:", err);
    res.status(500).json({ error: err.message || "Couldn't create catalog item." });
  }
});

// PATCH /api/employee-inventory/catalog-items/:id
// Body: any of { barcode?, track_inventory?, quantity_on_hand?, unit_cost?,
// low_stock_threshold? } -- deliberately excludes name/unit_price, which stay
// admin-only (those affect quotes/invoices, not just stock counts). Editing
// quantity_on_hand here is how both "scan to restock" and any other quantity
// correction gets recorded, same one-field-does-both-jobs approach as the
// admin route.
router.patch("/catalog-items/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { barcode, track_inventory, quantity_on_hand, unit_cost, low_stock_threshold } = req.body;
    const owns = await db.query(`SELECT id FROM catalog_items WHERE id = $1 AND company_id = $2`, [id, req.companyId]);
    if (owns.rowCount === 0) return res.status(404).json({ error: "Catalog item not found" });

    const fields = [];
    const values = [];
    if (barcode !== undefined) {
      const cleanBarcode = barcode ? String(barcode).trim() : null;
      if (cleanBarcode) {
        const dupe = await db.query(
          `SELECT id FROM catalog_items WHERE company_id = $1 AND barcode = $2 AND id != $3`,
          [req.companyId, cleanBarcode, id]
        );
        if (dupe.rowCount > 0) return res.status(400).json({ error: "Another catalog item already uses this barcode." });
      }
      values.push(cleanBarcode); fields.push(`barcode = $${values.length}`);
    }
    if (track_inventory !== undefined) { values.push(!!track_inventory); fields.push(`track_inventory = $${values.length}`); }
    if (quantity_on_hand !== undefined) {
      const qty = Math.max(0, Math.round(Number(quantity_on_hand)) || 0);
      values.push(qty); fields.push(`quantity_on_hand = $${values.length}`);
    }
    if (unit_cost !== undefined) { values.push(unit_cost === null || unit_cost === "" ? null : Number(unit_cost) || 0); fields.push(`unit_cost = $${values.length}`); }
    if (low_stock_threshold !== undefined) {
      const threshold = low_stock_threshold === null || low_stock_threshold === "" ? null : Math.max(0, Math.round(Number(low_stock_threshold)) || 0);
      values.push(threshold); fields.push(`low_stock_threshold = $${values.length}`);
      fields.push(`low_stock_alert_sent = false`);
    }

    if (fields.length === 0) return res.status(400).json({ error: "Nothing to update" });

    values.push(id);
    const result = await db.query(
      `UPDATE catalog_items SET ${fields.join(", ")} WHERE id = $${values.length}
       RETURNING id, name, unit_price, barcode, created_at,
                 track_inventory, quantity_on_hand, quantity_on_hold, unit_cost, low_stock_threshold`,
      values
    );
    if (quantity_on_hand !== undefined || low_stock_threshold !== undefined) {
      await checkLowStock(id, req.companyId);
    }
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(400).json({ error: "Another catalog item already uses this barcode." });
    console.error("PATCH /employee-inventory/catalog-items/:id failed:", err);
    res.status(500).json({ error: err.message || "Couldn't update catalog item." });
  }
});

module.exports = router;
