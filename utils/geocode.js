// Turns a plain street address into { lat, lng } using OpenStreetMap's free
// Nominatim search API -- no API key, no cost. Nominatim's usage policy
// (https://operations.osmfoundation.org/policies/nominatim/) requires: a
// real identifying User-Agent (not a stock http-library default), a max of
// 1 request/second, and that results get cached rather than re-fetched --
// which is exactly what callers of this function do (see routes/admin.js
// customer create/update, which only geocodes when the address actually
// changes and stores the result permanently on the customers row). This is
// meant for occasional, user-triggered single-address lookups (an admin
// adding/editing one customer at a time) -- not bulk or scheduled geocoding
// of an entire customer list, which the policy explicitly discourages.
//
// If you outgrow the 1 req/sec ceiling (a lot of customers being added at
// once, e.g. CSV import), don't parallelize calls to this function -- the
// queue below already serializes everything company-wide, but a large
// import will simply take a while. That's intentional.

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "CollTimeclock/1.0 (+https://collbusinesssolutions.com; scheduling route feature)";
const MIN_INTERVAL_MS = 1100; // stay safely under Nominatim's 1 req/sec cap

let queue = Promise.resolve();
let lastRequestAt = 0;

function enqueue(fn) {
  const run = queue.then(async () => {
    const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastRequestAt));
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
    return fn();
  });
  // Swallow errors here so one failed geocode doesn't wedge the shared
  // queue for every request queued behind it -- the real error still
  // propagates to whoever awaited `run` below.
  queue = run.catch(() => {});
  return run;
}

// Builds a single search string from the customer's address fields. Returns
// null if there's nothing usable to geocode (e.g. a customer with no
// street/city set yet).
function buildAddressQuery({ street, city, state, zip }) {
  const parts = [street, city, state, zip].map((p) => (p || "").trim()).filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
}

// Returns { lat, lng } or null (address missing, not found, or the request
// failed -- callers should treat null as "couldn't geocode this one" and
// move on rather than blocking whatever triggered it).
async function geocodeAddress(addressFields) {
  const query = typeof addressFields === "string" ? addressFields.trim() : buildAddressQuery(addressFields || {});
  if (!query) return null;

  return enqueue(async () => {
    try {
      const url = `${NOMINATIM_URL}?format=json&limit=1&q=${encodeURIComponent(query)}`;
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
      if (!res.ok) return null;
      const results = await res.json();
      if (!Array.isArray(results) || results.length === 0) return null;
      const { lat, lon } = results[0];
      const parsedLat = Number(lat);
      const parsedLng = Number(lon);
      if (!Number.isFinite(parsedLat) || !Number.isFinite(parsedLng)) return null;
      return { lat: parsedLat, lng: parsedLng };
    } catch (err) {
      console.error("geocodeAddress failed:", err.message);
      return null;
    }
  });
}

module.exports = { geocodeAddress, buildAddressQuery };
