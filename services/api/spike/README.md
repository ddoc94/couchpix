# Food-delivery feature — Places API spike

Goal: with **one real API call**, confirm (a) field coverage, (b) that a single
`searchText` returns everything a restaurant card needs, and (c) real per-session cost.

## Get a Google Places API key (~5 min, free credit included)

1. Go to <https://console.cloud.google.com/> and create a project (or pick one).
2. **APIs & Services → Library** → search **"Places API (New)"** → **Enable**.
   (Make sure it's the *New* one, not the legacy "Places API".)
3. **APIs & Services → Credentials → Create credentials → API key**. Copy it.
4. (Optional but recommended) Click the key → **Restrict key** → restrict to
   "Places API (New)" so it can't be abused if it leaks.
5. Billing must be enabled on the project, but Google includes a recurring free
   credit, so the spike itself should cost ~nothing.

## Run it

```bash
cd netpix-proxy
GOOGLE_PLACES_KEY=YOUR_KEY node spike/places-spike.mjs 11201 pizza
# args: <zip> <cuisine> [radiusMeters]   e.g. ... 90210 sushi 8000
```

Run it for **your own ZIP** and a few cuisines (pizza, sushi, thai, "burgers")
to see real coverage where your users actually are.

## What we're checking

- Does `delivery`/`takeout` come back populated, or mostly null? (drives the
  "delivery vs takeout" filter feasibility)
- How often is `editorialSummary` present? (drives the description field)
- Are `photos`, `rating`, `openNow`, `regularOpeningHours.periods` reliable?
- Actual latency + the per-session cost line at the bottom.

Throwaway — delete `spike/` once we've decided.
