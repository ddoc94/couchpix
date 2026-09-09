# CouchPix

**Swipe with friends to decide what to watch or where to eat.** CouchPix turns
the endless "what do you want to do?" / "I dunno, what do *you* want?" loop into
a two-minute group swipe. Everyone joins one session, swipes through options, and
the app tallies the votes into a pick the whole group is happy with.

Live at **[couchpix.com](https://couchpix.com)**.

> The product is **CouchPix**; the original codename **netpix** still names the
> infrastructure (Vercel project, Cloudflare Worker, URLs, iOS bundle id) and is
> kept on purpose — renaming it would break production.

## What it does

A CouchPix session is a shared, group decision:

1. **Someone starts a session** and picks the activity — **NetPix** (a movie) or
   **FoodPix** (a place to eat: dine-in, delivery, or takeout) — plus the ground
   rules (streaming services, or location and budget).
2. **Friends join** by link, code, or QR — no account required.
3. **Everyone swipes** through their own deck of options (right = yes, left = no).
4. **The app tallies the votes** into a winner and runners-up, ranked by
   agreement. If too many options tie, a quick "heart" round narrows it down. The
   group can override the top pick, and once anyone confirms, the session closes
   for everyone.

Two ways to run it:

- **Together** — everyone swipes live, at the same time.
- **Separately** — plan ahead: the host sets it up, shares the link, and everyone
  answers on their own schedule (up to a week). Results are ready when the last
  person finishes.

Movie data comes from **TMDB** (with **OMDb** for extra ratings); restaurants come
from **Google Places**. Recommendations are tuned to favor titles people
recognize and to balance the deck across the cuisines a group actually picked.

## How it's built

- **Frontend** — a React + Vite single-page app (the whole UI lives in
  `apps/web/src/movie-night.jsx`), deployed to **Vercel**.
- **Backend** — one **Cloudflare Worker** (`netpix-proxy`):
  - **Sessions** live in a **Durable Object** (SQLite-backed, strongly
    consistent), so every device sees joins and votes instantly.
  - **Profiles** live in **KV**.
  - It proxies **TMDB/OMDb** (movie discovery) and **Google Places**
    (restaurants), keeping the API keys server-side.
- **Mobile** — a thin **Capacitor** iOS shell that OTA-loads couchpix.com, so a
  web deploy reaches phones without shipping an App Store update.
- **Analytics** — GA4: a product funnel from client events, plus authoritative
  per-session events sent server-side via the Measurement Protocol.

## Repo layout

```
apps/
  web/        React + Vite SPA — the app            → Vercel
  mobile/     Capacitor iOS shell (OTA-loads web)   → App Store (manual)
services/
  api/        Cloudflare Worker — the backend       → Cloudflare
packages/     reserved for shared code
```

Consolidated from three former repos (`netpix-app`, `netpix-mobile`,
`netpix-proxy`); pre-consolidation history lives in those archived repos.

## Develop

```bash
cd apps/web
npm install
npm run dev        # Vite dev server (talks to the live Worker)
npm run build      # production build
npx vitest run     # unit tests
```

End-to-end tests (`apps/web/tests/e2e`, Playwright) run against the **live** site,
so deploy before running them.

## Deploy

Each piece ships independently from its own directory:

```bash
# Frontend → Vercel
cd apps/web && npm run build && npx vercel deploy --prod

# Backend → Cloudflare
cd services/api && npx wrangler deploy

# Mobile → sync the web bundle, then build in Xcode
cd apps/mobile && npm run sync
```

## Configuration

API keys are **Cloudflare Worker secrets** — never committed to the repo:

```bash
cd services/api
npx wrangler secret put TMDB_KEY          # themoviedb.org (v3 key)
npx wrangler secret put OMDB_KEY          # omdbapi.com
npx wrangler secret put GOOGLE_PLACES_KEY # Google Places (New)
npx wrangler secret put GA4_API_SECRET    # GA4 Measurement Protocol
```
