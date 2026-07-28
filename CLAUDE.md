# CLAUDE.md — CouchPix

Context and working conventions for this repo. Product name is **CouchPix**; the
legacy name **netpix** is still used everywhere in the infra (repo, Vercel project,
Cloudflare Worker, URLs, iOS bundle id) — keep it that way; renaming it breaks
production.

## What it is
A group decision app: swipe with friends to pick a **movie** (**NetPix**) or
somewhere to eat (**FoodPix** — dine-in, delivery, or takeout). Shared session
code/link → everyone swipes → picks are tallied into a winner + runners-up.
Sessions run **together** (live) or **separately** (async, see below).
A local party game **Bonding Questions** still exists in the code but is no
longer linked from home.

- Live: **https://couchpix.com** (apex; `www` 308s to it). The legacy
  `netpix-app.vercel.app` 308s to couchpix.com too, via `apps/web/vercel.json`.
- Worker: https://netpix-proxy.netpix2026.workers.dev
- Analytics: GA4 `G-G7QGK5CN1J` (gtag in `apps/web/index.html`).

## Layout (monorepo)
```
apps/web/    React + Vite SPA — the whole UI                 → Vercel
  src/movie-night.jsx   ~4,000 lines; the ENTIRE app is here
  src/utils.js          pure, testable helpers (rankFinalists, foodAgreedPool, …)
  src/utils.test.js     Vitest unit tests
  tests/e2e/            Playwright — runs against the LIVE site
  public/, scripts/generate-pwa-icons.mjs
apps/mobile/ Capacitor iOS shell — OTA-loads the live web URL → App Store (manual)
services/api/src/index.js   Cloudflare Worker                → Cloudflare
```

