// Delivery/service route planning: admin picks a date + an employee or a
// whole crew, pulls in that day's scheduled jobs (with a geocoded customer
// address) as candidate stops, and optimizes the visiting order as a round
// trip starting and ending back at the shop (see utils/routeOptimize.js).
// Stops can be manually reordered afterward without losing that result, or
// re-optimized after removing one. See routes/schedule.js for the
// employee-facing "today's route" endpoint that reads what gets built here.

const express = require("express");
const router = express.Router();
const db = require("../db");
const requireAdmin = require("../middleware/requireAdmin");
const { optimizeStopOrder, buildGoogleMapsUrl } = require("../utils/routeOptimize");

router.use(requireAdmin);

async function getShopLocation(companyId) {
  const result = await db.query(`SELECT shop_lat, shop_lng FROM companies WHERE id = $1`, [companyId]);
  const row = result.rows[0];
  if (!row || row.shop_lat == null || row.shop_lng == null) return null;
  return { lat: row.shop_lat, lng: row.shop_lng };
}

function addressLabel(job) {
  const parts = [job.customer_street, job.customer_city, job.customer_state, job.customer_zip].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : job.customer_name || "Untitled stop";
}

// GET /api/admin/routing/candidates?date=YYYY-MM-DD&employee_id=X
// GET /api/admin/routing/candidates?date=YYYY-MM-DD&crew_id=Y
// Returns that day's scheduled jobs (event_type='job', linked to a
// geocoded customer) assigned to the given employee, or to every member of
// the given crew combined -- for the admin to review/deselect before
// building a route. Jobs whose customer has no lat/lng yet (never
// geocoded, or the address didn't resolve) are still listed but flagged
// with geocoded: false so the admin knows why they can't be included.
router.get("/candidates", async (req, res) => {
  try {
    const { date, employee_id, crew_id } = req.query;
    if (!date) return res.status(400).json({ error: "date is required" });
    if (!employee_id && !crew_id) return res.status(400).json({ error: "employee_id or crew_id is required" });

    const params = [req.companyId, date];
    let employeeFilter;
    if (employee_id) {
      params.push(employee_id);
      employeeFilter = `ja.employee_id = $${params.length}`;
    } else {
      params.push(crew_id);
      employeeFilter = `ja.employee_id IN (SELECT employee_id FROM crew_members WHERE crew_id = $${params.length})`;
    }

    const result = await db.query(
      `SELECT DISTINCT j.id AS job_id, j.title, j.start_time,
              c.id AS customer_id, c.name AS customer_name,
              c.street AS customer_street, c.city AS customer_city, c.state AS customer_state, c.zip AS customer_zip,
              c.lat, c.lng
       FROM jobs j
       JOIN job_assignments ja ON ja.job_id = j.id
       LEFT JOIN customers c ON c.id = j.customer_id
       WHERE j.company_id = $1 AND j.event_type = 'job'
         AND j.start_date <= $2 AND j.end_date >= $2
         AND ${employeeFilter}
       ORDER BY j.start_time NULLS LAST, j.title`,
      params
    );

    const candidates = result.rows.map((row) => ({
      job_id: row.job_id,
      title: row.title,
      start_time: row.start_time,
      customer_name: row.customer_name,
      address_label: addressLabel(row),
      lat: row.lat,
      lng: row.lng,
      geocoded: row.lat != null && row.lng != null,
    }));
    res.json(candidates);
  } catch (err) {
    console.error("GET /admin/routing/candidates failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load candidate stops." });
  }
});

