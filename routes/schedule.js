const express = require("express");
const router = express.Router();
const db = require("../db");
const requireAuth = require("../middleware/requireAuth");
const { sendPushToAdmin } = require("../utils/webPush");
const { buildGoogleMapsUrl } = require("../utils/routeOptimize");

// GET /api/schedule/me?start=YYYY-MM-DD&end=YYYY-MM-DD
// Returns every job for the logged-in employee's company (not just ones
// they're personally assigned to), overlapping the given range, so everyone
// can see the full shared calendar. If start/end are omitted, defaults to
// today through 30 days out -- this is what the employee app's Schedule
// view uses. Push notifications for new/updated jobs still only go to the
// employees actually assigned to that job (see notifyAssigned in admin.js) --
// this broader visibility is just for the calendar view itself.
router.get("/me", requireAuth, async (req, res) => {
  try {
    let { start, end } = req.query;
    if (!start) {
      start = new Date().toISOString().slice(0, 10);
    }
    if (!end) {
      const d = new Date();
      d.setDate(d.getDate() + 30);
      end = d.toISOString().slice(0, 10);
    }

    const result = await db.query(
      `SELECT j.id, j.title, j.notes, j.start_date, j.end_date, j.start_time, j.color, j.event_type,
              c.name AS customer_name, c.phone AS customer_phone,
              c.street AS customer_street, c.city AS customer_city, c.state AS customer_state, c.zip AS customer_zip
       FROM jobs j
       JOIN employees e ON e.company_id = j.company_id
       LEFT JOIN customers c ON c.id = j.customer_id
       WHERE e.id = $1 AND j.end_date >= $2 AND j.start_date <= $3
       ORDER BY j.start_date, j.title`,
      [req.employee.employee_id, start, end]
    );

    // Opening the Schedule tab is what clears the "new assignment" badge --
    // mark every one of this employee's assignments as seen, independent of
    // the date range above (which only bounds what's shown, not what's
    // "theirs").
    await db.query(
      `UPDATE job_assignments SET seen_by_employee = true WHERE employee_id = $1 AND seen_by_employee = false`,
      [req.employee.employee_id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("GET /schedule/me failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load schedule." });
  }
});

// GET /api/schedule/unseen-count
// Lightweight, safe to poll -- does NOT mark anything as seen. Used to show
// a badge on the Schedule tab without silently clearing it in the
// background before the employee actually looks at it.
router.get("/unseen-count", requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT COUNT(*)::int AS count FROM job_assignments WHERE employee_id = $1 AND seen_by_employee = false`,
      [req.employee.employee_id]
    );
    res.json({ count: result.rows[0].count });
  } catch (err) {
    console.error("GET /schedule/unseen-count failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load unseen count." });
  }
});

// GET /api/schedule/customers
// Read-only customer directory for the logged-in employee's company --
// employees can look someone up (name/phone/email/address) but can't
// add, edit, or delete customers; that stays admin-only.
router.get("/customers", requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT c.id, c.name, c.phone, c.email, c.street, c.city, c.state, c.zip, c.notes
       FROM customers c
       JOIN employees e ON e.company_id = c.company_id
       WHERE e.id = $1
       ORDER BY c.name`,
      [req.employee.employee_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /schedule/customers failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load customers." });
  }
});

// ---------- Time off requests ----------
// An employee proposes a date range (a single day, a week, whatever) with
// an optional note explaining why, and it sits 'pending' until the admin
// approves or denies it (see PATCH /api/admin/time-off-requests/:id). Only
// once approved does it become a real calendar event -- these routes never
// touch `jobs` themselves.

