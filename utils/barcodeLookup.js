// Shared by routes/admin.js and routes/employeeInventory.js's lookup-barcode
// routes -- both call this after checking the company's own catalog_items
// and coming up empty, to suggest a name for a brand-new item.
//
// Tries Open Food Facts first: it's free, has no rate limit, and its
// database is far deeper for groceries/food items than UPCitemdb's free
// trial tier, which is generic-consumer-goods-oriented and rate-limited.
// Checking Open Food Facts first also means a food scan (likely to hit)
// never burns any of UPCitemdb's limited daily quota, saving that for the
// non-food items Open Food Facts won't have.
//
// Neither service will reliably know a trade/wholesale distributor's own
// barcodes (e.g. a hardware supplier's private SKU labels) -- those aren't
// published to consumer product databases at all. For those, a miss here
// just means the user types the name in once; it's saved to the company's
// own catalog from then on and never needs an external lookup again.
async function lookupExternalProductSuggestion(barcode) {
  try {
    const offResp = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json?fields=product_name,brands`,
      { headers: { Accept: "application/json" } }
    );
    if (offResp.ok) {
      const offData = await offResp.json();
      if (offData.status === 1 && offData.product && offData.product.product_name) {
        return { name: offData.product.product_name, brand: offData.product.brands || null };
      }
    }
  } catch (err) {
    console.error("Open Food Facts lookup failed (non-fatal):", err.message);
  }

  try {
    const upcResp = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(barcode)}`, {
      headers: { Accept: "application/json" },
    });
    if (upcResp.ok) {
      const upcData = await upcResp.json();
      const found = upcData.items && upcData.items[0];
      if (found) {
        return { name: found.title || found.brand || null, brand: found.brand || null };
      }
    }
  } catch (err) {
    console.error("UPC lookup failed (non-fatal):", err.message);
  }

  return null;
}

module.exports = { lookupExternalProductSuggestion };
