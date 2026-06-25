#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Google Places (New) spike for the food-delivery feature.
//
// Proves out, with ONE real searchText call:
//   • field coverage (how many restaurants actually have rating, photo,
//     description, hours, delivery/takeout flags, etc.)
//   • whether one call returns everything we need (no per-place Details calls)
//   • a realistic per-session cost estimate
//
// Usage:
//   GOOGLE_PLACES_KEY=xxx node spike/places-spike.mjs <zip> <cuisine> [radiusMeters]
// Example:
//   GOOGLE_PLACES_KEY=xxx node spike/places-spike.mjs 11201 pizza 5000
//
// ZIP → lat/lng uses the free, keyless zippopotam.us API (this is how the real
// feature would geocode too, via a bundled ZIP dataset — no Google cost).
// ─────────────────────────────────────────────────────────────────────────────

const KEY = process.env.GOOGLE_PLACES_KEY;
const [, , zip = "11201", cuisine = "restaurants", radiusArg] = process.argv;
const radius = Number(radiusArg) || 5000; // meters (~3.1 mi)

if (!KEY) {
  console.error("✗ Set GOOGLE_PLACES_KEY env var. See spike/README for how to get a key.");
  process.exit(1);
}

// Fields we'd want on a restaurant card. The mask drives which billing SKU tier
// applies — location/name/address are "Essentials", rating/types/hours are "Pro",
// delivery/takeout/editorialSummary are "Enterprise" (most expensive).
const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.location",
  "places.rating",
  "places.userRatingCount",
  "places.priceLevel",
  "places.primaryTypeDisplayName",
  "places.types",
  "places.googleMapsUri",
  "places.photos",
  "places.currentOpeningHours",
  "places.regularOpeningHours",
  "places.editorialSummary",
  "places.takeout",
  "places.delivery",
  "places.dineIn",
].join(",");

function haversineMiles(a, b) {
  const R = 3958.8, toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

async function geocodeZip(zip) {
  const r = await fetch(`https://api.zippopotam.us/us/${zip}`);
  if (!r.ok) throw new Error(`ZIP ${zip} not found (${r.status})`);
  const d = await r.json();
  const p = d.places[0];
  return { lat: Number(p.latitude), lng: Number(p.longitude), label: `${p["place name"]}, ${p["state abbreviation"]}` };
}

async function searchText(textQuery, center, radius) {
  const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": KEY,
      "X-Goog-FieldMask": FIELD_MASK,
    },
    body: JSON.stringify({
      textQuery,
      includedType: "restaurant",
      locationBias: { circle: { center: { latitude: center.lat, longitude: center.lng }, radius } },
      maxResultCount: 20,
    }),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(`Places error ${r.status}: ${JSON.stringify(body)}`);
  return body.places || [];
}

const pct = (n, total) => total ? `${Math.round((n / total) * 100)}%` : "—";