// GET /api/admin/routing?date=YYYY-MM-DD
// Lists routes built for that date (for an at-a-glance view of the day).
router.get("/", async (req, res) => {
  try {
    const { date } = req.query;
    const conditions = [`r.company_id = $1`];
    const params = [req.companyId];
    if (date) { params.push(date); conditions.push(`r.route_date = $${params.length}`); }

    const result = await db.query(
      `SELECT r.id, r.route_date, r.status, r.employee_id, e.name AS employee_name,
              r.crew_id, cr.name AS crew_name,
              (SELECT COUNT(*) FROM route_stops WHERE route_id = r.id) AS stop_count
       FROM delivery_routes r
       LEFT JOIN employees e ON e.id = r.employee_id
       LEFT JOIN crews cr ON cr.id = r.crew_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY r.created_at DESC`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /admin/routing failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load routes." });
  }
});

async function loadRouteDetail(routeId, companyId) {
  const routeResult = await db.query(
    `SELECT r.id, r.route_date, r.status, r.employee_id, e.name AS employee_name, r.crew_id, cr.name AS crew_name
     FROM delivery_routes r
     LEFT JOIN employees e ON e.id = r.employee_id
     LEFT JOIN crews cr ON cr.id = r.crew_id
     WHERE r.id = $1 AND r.company_id = $2`,
    [routeId, companyId]
  );
  if (routeResult.rowCount === 0) return null;
  const route = routeResult.rows[0];

  const stopsResult = await db.query(
    `SELECT rs.id, rs.job_id, rs.sequence, rs.lat, rs.lng, rs.address_label, j.title, j.start_time
     FROM route_stops rs
     JOIN jobs j ON j.id = rs.job_id
     WHERE rs.route_id = $1
     ORDER BY rs.sequence`,
    [routeId]
  );
  route.stops = stopsResult.rows;

  const shop = await getShopLocation(companyId);
  route.maps_url = shop && route.stops.length > 0 ? buildGoogleMapsUrl(shop, route.stops, shop) : null;
  route.shop_location = shop;
  return route;
}

// GET /api/admin/routing/on-clock-locations
// Returns every currently clocked-in employee (an open time_entry, i.e.
// clock_out IS NULL) at this company who has a last-known lat/lng on file
// (pinged automatically every 5 minutes while clocked in -- see
// routes/timeEntries.js POST /ping-location). Used to show live-ish pins
// for the whole crew on the Routes map preview, independent of which
// employee/team a given route was built for.
router.get("/on-clock-locations", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT DISTINCT e.id AS employee_id, e.name, l.lat, l.lng, l.recorded_at
       FROM time_entries t
       JOIN employees e ON e.id = t.employee_id
       JOIN employee_locations l ON l.employee_id = e.id
       WHERE t.clock_out IS NULL AND e.company_id = $1`,
      [req.companyId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /admin/routing/on-clock-locations failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load on-the-clock locations." });
  }
});

// GET /api/admin/routing/:id
router.get("/:id", async (req, res) => {
  try {
    const route = await loadRouteDetail(req.params.id, req.companyId);
    if (!route) return res.status(404).json({ error: "Route not found" });
    res.json(route);
  } catch (err) {
    console.error("GET /admin/routing/:id failed:", err);
    res.status(500).json({ error: err.message || "Couldn't load route." });
  }
});

// POST /api/admin/routing
// Body: { date, employee_id? | crew_id?, job_ids: [...] }
// Creates the route, adds the given jobs as stops (each needs a geocoded
// customer address), and immediately optimizes the visiting order as a
// round trip from/to the shop. If optimization fails (no ORS_API_KEY, or
// the request errors) the route is still created with stops in the given
// order and status stays 'draft', rather than losing the admin's work.
router.post("/", async (req, res) => {
  const client = db;
  try {
    const { date, employee_id, crew_id, job_ids } = req.body;
    if (!date) return res.status(400).json({ error: "date is required" });
    if (!employee_id && !crew_id) return res.status(400).json({ error: "employee_id or crew_id is required" });
    if (employee_id && crew_id) return res.status(400).json({ error: "Choose either an employee or a crew, not both" });
    if (!Array.isArray(job_ids) || job_ids.length === 0) return res.status(400).json({ error: "job_ids is required" });

    const shop = await getShopLocation(req.companyId);
    if (!shop) {
      return res.status(400).json({ error: "Set your shop location in Settings before building a route." });
    }

    const jobsResult = await client.query(
      `SELECT j.id AS job_id, j.title, c.name AS customer_name,
              c.street AS customer_street, c.city AS customer_city, c.state AS customer_state, c.zip AS customer_zip,
              c.lat, c.lng
       FROM jobs j
       LEFT JOIN customers c ON c.id = j.customer_id
       WHERE j.id = ANY($1::uuid[]) AND j.company_id = $2`,
      [job_ids, req.companyId]
    );
    const geocodedJobs = jobsResult.rows.filter((j) => j.lat != null && j.lng != null);
    if (geocodedJobs.length === 0) {
      return res.status(400).json({ error: "None of the selected stops have a geocoded address yet." });
    }

    const routeResult = await client.query(
      `INSERT INTO delivery_routes (company_id, route_date, employee_id, crew_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [req.companyId, date, employee_id || null, crew_id || null]
    );
    const routeId = routeResult.rows[0].id;

    // Insert in the given (as-scheduled) order first -- if optimization
    // fails below, the route is still usable, just unsorted.
    for (let i = 0; i < geocodedJobs.length; i++) {
      const job = geocodedJobs[i];
      await client.query(
        `INSERT INTO route_stops (route_id, job_id, sequence, lat, lng, address_label)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [routeId, job.job_id, i, job.lat, job.lng, addressLabel(job)]
      );
    }

    try {
      const stops = geocodedJobs.map((j) => ({ job_id: j.job_id, lat: j.lat, lng: j.lng }));
      const ordered = await optimizeStopOrder(shop.lat, shop.lng, stops);
      for (let i = 0; i < ordered.length; i++) {
        await client.query(`UPDATE route_stops SET sequence = $1 WHERE route_id = $2 AND job_id = $3`, [
          i, routeId, ordered[i].job_id,
        ]);
      }
      await client.query(`UPDATE delivery_routes SET status = 'optimized', optimized_at = now() WHERE id = $1`, [routeId]);
    } catch (optimizeErr) {
      console.error("Route optimization failed, leaving stops in scheduled order:", optimizeErr.message);
    }

    const route = await loadRouteDetail(routeId, req.companyId);
    res.status(201).json(route);
  } catch (err) {
    console.error("POST /admin/routing failed:", err);
    res.status(500).json({ error: err.message || "Couldn't build route." });
  }
});

// POST /api/admin/routing/:id/reoptimize
// Re-runs optimization on the route's current stop set (e.g. after
// removing one) without needing to rebuild the whole route from scratch.
router.post("/:id/reoptimize", async (req, res) => {
  try {
    const { id } = req.params;
    const owns = await db.query(`SELECT id FROM delivery_routes WHERE id = $1 AND company_id = $2`, [id, req.companyId]);
    if (owns.rowCount === 0) return res.status(404).json({ error: "Route not found" });

    const shop = await getShopLocation(req.companyId);
    if (!shop) return res.status(400).json({ error: "Shop location isn't set." });

    const stopsResult = await db.query(`SELECT job_id, lat, lng FROM route_stops WHERE route_id = $1 ORDER BY sequence`, [id]);
    if (stopsResult.rowCount === 0) return res.status(400).json({ error: "This route has no stops left." });

    const ordered = await optimizeStopOrder(shop.lat, shop.lng, stopsResult.rows);
    for (let i = 0; i < ordered.length; i++) {
      await db.query(`UPDATE route_stops SET sequence = $1 WHERE route_id = $2 AND job_id = $3`, [i, id, ordered[i].job_id]);
    }
    await db.query(`UPDATE delivery_routes SET status = 'optimized', optimized_at = now() WHERE id = $1`, [id]);

    const route = await loadRouteDetail(id, req.companyId);
    res.json(route);
  } catch (err) {
    console.error("POST /admin/routing/:id/reoptimize failed:", err);
    res.status(500).json({ error: err.message || "Couldn't re-optimize route." });
  }
});

// PATCH /api/admin/routing/:id/reorder
// Body: { stop_ids: [route_stop.id, ...] } -- the full list of this
// route's stop ids in the desired new order. Manual reordering doesn't
// call the optimizer again -- it's the admin's explicit override.
router.patch("/:id/reorder", async (req, res) => {
  try {
    const { id } = req.params;
    const { stop_ids } = req.body;
    if (!Array.isArray(stop_ids) || stop_ids.length === 0) return res.status(400).json({ error: "stop_ids is required" });

    const owns = await db.query(`SELECT id FROM delivery_routes WHERE id = $1 AND company_id = $2`, [id, req.companyId]);
    if (owns.rowCount === 0) return res.status(404).json({ error: "Route not found" });

    for (let i = 0; i < stop_ids.length; i++) {
      await db.query(`UPDATE route_stops SET sequence = $1 WHERE id = $2 AND route_id = $3`, [i, stop_ids[i], id]);
    }

    const route = await loadRouteDetail(id, req.companyId);
    res.json(route);
  } catch (err) {
    console.error("PATCH /admin/routing/:id/reorder failed:", err);
    res.status(500).json({ error: err.message || "Couldn't reorder stops." });
  }
});

// DELETE /api/admin/routing/:id/stops/:stopId
// Removes a single stop from the route (e.g. a job got cancelled). Doesn't
// re-optimize automatically -- call POST /:id/reoptimize afterward if
// desired.
router.delete("/:id/stops/:stopId", async (req, res) => {
  try {
    const { id, stopId } = req.params;
    const owns = await db.query(`SELECT id FROM delivery_routes WHERE id = $1 AND company_id = $2`, [id, req.companyId]);
    if (owns.rowCount === 0) return res.status(404).json({ error: "Route not found" });

    await db.query(`DELETE FROM route_stops WHERE id = $1 AND route_id = $2`, [stopId, id]);

    const route = await loadRouteDetail(id, req.companyId);
    res.json(route);
  } catch (err) {
    console.error("DELETE /admin/routing/:id/stops/:stopId failed:", err);
    res.status(500).json({ error: err.message || "Couldn't remove stop." });
  }
});

// DELETE /api/admin/routing/:id
router.delete("/:id", async (req, res) => {
  try {
    const result = await db.query(`DELETE FROM delivery_routes WHERE id = $1 AND company_id = $2`, [req.params.id, req.companyId]);
    if (result.rowCount === 0) return res.status(404).json({ error: "Route not found" });
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /admin/routing/:id failed:", err);
    res.status(500).json({ error: err.message || "Couldn't delete route." });
  }
});

module.exports = router;
