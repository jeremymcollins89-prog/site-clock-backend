// Admin-facing CRUD for file attachments on jobs (Schedule) and invoices --
// photos, PDFs, contracts, whatever an admin wants on file for a specific
// job or invoice. See schema-attachments.sql for the storage rationale
// (bytea in Postgres, same pattern as the company logo). The read-only,
// employee-facing equivalent for viewing a job's attachments lives in
// routes/schedule.js instead, since it needs requireAuth (employee token)
// rather than requireAdmin.

const express = require("express");
const router = express.Router();
const db = require("../db");
const requireAdmin = require("../middleware/requireAdmin");

const MAX_BYTES = 10 * 1024 * 1024; // 10MB per file, pre-base64
const ALLOWED_MIME_PREFIXES = ["image/", "application/pdf", "application/msword",
  "application/vnd.openxmlformats-officedocument", "text/plain"];

router.use(requireAdmin);

function isAllowedMime(mime) {
  return typeof mime === "string" && ALLOWED_MIME_PREFIXES.some((p) => mime.startsWith(p));
}

// Confirms the given job/invoice actually belongs to this admin's company
// before letting them attach anything to it or read what's there --
// entity_type/entity_id has no DB-level FK (it can point at either table),
// so this ownership check is the only thing standing between one
// company's attachments and another's.
async function verifyEntityOwnership(entityType, entityId, companyId) {
  const table = entityType === "job" ? "jobs" : "invoices";
  const result = await db.query(`SELECT id FROM ${table} WHERE id = $1 AND company_id = $2`, [entityId, companyId]);
  return result.rowCount > 0;
}

// GET /api/admin/attachments?entity_type=job&entity_id=X
// Metadata only (no file_data) -- the list view for a job/invoice's
// attached files.
router.get("/", async (req, res) => {
  try {
    const { entity_type, entity_id } = req.query;
    if (!["job", "invoice"].includes(entity_type) || !entity_id) {
      return res.status(400).json({ error: "entity_type (job|invoice) and entity_id are required" });
    }
    const result = await db.query(
      `SELECT id, file_name, mime_type, file_size, created_at
       FROM attachments
       WHERE company_id = $1 AND entity_type = $2 AND entity_id = $3
       ORDER BY created_at ASC`,
      [req.companyId, entity_type, entity_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /admin/attachments failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load attachments." });
  }
});

// GET /api/admin/attachments/:id
// Returns the actual file bytes, for viewing/downloading.
router.get("/:id", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT file_name, mime_type, file_data FROM attachments WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.companyId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "Attachment not found" });
    const { file_name, mime_type, file_data } = result.rows[0];
    res.setHeader("Content-Type", mime_type);
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(file_name)}"`);
    res.send(file_data);
  } catch (err) {
    console.error("GET /admin/attachments/:id failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load that file." });
  }
});

// POST /api/admin/attachments
// Body: { entity_type, entity_id, file_name, mime_type, file_base64 }
router.post("/", async (req, res) => {
  try {
    const { entity_type, entity_id, file_name, mime_type, file_base64 } = req.body;
    if (!["job", "invoice"].includes(entity_type) || !entity_id) {
      return res.status(400).json({ error: "entity_type (job|invoice) and entity_id are required" });
    }
    if (!file_name || !mime_type || !file_base64) {
      return res.status(400).json({ error: "file_name, mime_type, and file_base64 are required" });
    }
    if (!isAllowedMime(mime_type)) {
      return res.status(400).json({ error: "That file type isn't supported. Try an image, PDF, Word doc, or plain text file." });
    }

    const owns = await verifyEntityOwnership(entity_type, entity_id, req.companyId);
    if (!owns) return res.status(404).json({ error: `That ${entity_type} wasn't found.` });

    const buffer = Buffer.from(file_base64, "base64");
    if (buffer.length > MAX_BYTES) {
      return res.status(400).json({ error: "That file is over the 10MB limit." });
    }

    const result = await db.query(
      `INSERT INTO attachments (company_id, entity_type, entity_id, file_name, mime_type, file_size, file_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, file_name, mime_type, file_size, created_at`,
      [req.companyId, entity_type, entity_id, file_name, mime_type, buffer.length, buffer]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("POST /admin/attachments failed:", err);
    res.status(500).json({ error: err.message || "Couldn't upload that file." });
  }
});

// DELETE /api/admin/attachments/:id
router.delete("/:id", async (req, res) => {
  try {
    const result = await db.query(`DELETE FROM attachments WHERE id = $1 AND company_id = $2`, [req.params.id, req.companyId]);
    if (result.rowCount === 0) return res.status(404).json({ error: "Attachment not found" });
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /admin/attachments/:id failed:", err);
    res.status(500).json({ error: err.message || "Couldn't delete that file." });
  }
});

module.exports = router;
