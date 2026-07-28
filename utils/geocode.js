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

// Runs one rate-limited Nominatim search and returns { lat, lng } or null.
// Shared by every attempt in geocodeAddress below so they all funnel
// through the same 1-req/sec queue.
async function nominatimSearch(params) {
  return enqueue(async () => {
    try {
      const url = `${NOMINATIM_URL}?${params.toString()}`;
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
      console.error("geocodeAddress request failed:", err.message);
      return null;
    }
  });
}

// Returns { lat, lng } or null (address missing or unresolvable -- callers
// should treat null as "couldn't geocode this one" and move on rather than
// blocking whatever triggered it).
//
// Tries up to three ways to resolve an address before giving up, since a
// single free-text query is where most real-world misses come from:
//   1. Structured search (separate street/city/state/postalcode params) --
//      Nominatim's own docs recommend this over free text for a full
//      address; it's much less thrown off by abbreviations like "St." vs
//      "Street" than the single-string query below.
//   2. Free-text search (the original approach) -- catches cases indexed
//      differently than the structured fields above expect.
//   3. City/state/zip only, dropping the street -- OpenStreetMap's free
//      coverage is thinner than Google's for exact street numbers in small
//      or newer developments. An approximate (city-center) point still
//      lets a stop be routed to instead of blocking the whole route.
async function geocodeAddress(addressFields) {
  const fields = typeof addressFields === "string" ? null : addressFields || {};
  const freeTextQuery = typeof addressFields === "string" ? addressFields.trim() : buildAddressQuery(fields);
  if (!freeTextQuery) return null;

  if (fields && (fields.street || fields.city)) {
    const structuredParams = new URLSearchParams({ format: "json", limit: "1", countrycodes: "us" });
    if (fields.street) structuredParams.set("street", fields.street);
    if (fields.city) structuredParams.set("city", fields.city);
    if (fields.state) structuredParams.set("state", fields.state);
    if (fields.zip) structuredParams.set("postalcode", fields.zip);
    const structuredResult = await nominatimSearch(structuredParams);
    if (structuredResult) return structuredResult;
  }

  const freeTextResult = await nominatimSearch(new URLSearchParams({ format: "json", limit: "1", q: freeTextQuery }));
  if (freeTextResult) return freeTextResult;

  if (fields) {
    const cityQuery = [fields.city, fields.state, fields.zip].filter(Boolean).join(", ");
    if (cityQuery) {
      const cityResult = await nominatimSearch(new URLSearchParams({ format: "json", limit: "1", q: cityQuery }));
      if (cityResult) return cityResult;
    }
  }

  return null;
}

// Rough distance in miles between two lat/lng points -- plenty accurate for
// ranking nearby-vs-far suggestions against each other, not for anything
// that needs to be precise.
function roughMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Powers the predictive-text address dropdown on the Add/Edit Customer
// form: returns up to 5 candidate addresses (with lat/lng already attached)
// for a partial, in-progress query. Same free Nominatim endpoint and the
// same shared rate-limit queue as geocodeAddress above -- Nominatim's usage
// policy explicitly allows autocomplete-style use as long as the caller
// debounces keystrokes and stays within 1 request/second, which is exactly
// what this queue (MIN_INTERVAL_MS) and the frontend's debounce timer do
// together. Returns [] (never throws) on a too-short query or any failure,
// since a broken suggestion dropdown should never block typing an address
// in by hand.
//
// `bias` (optional { lat, lng }, typically the company's shop location) is
// used two ways: as a Nominatim `viewbox` to prefer results near it (without
// `bounded`, so a genuine exact match elsewhere still surfaces instead of
// being hidden), and again client-side to re-sort the results by distance --
// Nominatim's own relevance ranking is driven by place "importance"
// (population, notability), which has nothing to do with which of several
// same-named streets is actually near this business, so without a bias
// point a "Nectar Street" three states away can easily outrank the correct
// one a few miles from the shop. Results whose house number matches the
// query exactly are always pinned to the top, bias or not.
async function suggestAddresses(query, bias) {
  const trimmed = (query || "").trim();
  if (trimmed.length < 4) return [];

  return enqueue(async () => {
    try {
      const params = new URLSearchParams({
        format: "json",
        addressdetails: "1",
        limit: "8",
        countrycodes: "us",
        q: trimmed,
      });
      if (bias && Number.isFinite(bias.lat) && Number.isFinite(bias.lng)) {
        // Roughly a 60-mile-wide box around the shop -- wide enough to cover
        // a normal service area, narrow enough to meaningfully bias ranking.
        const d = 0.9;
        params.set("viewbox", `${bias.lng - d},${bias.lat + d},${bias.lng + d},${bias.lat - d}`);
      }
      const url = `${NOMINATIM_URL}?${params.toString()}`;
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
      if (!res.ok) return [];
      const results = await res.json();
      if (!Array.isArray(results)) return [];

      const queryHouseNumber = (trimmed.match(/^(\d+)/) || [])[1];

      const mapped = results
        .map((r) => {
          const addr = r.address || {};
          const street = [addr.house_number, addr.road].filter(Boolean).join(" ");
          const city = addr.city || addr.town || addr.village || addr.hamlet || addr.county || "";
          const lat = Number(r.lat);
          const lng = Number(r.lon);
          return {
            label: r.display_name,
            street,
            city,
            state: addr.state || "",
            zip: addr.postcode || "",
            lat,
            lng,
            houseNumberMatch: Boolean(queryHouseNumber) && addr.house_number === queryHouseNumber,
          };
        })
        .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));

      mapped.sort((a, b) => {
        if (a.houseNumberMatch !== b.houseNumberMatch) return a.houseNumberMatch ? -1 : 1;
        if (bias && Number.isFinite(bias.lat) && Number.isFinite(bias.lng)) {
          return roughMiles(bias.lat, bias.lng, a.lat, a.lng) - roughMiles(bias.lat, bias.lng, b.lat, b.lng);
        }
        return 0;
      });

      return mapped.slice(0, 5).map(({ houseNumberMatch, ...s }) => s);
    } catch (err) {
      console.error("suggestAddresses failed:", err.message);
      return [];
    }
  });
}

module.exports = { geocodeAddress, buildAddressQuery, suggestAddresses };
