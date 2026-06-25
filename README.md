# NetPix / CouchPix — monorepo

Group decision-making app: swipe with friends to pick a **movie** to watch or a
**restaurant** to order from. Product name is **CouchPix** (App Store); internal
infra still uses the `netpix` name (Vercel project, Worker, URLs).

## Layout

```
apps/
  web/        React + Vite SPA (the actual UI)        → Vercel
  mobile/     Capacitor iOS/Android shell (OTA-loads web)
services/
  api/        Cloudflare Worker — the backend          → Cloudflare
packages/     (reserved for shared code, e.g. ACTIVITIES / criteria shapes)
```

These three were previously separate repos (`netpix-app`, `netpix-mobile`,
`netpix-proxy`), now consolidated. Pre-consolidation history lives in those
archived GitHub repos.

## Deploy

Each piece deploys independently from its own directory:

```bash
# Frontend → Vercel (linked via apps/web/.vercel)
cd apps/web && npm run build && npx vercel deploy --prod

# Backend → Cloudflare (config in services/api/wrangler.json)
cd services/api && npx wrangler deploy

# Mobile → rebuild bundled web fallback + sync, then build in Xcode
cd apps/mobile && npm run sync   # build:web now points at ../web
```

The mobile shell OTA-loads `https://netpix-app.vercel.app`, so a web deploy
reaches phones without an App Store update.

## Secrets

Worker secrets are stored in Cloudflare, never in the repo:

```bash
cd services/api && npx wrangler secret put GOOGLE_PLACES_KEY
```

> TODO: `TMDB_KEY` / `OMDB_KEY` are still hardcoded in `services/api/src/index.js`
> — move them to Wrangler secrets.