(async () => {
  console.log(`\n🔎 Spike: "${cuisine}" near ${zip}, radius ${(radius / 1609).toFixed(1)} mi\n`);

  const center = await geocodeZip(zip);
  console.log(`📍 ${zip} → ${center.label} (${center.lat}, ${center.lng}) [free keyless geocode]\n`);

  const t0 = Date.now();
  const places = await searchText(`${cuisine} near ${zip}`, center, radius);
  const ms = Date.now() - t0;
  console.log(`✅ 1 searchText call → ${places.length} restaurants in ${ms}ms\n`);

  if (!places.length) { console.log("No results — try a broader cuisine or larger radius."); return; }

  // Field coverage
  const n = places.length;
  const has = sel => places.filter(sel).length;
  const cov = {
    "rating": has(p => p.rating != null),
    "userRatingCount": has(p => p.userRatingCount != null),
    "photos": has(p => p.photos?.length),
    "editorialSummary (desc)": has(p => p.editorialSummary?.text),
    "currentOpeningHours": has(p => p.currentOpeningHours),
    "openNow flag": has(p => p.currentOpeningHours?.openNow != null),
    "regularOpeningHours.periods": has(p => p.regularOpeningHours?.periods?.length),
    "priceLevel": has(p => p.priceLevel != null),
    "primaryTypeDisplayName": has(p => p.primaryTypeDisplayName?.text),
    "takeout flag": has(p => p.takeout != null),
    "delivery flag": has(p => p.delivery != null),
    "googleMapsUri": has(p => p.googleMapsUri),
  };
  console.log("── Field coverage ─────────────────────────────");
  for (const [k, v] of Object.entries(cov)) {
    console.log(`  ${k.padEnd(30)} ${String(v).padStart(2)}/${n}  ${pct(v, n)}`);
  }

  // Sample cards
  console.log("\n── Sample restaurants ─────────────────────────");
  for (const p of places.slice(0, 5)) {
    const dist = haversineMiles(center, { lat: p.location.latitude, lng: p.location.longitude });
    console.log(`\n  ${p.displayName?.text}`);
    console.log(`    ${p.formattedAddress}  ·  ${dist.toFixed(1)} mi`);
    console.log(`    type: ${p.primaryTypeDisplayName?.text || "?"}`);
    console.log(`    google: ${p.rating ?? "—"} (${p.userRatingCount ?? 0} reviews)  price: ${p.priceLevel ?? "—"}`);
    console.log(`    openNow: ${p.currentOpeningHours?.openNow ?? "?"}  takeout: ${p.takeout ?? "?"}  delivery: ${p.delivery ?? "?"}`);
    console.log(`    desc: ${p.editorialSummary?.text ? '"' + p.editorialSummary.text.slice(0, 80) + '..."' : "— none —"}`);
    console.log(`    photo: ${p.photos?.[0]?.name ? "yes" : "no"}   maps: ${p.googleMapsUri ? "yes" : "no"}`);
  }

  // ── Photo check ──────────────────────────────────────────────────────────
  // A photo reference isn't an image yet — it needs a Photos API call. We use
  // skipHttpRedirect=true to get back the final googleusercontent URL (which has
  // NO api key in it), so the Worker can resolve it server-side and hand the
  // frontend a clean, key-less image URL. Then we verify that URL is a real image.
  console.log("\n── Photo check ────────────────────────────────");
  const photoName = places.find(p => p.photos?.[0]?.name)?.photos[0].name;
  if (!photoName) {
    console.log("  No photo reference found (unexpected).");
  } else {
    const mediaUrl = `https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=800&skipHttpRedirect=true`;
    const mr = await fetch(mediaUrl, { headers: { "X-Goog-Api-Key": KEY } });
    const mb = await mr.json();
    if (!mr.ok) { console.log(`  ✗ media call failed ${mr.status}: ${JSON.stringify(mb)}`); }
    else {
      const photoUri = mb.photoUri;
      console.log(`  resolved photoUri (key-less): ${photoUri ? photoUri.slice(0, 70) + "..." : "none"}`);
      // Confirm it actually loads as an image.
      const img = await fetch(photoUri);
      const ct = img.headers.get("content-type");
      const len = img.headers.get("content-length");
      console.log(`  image fetch: ${img.status} ${img.ok ? "OK" : "FAIL"}  content-type: ${ct}  ~${len ? Math.round(len/1024) : "?"}KB`);
      console.log(`  → ${img.ok && ct?.startsWith("image/") ? "✅ photos are usable on cards" : "⚠️  unexpected response"}`);
    }
  }

  // Cost estimate. Places API (New) bills per searchText call by the most expensive
  // SKU tier touched by the field mask. Our mask includes Enterprise-tier fields
  // (delivery/takeout/editorialSummary), so price at the Enterprise Text Search rate.
  // Pricing must be VERIFIED against current Google SKUs — these are 2025 ballparks.
  console.log("\n── Cost estimate (VERIFY current Google SKU pricing) ──");
  const TEXT_SEARCH_ENTERPRISE_PER_1K = 40; // $ per 1,000 calls, ballpark
  const perCall = TEXT_SEARCH_ENTERPRISE_PER_1K / 1000;
  console.log(`  1 call per session (Text Search, Enterprise tier): ~$${perCall.toFixed(3)}/session`);
  console.log(`  Photos billed separately only when fetched (~$7/1k images).`);
  console.log(`  With KV caching by (zip,cuisine,filters): most sessions cost $0.`);
  console.log(`  Free credit (~$200/mo historically) ≈ ${Math.floor(200 / perCall).toLocaleString()} uncached sessions/mo.\n`);
})().catch(e => { console.error("✗", e.message); process.exit(1); });