// POST /api/schedule/time-off
// Body: { start_date, end_date, note? }
router.post("/time-off", requireAuth, async (req, res) => {
  try {
    const { start_date, end_date, note } = req.body;
    if (!start_date || !end_date) {
      return res.status(400).json({ error: "start_date and end_date are required" });
    }
    if (end_date < start_date) {
      return res.status(400).json({ error: "end_date can't be before start_date" });
    }

    const employeeResult = await db.query(
      `SELECT company_id, name FROM employees WHERE id = $1`,
      [req.employee.employee_id]
    );
    if (employeeResult.rowCount === 0) return res.status(404).json({ error: "Employee not found" });
    const { company_id: companyId, name: employeeName } = employeeResult.rows[0];

    const result = await db.query(
      `INSERT INTO time_off_requests (company_id, employee_id, start_date, end_date, note)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, employee_id, start_date, end_date, note, status, job_id, reviewed_at, created_at`,
      [companyId, req.employee.employee_id, start_date, end_date, note || null]
    );

    const dateRange = start_date === end_date ? start_date : `${start_date} to ${end_date}`;
    sendPushToAdmin(companyId, {
      title: "New time off request",
      body: `${employeeName} requested ${dateRange}${note ? ` — "${note}"` : ""}`,
      url: "/admin.html?tab=schedule",
    }).catch((err) => console.error("Failed to send time-off request notification:", err.message));

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("POST /schedule/time-off failed:", err);
    res.status(500).json({ error: err.message || "Couldn't submit time off request." });
  }
});