## Architecture
- **Frontend:** one big `movie-night.jsx`; screens driven by a `screen` state
  string; palette object `C`; type constants `FONT`/`SERIF`; line icons via the
  `<Ico>` component + `ICON_PATHS` (no emoji in UI — deliberate). Logo is
  `public/logo.svg` (vector-traced from the owner's art); `public/logo.png` is
  the raster master the PWA icon script builds from.
- **Worker (`netpix-proxy`):**
  - **Sessions → Durable Object** `SessionRoom` (SQLite-backed, strongly consistent).
    `GET/PUT/PATCH /session/:id`. **PATCH** = atomic per-participant merge wrapped in
    `blockConcurrencyWhile` (used by join + vote-submit to avoid lost-update races).
  - **Profiles → KV** (`SESSIONS`): `/user/:hash`.
  - **`/discover`** (TMDB) + OMDb enrichment (cached in KV, see Gotchas), `/videos`.
    Tuned to favor films people recognize: `vote_count.gte` 800 (falls back to 300
    if a narrow query would starve), a 70-min runtime floor, 45% of sessions sort by
    popularity. Sequels are pushed back — confirmed numbered/part sequels sort to the
    very end, franchise members get a strong random penalty (`isLikelySequel`).
  - **`/restaurants`** (Google Places New). `mode=dine_in|delivery|takeout`; dine-in
    accepts optional filters (`reservable, outdoorSeating, alcohol, goodForGroups,
    vegetarian, dogs, liveMusic, sports, dessert, kidsMenu, diningStyle=casual|formal`)
    which exclude only places Google explicitly marks as lacking the attribute, so
    sparse data doesn't empty the deck. Deck is **round-robin balanced across the
    picked cuisines** (a global top-10 by rating let one cuisine crowd out the rest),
    capped at 10, tagged `matchedCuisines`. Search results cache 6h under `food5:`
    — **bump that prefix whenever the field mask changes.**
  - **API keys are Worker secrets** (`TMDB_KEY` v3, `OMDB_KEY`, `GOOGLE_PLACES_KEY`) —
    read from `env`, NEVER hardcode. Writes go through `badBody()` (≤512KB, valid JSON).
- Client polls sessions via `useAdaptivePoll` (2–8s; lobby capped at 3s; **async
  prefs/waiting screens 30–60s** since nobody's watching live — the hook returns a
  `poke()` for instant refresh after a write).
- Mobile OTA-loads couchpix.com, so a web deploy reaches phones (no App Store push).

## Session model
`{ id, adminId, activity, participants:[{ id, name, votes, done, genres, vetoes,
passionPick, prefsDone, heart, cuisines }], criteria, movies|restaurants, started,
round, heartPool, heartRound, foodReady, savedMovies, asyncMode, expectedCount,
moviesGenerated }`. Codes match `[A-Z0-9]{4,10}`.

**Plan-ahead (async) sessions** (`asyncMode: true`): created already-`started`; the
admin answers FIRST (setup → straight to prefs, no lobby; the post-answer waiting
screen is the share surface with QR + link) via atomic PATCH (participant +
criteria); the link drops joiners straight into prefs (no lobby wait); deck
generation triggers on ANY device once
`participants.length >= expectedCount` and all `prefsDone` — a DO claim
(`POST /session/:id` `{claim}`, 120s freshness) elects exactly one generator, which
writes the deck via PATCH `set` (allowlisted top-level fields) so it can't clobber
concurrent joins. Async TTL is 7 days (live sessions 24h).

## Results logic
Winner + runners-up, ranked **hearts → rating → matched-criteria** (`rankFinalists`,
in utils.js, unit-tested). Agreement = unanimous or true majority (`> half`); none →
"No matches". Movies use genres for the criteria tiebreak, food uses cuisines.
Heart rounds narrow the agreed pool (>2 agreed triggers one), and differ by type:
- **Together (live)**: rounds repeat until ≤2 survive.
- **Separately (async)**: exactly ONE round — repeat rounds would each cost another
  day of waiting — then straight to the final ranking however many survive.
Either way the group can **promote a runner-up** to tonight's pick; the choice is
stored on the session (`chosenId`, via PATCH `set`) so everyone sees the same pick,
and it works signed-out.

## Palette `C` — "Matinee" (editorial daylight)
bg `#F3F2EF` (cool porcelain) · card `#fff` · border `#E4E2DC` (warm hairline) ·
accent `#2A3A5C` (deep ink-blue) · gold `#B0872F` (brass) · text `#1C222E` ·
muted `#727A88` · green `#3F6045` (forest) · red `#8C3A34` (brick).
Semantic colors are deliberately muted, not alarm-bright. Type: one sans (`FONT`)
for UI, serif (`SERIF`) reserved for the *Pix wordmarks, monospace only for
session codes.

## Workflow (owner wants the FULL pipeline, no asking)
Standing instruction: commit → push → open PR → **squash-merge** → deploy, without
pausing for confirmation. Per change:
1. Branch off `origin/main` (don't reuse merged branches).
2. Build/test, commit with trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
3. `gh pr create` → `gh pr merge --squash`.
4. Delete the remote branch with `git push origin --delete <branch>` — NOT
   `gh pr merge --delete-branch` (it fails: `main` is checked out in another worktree).
5. **Deploy only the piece whose deployable code changed**; skip deploys for
   behavior-neutral refactors, tests, or config.

- **Web → Vercel:** `cd apps/web && npm run build && npx vercel deploy --prod --yes`
- **Worker → Cloudflare:** `cd services/api && npx wrangler deploy`
- **Mobile:** manual Xcode build (not scriptable here).

## Verify
- `apps/web`: `npm run build`, `npx vitest run`.
- **E2E runs against the LIVE Vercel site + live Worker** — deploy FIRST, then
  `npx playwright test`; assertions on new UI must match what's deployed. Food,
  Bonding Questions, and heart-round flows are NOT covered by E2E.
- Worker: `wrangler deploy --dry-run` to validate; `wrangler dev --local` to test DO
  behavior before deploying.

## Gotchas
- **The owner's main checkout `/Users/danieldoctor/netpix` does not auto-pull** and
  can lag `origin/main` — update with `git merge --ff-only origin/main`. Claude works
  in a separate worktree under `.claude/worktrees/`.
- **Cloudflare KV is eventually consistent (~60s)** — that's why sessions use a DO.
  A DO read-modify-write is only atomic if wrapped in `blockConcurrencyWhile`.
- **TMDB key must be the v3 key** (32-hex, `?api_key=`), NOT the v4 Bearer token.
- **OMDb** free tier = 1,000 req/day; keys require email activation. Enrichment is
  cached in KV (`omdb:<imdb_id>`, 14d), so the daily budget only pays for movies
  not seen recently.
- `wrangler secret put NAME` reads the value (interactive/piped) and auto-redeploys.
- iOS caches home-screen icons (re-add the bookmark to refresh).
- Playwright: `form_input` can bypass React `onChange` — use real keystrokes; test
  session ids must be 4–10 chars; bash `wait` with no args also waits on backgrounded
  dev servers (capture specific PIDs).
- Don't commit temp screenshots — write to scratchpad and `rm`.

## Identity
Participants are identified by a **device id** (`mn_userid`, localStorage) — no login
required, which is what makes invite links work for anyone. When a user IS signed in,
their participant id becomes `u_<userKey first 12>` instead, so the same person is
recognized on any device they log in on (open the link on a laptop → resume your own
prefs/votes). Sessions that already know the device id keep using it, so signing in
mid-session doesn't fork a duplicate participant. The identity is always resolved
against the **fetched** session (`idFor(s)`), never React state, since on link entry
state hasn't loaded yet. Signed-in users also get their open-sessions list mirrored
to the profile so it follows them across devices.

## Open review items
- **No auth on sessions/profiles** — anyone with the code/hash can read/overwrite.
  Real fix = per-session write token (a design decision; acceptable for a casual app
  for now).
- ~48 pre-existing ESLint issues (mostly the intentional "freeze value in a ref"
  pattern); E2E coverage gaps for food/questions/heart-rounds.
