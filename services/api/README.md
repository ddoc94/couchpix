# netpix-proxy

Cloudflare Worker backend for CouchPix. Despite the "proxy" name, this is
the full backend — it hides API keys, stores session & profile state in KV, and
powers movie + restaurant discovery with caching.

## What it does

- **Sessions & profiles** — `GET/PUT /session/:id`, `GET/PUT/DELETE /user/:key` (Cloudflare KV).
- **Movie discovery** — `/discover` (TMDB), `/videos` (trailer lookup), TMDB proxy passthrough.
- **Restaurant discovery** — `/restaurants` (Google Places New): union search across
  cuisines, veto exclusion, rating / order-type / price / open-at-time (+45-min buffer)
  filters, distance, key-less photo resolution. Results cached in KV.

## Layout

- `src/index.js` — the entire Worker.
- `wrangler.json` — config (account, KV namespace binding).
- `spike/` — throwaway Google Places spike + the food-feature plan.

## Secrets

Set as Wrangler secrets (never committed):

```bash
npx wrangler secret put GOOGLE_PLACES_KEY
```

> TODO: `TMDB_KEY` and `OMDB_KEY` are currently hardcoded in `src/index.js` — move
> them to Wrangler secrets too.

## Deploy

```bash
npx wrangler deploy
```

Live at `https://netpix-proxy.netpix2026.workers.dev`.