// GET /api/schedule/time-off
// Every request this employee has ever submitted, newest first, so they
// can see what's pending/approved/denied without asking the admin.
router.get("/time-off", requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, start_date, end_date, note, status, job_id, reviewed_at, created_at
       FROM time_off_requests
       WHERE employee_id = $1
       ORDER BY created_at DESC`,
      [req.employee.employee_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /schedule/time-off failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load time off requests." });
  }
});

// DELETE /api/schedule/time-off/:id
// Lets an employee withdraw their own request, but only while it's still
// 'pending' -- once an admin has approved or denied it, it's final.
router.delete("/time-off/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      `UPDATE time_off_requests SET status = 'cancelled'
       WHERE id = $1 AND employee_id = $2 AND status = 'pending'
       RETURNING id`,
      [id, req.employee.employee_id]
    );
    if (result.rowCount === 0) {
      return res.status(400).json({ error: "Request not found, or it's already been reviewed." });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /schedule/time-off/:id failed:", err);
    res.status(500).json({ error: err.message || "Couldn't cancel request." });
  }
});

// GET /api/schedule/routing/today
// Returns the employee's next upcoming optimized route -- today's if one
// exists, otherwise the soonest one built ahead of time (e.g. an admin
// building Thursday's route on Monday) -- whether it was built for them
// directly or for a whole crew they belong to (see routes/routing.js for
// how these get built). Deliberately NOT scoped to route_date = today only:
// routes are commonly built a few days in advance, and this is the
// "Assigned routes" screen an employee can check anytime, not a
// day-of-only widget. Includes a maps_url: a free Google Maps multi-stop
// directions link (no API key needed) pre-loaded with every stop in the
// optimized order, for the "Start Route" button to hand off to the real
// Google Maps app.
router.get("/routing/today", requireAuth, async (req, res) => {
  try {
    const employeeResult = await db.query(
      `SELECT company_id FROM employees WHERE id = $1`,
      [req.employee.employee_id]
    );
    if (employeeResult.rowCount === 0) return res.status(404).json({ error: "Employee not found" });
    const companyId = employeeResult.rows[0].company_id;
    const today = new Date().toISOString().slice(0, 10);

    const routeResult = await db.query(
      `SELECT r.id, r.crew_id, r.route_date
       FROM delivery_routes r
       WHERE r.company_id = $1 AND r.route_date >= $2 AND r.status = 'optimized'
         AND (
           r.employee_id = $3
           OR r.crew_id IN (SELECT crew_id FROM crew_members WHERE employee_id = $3)
         )
       ORDER BY r.route_date ASC, r.optimized_at DESC
       LIMIT 1`,
      [companyId, today, req.employee.employee_id]
    );
    if (routeResult.rowCount === 0) return res.json(null);
    const routeId = routeResult.rows[0].id;
    const routeDate = routeResult.rows[0].route_date;

    const stopsResult = await db.query(
      `SELECT rs.id, rs.sequence, rs.lat, rs.lng, rs.address_label, j.title, j.start_time
       FROM route_stops rs
       JOIN jobs j ON j.id = rs.job_id
       WHERE rs.route_id = $1
       ORDER BY rs.sequence`,
      [routeId]
    );

    const shopResult = await db.query(`SELECT shop_lat, shop_lng FROM companies WHERE id = $1`, [companyId]);
    const shop = shopResult.rows[0];
    const shopLocation = shop && shop.shop_lat != null && shop.shop_lng != null
      ? { lat: shop.shop_lat, lng: shop.shop_lng }
      : null;

    const mapsUrl = shopLocation && stopsResult.rows.length > 0
      ? buildGoogleMapsUrl(shopLocation, stopsResult.rows, shopLocation)
      : null;

    res.json({ id: routeId, route_date: routeDate, stops: stopsResult.rows, maps_url: mapsUrl, shop_location: shopLocation });
  } catch (err) {
    console.error("GET /schedule/routing/today failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load today's route." });
  }
});

// GET /api/schedule/jobs/:jobId/attachments
// Read-only: lets an employee see (and download) whatever files an admin
// attached to a job -- reference photos, work orders, contracts -- without
// giving them any ability to add or remove attachments themselves (that
// stays admin-only, see routes/attachments.js). Scoped to the employee's
// own company, matching the same "see every job company-wide" visibility
// model as GET /me above, not just jobs they're personally assigned to.
router.get("/jobs/:jobId/attachments", requireAuth, async (req, res) => {
  try {
    const employeeResult = await db.query(`SELECT company_id FROM employees WHERE id = $1`, [req.employee.employee_id]);
    if (employeeResult.rowCount === 0) return res.status(404).json({ error: "Employee not found" });
    const companyId = employeeResult.rows[0].company_id;

    const jobOwns = await db.query(`SELECT id FROM jobs WHERE id = $1 AND company_id = $2`, [req.params.jobId, companyId]);
    if (jobOwns.rowCount === 0) return res.status(404).json({ error: "Job not found" });

    const result = await db.query(
      `SELECT id, file_name, mime_type, file_size, created_at
       FROM attachments
       WHERE company_id = $1 AND entity_type = 'job' AND entity_id = $2
       ORDER BY created_at ASC`,
      [companyId, req.params.jobId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /schedule/jobs/:jobId/attachments failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load attachments." });
  }
});

// GET /api/schedule/attachments/:id
// Returns the actual file bytes for an employee viewing/downloading a job
// attachment (see above) -- same company-scoping check as the list route.
router.get("/attachments/:id", requireAuth, async (req, res) => {
  try {
    const employeeResult = await db.query(`SELECT company_id FROM employees WHERE id = $1`, [req.employee.employee_id]);
    if (employeeResult.rowCount === 0) return res.status(404).json({ error: "Employee not found" });
    const companyId = employeeResult.rows[0].company_id;

    const result = await db.query(
      `SELECT file_name, mime_type, file_data FROM attachments WHERE id = $1 AND company_id = $2 AND entity_type = 'job'`,
      [req.params.id, companyId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "Attachment not found" });
    const { file_name, mime_type, file_data } = result.rows[0];
    res.setHeader("Content-Type", mime_type);
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(file_name)}"`);
    res.send(file_data);
  } catch (err) {
    console.error("GET /schedule/attachments/:id failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load that file." });
  }
});

// ---------- Pull sheets ----------
// Read/write, employee-facing view of pull sheets. Visible to every
// employee in the company, regardless of source type (quote/invoice/
// manual) or job assignment -- an earlier version of this only showed a
// sheet if it could trace a job_assignments link back through the source
// quote/invoice, but plenty of invoices/quotes are never tied to a
// scheduled job at all, which meant those pull sheets silently never
// reached anyone. Company-wide visibility guarantees every pull sheet an
// admin builds actually shows up for the crew. "Visible" is intentionally
// not the same as "fulfilled" -- an employee should see a pull sheet as
// soon as it's built, not just once an admin marks it fulfilled.
//
// Status flow: 'open' (nothing reported yet) -> 'pulled' (an employee
// submitted actual quantities via PATCH .../pulled, see below) ->
// 'fulfilled' (admin reviewed and confirmed -- see PATCH
// /api/admin/pull-sheets/:id/fulfill -- this is the only step that
// actually changes real inventory numbers).

