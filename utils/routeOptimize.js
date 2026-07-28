// Computes the fastest order to visit a set of stops, starting and ending at
// the shop (a round trip), using OpenRouteService's free Optimization API
// (https://openrouteservice.org -- built on the open-source VROOM engine).
// Free tier: 2,500 requests/day / 40,000/month, no credit card required --
// plenty for a small business building a handful of routes a day. Requires
// a free API key signed up for at openrouteservice.org, set as ORS_API_KEY.
//
// Note: this optimizes for typical road distance/time, not live traffic --
// the free tier doesn't factor in real-time conditions. Once a stop order
// is picked, the actual turn-by-turn driving (once handed off to the real
// Google Maps app -- see buildGoogleMapsUrl below and routes/schedule.js /
// routes/routing.js) still benefits from Google's own live traffic data.
// Only the *order* of stops is traffic-blind, not the driving directions.

const ORS_OPTIMIZATION_URL = "https://api.openrouteservice.org/optimization";

// stops: [{ id, lat, lng }, ...] (any id type, just echoed back in the
// returned order). shopLat/shopLng: round-trip start and end point.
// Returns the same stop objects, reordered -- or throws if ORS_API_KEY
// isn't configured or the request fails, so callers can fall back to
// leaving stops in their original (as-scheduled) order instead of silently
// serving a wrong order.
async function optimizeStopOrder(shopLat, shopLng, stops) {
  if (!process.env.ORS_API_KEY) {
    throw new Error("ORS_API_KEY is not configured -- sign up for a free key at openrouteservice.org");
  }
  if (!Array.isArray(stops) || stops.length === 0) return [];
  // A single stop needs no optimization -- and ORS's optimizer requires at
  // least one job, so this also sidesteps an edge case there.
  if (stops.length === 1) return stops;

  const body = {
    jobs: stops.map((stop, i) => ({ id: i + 1, location: [stop.lng, stop.lat] })),
    vehicles: [
      {
        id: 1,
        profile: "driving-car",
        start: [shopLng, shopLat],
        end: [shopLng, shopLat],
      },
    ],
  };

  const res = await fetch(ORS_OPTIMIZATION_URL, {
    method: "POST",
    headers: {
      Authorization: process.env.ORS_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Route optimization failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const route = data.routes && data.routes[0];
  if (!route || !Array.isArray(route.steps)) {
    throw new Error("Route optimization returned no route");
  }

  // Steps include the vehicle's start/end depot legs too (type "start"/"end")
  // -- only "job" steps map back to an actual stop. `id` on a job step is
  // the 1-based index we assigned above.
  const ordered = route.steps
    .filter((step) => step.type === "job")
    .map((step) => stops[step.id - 1])
    .filter(Boolean);

  return ordered.length === stops.length ? ordered : stops;
}

// Builds a free, no-API-key Google Maps multi-stop directions URL (Google's
// documented URL scheme: https://developers.google.com/maps/documentation/urls) --
// opens the real Google Maps app/site with the given stops pre-loaded for
// turn-by-turn navigation, in this exact order. Costs nothing to use since
// it's just a link, not an API call.
function buildGoogleMapsUrl(origin, stops, destination) {
  const params = new URLSearchParams({
    api: "1",
    origin: `${origin.lat},${origin.lng}`,
    destination: `${destination.lat},${destination.lng}`,
    travelmode: "driving",
  });
  if (stops.length > 0) {
    params.set("waypoints", stops.map((s) => `${s.lat},${s.lng}`).join("|"));
  }
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

module.exports = { optimizeStopOrder, buildGoogleMapsUrl };
