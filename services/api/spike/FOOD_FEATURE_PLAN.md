# Food-delivery picker — implementation plan

Spike-validated (Seattle 98103, pizza): one `searchText` call returns 20 restaurants
in ~520ms with ~100% coverage on rating, photos, hours, open-now, takeout/delivery
flags, and Google Maps link; ~55% have an editorial description; ~$0.04/session
uncached, ~$0 cached. Photos need a separate Photos API call (verify with spike v2).

## Architecture: generalize the session by `type`

The session/swipe/vote/match/results engine is item-agnostic. Add `session.type`
(`"movie"` | `"food"`) and branch only at the edges:

- **Shared, untouched:** Worker KV session/profile storage, join/lobby, swipe deck,
  vote aggregation, super-like, review screen, results/match, save-for-later.
- **New/branched:**
  1. A mode picker on the home screen (Movie Night vs Food Run).
  2. A `FoodPreferencesScreen` (different fields than movies).
  3. A `RestaurantCard` renderer.
  4. A discover adapter: `discoverRestaurants(session)` → new Worker route.

### Key difference from movies: location is session-level
A group orders to ONE address. ZIP/distance is an **admin/session criteria**, not
per-participant. Store the admin's last-used ZIP in their profile for convenience.

## Worker: new `/restaurants` route (`src/index.js`)

```
GET /restaurants?zip=98103&cuisine=pizza&radius=8000&minRating=4
                &mode=delivery|takeout&openAt=now|HH:MM
```

Steps inside the Worker:
1. **Geocode ZIP → lat/lng** from a bundled ZIP-centroid dataset (no API cost).
2. **KV cache check** — key `food:{zip}:{cuisine}:{radius}` (raw Google results,
   TTL ~6h). On hit, skip Google entirely → $0 + instant.
3. **On miss:** one `places:searchText` call (POST, field mask) → cache raw result.
4. **Filter + shape server-side:** min rating, delivery/takeout flag, open-at-time
   (parse `regularOpeningHours.periods` with a buffer so "closes in 10 min" is
   excluded), compute distance, resolve one photo per place to a key-less
   `photoUri` (via `skipHttpRedirect=true`), strip to card fields.
5. Return a clean array the frontend maps to cards.

Field mask (from the working spike): `id, displayName, formattedAddress, location,
rating, userRatingCount, priceLevel, primaryTypeDisplayName, types, googleMapsUri,
photos, currentOpeningHours, regularOpeningHours, editorialSummary, takeout,
delivery, dineIn`.

**Secret:** `npx wrangler secret put GOOGLE_PLACES_KEY` → read as
`env.GOOGLE_PLACES_KEY`. (Also a good time to move the hardcoded `TMDB_KEY` to a
secret.)

## "Open at order time" logic (solves the closes-soon problem)

- `openAt=now` → require open now AND open for ≥ BUFFER minutes (e.g. 45) from now.
- `openAt=HH:MM` (same-day) → require the time falls inside a period AND ≥ BUFFER
  before that period's close.
- Parse `regularOpeningHours.periods` (100% coverage). Buffer is a tunable constant
  accounting for prep + delivery time.

## Food preferences screen (admin)

- **Delivery location** — ZIP input (prefilled from profile), saved on submit.
- **Cuisine** — chips (Pizza, Sushi, Thai, Mexican, Chinese, Indian, Burgers, …);
  maps to the `searchText` query term.
- **Order type** — Delivery + Takeout · Takeout only (all results have takeout min).
- **Min Google rating** — Any / 3.5+ / 4.0+ / 4.5+.
- **Distance** — radius slider/options (1 / 3 / 5 / 10 mi).
- **When** — "Order now" or a same-day time picker → drives the open-at logic.

Non-admin participants: no criteria (location is shared) — they go straight to the
swipe deck, same as movies.

## Restaurant card (`RestaurantCard`)

- **Photo** (key-less `photoUri`), graceful fallback to a cuisine emoji when absent.
- **Name** + **distance badge** (e.g. "0.8 mi").
- **Address**.
- **Cuisine** (`primaryTypeDisplayName`).
- **Google rating** ⭐ + review count; **price level** ($–$$$$) when present.
- **Yelp rating** — deferred to v2 (Yelp went paid/limited).
- **Description** (`editorialSummary`) when present (~55%); otherwise hide the block
  or fall back to cuisine + "Open now / closes at X".
- **Open status** — "Open now · closes 10pm" / "Opens 5pm".
- **Delivery/Takeout** chips from the flags.
- **"View on Google"** button → `googleMapsUri` (deep dive, photos, reviews).
- *(v2)* "Find on DoorDash / Uber Eats" deep-link buttons (search by name).

## ZIP → lat/lng dataset

Bundle a US ZIP-centroid JSON (~1–2 MB, ~33k zips) in the Worker, or a trimmed set.
Keyless, instant, offline. (Spike uses zippopotam.us live; production should bundle
to avoid a third-party dependency on the hot path.)

## Scope tiers

- **MVP:** everything above except Yelp and delivery-app deep-links. Google-only,
  cached, full filter set, reuse the session engine.
- **v2:** Yelp second rating, DoorDash/UberEats deep-links, save default food prefs
  to profile, "group is hungry now" presets.

## Decisions (locked)
1. **Cuisine** — fixed chip set (no free text).
2. **Distance** — default 5 mi, max 10.
3. **Order-time buffer** — must stay open **>45 min from the time of swiping**.
   - "Order now" → open AND closes ≥ now + 45 min.
   - Scheduled same-day time T → T ≥ now, open at T, closes ≥ T + 45 min.
4. **Home screen** — vertical list, top to bottom:
   - **Movie Night**
   - **Food Night**  ← new
   - subtitle heading **"Games"**
     - **Unhinged Questions** (moved here)