// GET /api/schedule/pull-sheets
// Only 'open' sheets are returned -- once an employee marks one pulled (or
// an admin fulfills it), it's done from the employee's side and drops out
// of their list entirely. If a reported quantity turns out wrong, the fix
// happens through the admin now rather than the employee re-opening it.
router.get("/pull-sheets", requireAuth, async (req, res) => {
  try {
    const employeeResult = await db.query(`SELECT company_id FROM employees WHERE id = $1`, [req.employee.employee_id]);
    if (employeeResult.rowCount === 0) return res.status(404).json({ error: "Employee not found" });
    const companyId = employeeResult.rows[0].company_id;

    const result = await db.query(
      `SELECT ps.id, ps.source_type, ps.source_label, ps.customer_name, ps.status, ps.created_at, ps.fulfilled_at, ps.pulled_at,
              COALESCE(
                (SELECT json_agg(json_build_object('id', psi.id, 'name', psi.name, 'quantity', psi.quantity, 'quantity_pulled', psi.quantity_pulled) ORDER BY psi.name)
                 FROM pull_sheet_items psi WHERE psi.pull_sheet_id = ps.id),
                '[]'::json
              ) AS items
       FROM pull_sheets ps
       WHERE ps.company_id = $1 AND ps.status = 'open'
       ORDER BY ps.created_at DESC`,
      [companyId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("GET /schedule/pull-sheets failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load pull sheets." });
  }
});

// GET /api/schedule/pull-sheets/unseen-count
// Counts only 'open' sheets now, matching the list above -- once marked
// pulled it's off the employee's plate, so it shouldn't keep the menu
// badge lit.
router.get("/pull-sheets/unseen-count", requireAuth, async (req, res) => {
  try {
    const employeeResult = await db.query(`SELECT company_id FROM employees WHERE id = $1`, [req.employee.employee_id]);
    if (employeeResult.rowCount === 0) return res.status(404).json({ error: "Employee not found" });
    const companyId = employeeResult.rows[0].company_id;

    const result = await db.query(
      `SELECT COUNT(*)::int AS count FROM pull_sheets WHERE company_id = $1 AND status = 'open'`,
      [companyId]
    );
    res.json({ count: result.rows[0].count });
  } catch (err) {
    console.error("GET /schedule/pull-sheets/unseen-count failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load unseen count." });
  }
});

// GET /api/schedule/pull-sheets/:id
router.get("/pull-sheets/:id", requireAuth, async (req, res) => {
  try {
    const employeeResult = await db.query(`SELECT company_id FROM employees WHERE id = $1`, [req.employee.employee_id]);
    if (employeeResult.rowCount === 0) return res.status(404).json({ error: "Employee not found" });
    const companyId = employeeResult.rows[0].company_id;

    const sheetResult = await db.query(
      `SELECT id, source_type, source_label, customer_name, status, created_at, fulfilled_at, pulled_at
       FROM pull_sheets WHERE id = $1 AND company_id = $2`,
      [req.params.id, companyId]
    );
    if (sheetResult.rowCount === 0) return res.status(404).json({ error: "Pull sheet not found" });

    const itemsResult = await db.query(
      `SELECT id, name, quantity, quantity_pulled FROM pull_sheet_items WHERE pull_sheet_id = $1 ORDER BY name`,
      [req.params.id]
    );

    res.json({ ...sheetResult.rows[0], items: itemsResult.rows });
  } catch (err) {
    console.error("GET /schedule/pull-sheets/:id failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load pull sheet." });
  }
});

// PATCH /api/schedule/pull-sheets/:id/pulled
// Body: { items: [{ id, quantity_pulled }] }
// An employee reports what they actually grabbed off the shelf for each
// item -- purely informational, does NOT touch real inventory. Moves the
// sheet from 'open' to 'pulled' (or leaves it 'pulled' if re-submitted --
// e.g. correcting a number before the admin fulfills it). Blocked once the
// admin has already fulfilled the sheet, since at that point inventory has
// already been consumed and reported quantities can no longer change
// anything.
router.patch("/pull-sheets/:id/pulled", requireAuth, async (req, res) => {
  try {
    const employeeResult = await db.query(`SELECT company_id, name FROM employees WHERE id = $1`, [req.employee.employee_id]);
    if (employeeResult.rowCount === 0) return res.status(404).json({ error: "Employee not found" });
    const { company_id: companyId, name: employeeName } = employeeResult.rows[0];

    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "No items to report." });
    }

    const sheetResult = await db.query(`SELECT id, status FROM pull_sheets WHERE id = $1 AND company_id = $2`, [req.params.id, companyId]);
    if (sheetResult.rowCount === 0) return res.status(404).json({ error: "Pull sheet not found" });
    if (sheetResult.rows[0].status === "fulfilled") {
      return res.status(400).json({ error: "This pull sheet has already been fulfilled." });
    }

    for (const item of items) {
      if (!item.id) continue;
      const qty = item.quantity_pulled === "" || item.quantity_pulled == null ? null : Math.max(0, Math.round(Number(item.quantity_pulled)));
      await db.query(
        `UPDATE pull_sheet_items SET quantity_pulled = $1 WHERE id = $2 AND pull_sheet_id = $3`,
        [qty, item.id, req.params.id]
      );
    }

    const updated = await db.query(
      `UPDATE pull_sheets SET status = 'pulled', pulled_at = now(), pulled_by_employee_id = $1
       WHERE id = $2 RETURNING id, source_type, source_label, customer_name, status, created_at, fulfilled_at, pulled_at`,
      [req.employee.employee_id, req.params.id]
    );

    const itemsResult = await db.query(
      `SELECT id, name, quantity, quantity_pulled FROM pull_sheet_items WHERE pull_sheet_id = $1 ORDER BY name`,
      [req.params.id]
    );

    const sheet = updated.rows[0];
    sendPushToAdmin(companyId, {
      title: "Pull sheet reported",
      body: `${employeeName} marked "${sheet.source_label}" as pulled -- ready to review and fulfill.`,
      url: "/admin.html?tab=inventory",
    }).catch((err) => console.error("Failed to send pull-sheet-pulled notification:", err.message));

    res.json({ ...sheet, items: itemsResult.rows });
  } catch (err) {
    console.error("PATCH /schedule/pull-sheets/:id/pulled failed:", err);
    res.status(500).json({ error: err.message || "Couldn't save what you pulled." });
  }
});

// GET /api/schedule/company-logo
// Read-only, employee-facing mirror of GET /api/admin/company-logo -- lets
// the Employee PWA show the same logo in its header that already appears in
// both admin apps, without needing an admin token. Returns { logo: null } if
// the company hasn't uploaded one.
router.get("/company-logo", requireAuth, async (req, res) => {
  try {
    const employeeResult = await db.query(`SELECT company_id FROM employees WHERE id = $1`, [req.employee.employee_id]);
    if (employeeResult.rowCount === 0) return res.status(404).json({ error: "Employee not found" });
    const companyId = employeeResult.rows[0].company_id;

    const result = await db.query(`SELECT logo_data, logo_mime_type FROM companies WHERE id = $1`, [companyId]);
    const row = result.rows[0];
    if (!row || !row.logo_data) return res.json({ logo: null });
    res.json({ logo: `data:${row.logo_mime_type};base64,${row.logo_data.toString("base64")}` });
  } catch (err) {
    console.error("GET /schedule/company-logo failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load logo." });
  }
});

module.exports = router;
