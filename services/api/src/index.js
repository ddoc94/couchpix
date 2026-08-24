// TMDB_KEY and OMDB_KEY are Worker secrets (set via `wrangler secret put`),
// read from `env` inside fetch() — never hardcode API keys in source.
const TMDB_BASE = "https://api.themoviedb.org/3";
const TMDB_IMG = "https://image.tmdb.org/t/p/w500";
const TMDB_BACKDROP = "https://image.tmdb.org/t/p/w780"; // 16:9 stills for the card header
const SESSION_TTL = 60 * 60 * 24;          // 24 hours (live "decide together now" sessions)
const ASYNC_SESSION_TTL = 60 * 60 * 24 * 7; // 7 days (plan-ahead sessions filled out over days)
const MAX_BODY_BYTES = 512 * 1024;         // cap on a stored session/profile blob (~10x real size)

// Guard a write body before storing it: enforce a size cap and require valid
// JSON. Returns an error Response to short-circuit with, or null if acceptable.
// (Sessions/profiles are stored under guessable keys with no auth, so we don't
// want to store attacker-controlled garbage or oversized blobs.)
function badBody(body) {
  if (body.length > MAX_BODY_BYTES) return json({ error: "payload too large" }, 413);
  try { JSON.parse(body); } catch { return json({ error: "invalid json" }, 400); }
  return null;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// Heuristic: is this movie a "later entry" in a franchise the viewer should arguably
// have seen the start of?
//
// Requires (a) TMDB says the movie is part of a collection, AND (b) one of:
//   - Roman numeral II+ in the title (Rocky II, Saw VII)
//   - "Part N" or "Chapter N" where N ≥ 2 (John Wick: Chapter 2 — but NOT Part 1)
//   - Trailing number where (title − number) ≈ the collection name. This rejects
//     "Big Hero 6" (collection: "Big Hero 6 Collection", number is intrinsic) and
//     accepts "Saw 6" (collection: "Saw Collection", number is the sequel index).
//
// Cases without a numeric/part marker ("Avengers: Endgame", "Empire Strikes Back",
// "Aliens") aren't flagged here, but they still belong to a TMDB collection, so the
// caller gives them the softer "franchise" penalty rather than the hard sequel tier.
function isLikelySequel(title, collection) {
  if (!collection?.name || !title) return false;

  // Roman II+ as a separate word PRECEDED by space (e.g., "Rocky II", "Saw X").
  // The leading-space requirement avoids hyphenated false positives like "X-Men"
  // (where a bare word-boundary regex matches the leading X).
  if (/\s(II|III|IV|V|VI|VII|VIII|IX|X|XI|XII)\b/.test(title)) return true;

  // "Part 2"+, "Chapter 2"+, "Volume 2"+ (negative lookahead skips Part 1 / Chapter I,
  // which are first halves of multi-part releases — viewers should start there).
  if (/\b(part|chapter|vol(?:ume)?)\s+(?!(?:1|I)\b)(\d+|II|III|IV|V|VI|VII)\b/i.test(title)) return true;

  // Trailing number: only counts as a sequel marker if removing it leaves the
  // collection name. "Saw 6" → "Saw" → matches series "Saw" → sequel.
  // "Big Hero 6" → "Big Hero" → does NOT match series "Big Hero 6" → not flagged.
  const trailing = title.match(/\s\d{1,2}\s*$/);
  if (trailing) {
    // Normalize a leading article so "Incredibles 2" matches "The Incredibles Collection".
    const norm = s => s.replace(/^the\s+/i, '').trim();
    const titleWithoutNum = norm(title.replace(/\s\d{1,2}\s*$/, '').trim().toLowerCase());
    const series = norm(collection.name.replace(/\s*Collection\s*$/i, '').trim().toLowerCase());
    return titleWithoutNum === series;
  }
  return false;
}

const GENRE_MAP = {
  Action: 28, Adventure: 12, Animation: 16, Comedy: 35, Crime: 80,
  Documentary: 99, Drama: 18, Fantasy: 14, Horror: 27, Mystery: 9648,
  Romance: 10749, "Sci-Fi": 878, Thriller: 53, Western: 37, Family: 10751,
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    // API keys come from Worker secrets, not source.
    const TMDB_KEY = env.TMDB_KEY;
    const OMDB_KEY = env.OMDB_KEY;

    const url = new URL(request.url);

    // ── Metrics (gated) ──
    // Owner-only account stats. Gated by the METRICS_KEY secret so the numbers
    // aren't public (the repo is). Derived from stored profiles (key user-<hash>,
    // each carries createdAt + a sessions history array). Reads every profile, so
    // it's a heavier call — fine at current scale; revisit if accounts grow large.
    if (url.pathname === "/metrics") {
      if (!env.METRICS_KEY) return json({ error: "not found" }, 404);
      if (url.searchParams.get("key") !== env.METRICS_KEY) return json({ error: "unauthorized" }, 401);
      let cursor, accounts = 0, totalSavedSessions = 0;
      const signupsByMonth = {};
      do {
        const list = await env.SESSIONS.list({ prefix: "user-", cursor, limit: 1000 });
        for (const k of list.keys) {
          accounts++;
          const p = await env.SESSIONS.get(k.name, "json");
          if (!p) continue;
          const m = p.createdAt ? new Date(p.createdAt).toISOString().slice(0, 7) : "unknown";
          signupsByMonth[m] = (signupsByMonth[m] || 0) + 1;
          if (Array.isArray(p.sessions)) totalSavedSessions += p.sessions.length;
        }
        cursor = list.list_complete ? null : list.cursor;
      } while (cursor);
      return json({ accounts, signupsByMonth, totalSavedSessions, generatedAt: new Date().toISOString() });
    }

    // ── User Profile API ──
    // Keyed by a SHA-256 hash of the email (first 24 hex chars) so we never store
    // the raw email as a KV key. The email is NOT kept in the body either (see the
    // PUT handler, which strips it) — it lives only on the user's own device.
    const profileMatch = url.pathname.match(/^\/user\/([a-f0-9]{8,64})$/i);
    if (profileMatch) {
      const userKey = "user-" + profileMatch[1].toLowerCase();
      if (request.method === "GET") {
        const val = await env.SESSIONS.get(userKey);
        if (!val) return json({ error: "not found" }, 404);
        return new Response(val, { headers: { "Content-Type": "application/json", ...CORS } });
      }
      if (request.method === "PUT") {
        const body = await request.text();
        const bad = badBody(body);
        if (bad) return bad;
        // Strip the raw email before storing. The profile is keyed by a hash of the
        // email, so an email is guessable → readable; never keep the plaintext at
        // rest where a read could harvest it. Done server-side so it holds even for
        // an old/rogue client that still sends it. (The email lives only on the
        // user's own device.) badBody already confirmed the body parses.
        const obj = JSON.parse(body);
        if (obj && typeof obj === "object" && !Array.isArray(obj)) delete obj.email;
        // No expiration — accounts are permanent. A TTL here previously deleted
        // profiles after 90 idle days while the user's device still showed them
        // "logged in" (localStorage), which silently loses real accounts.
        await env.SESSIONS.put(userKey, JSON.stringify(obj));
        return json({ ok: true });
      }
      if (request.method === "DELETE") {
        await env.SESSIONS.delete(userKey);
        return json({ ok: true });
      }
      return json({ error: "method not allowed" }, 405);
    }

    // ── Session API ──
    // Sessions live in a Durable Object (one instance per session id) instead of
    // KV. KV is eventually consistent — reads are cached per-edge for up to ~60s,
    // so a participant joining from a different POP wouldn't show up on the admin's
    // device for tens of seconds. A DO is strongly consistent and single-instance,
    // so every device sees writes immediately.
    const sessionMatch = url.pathname.match(/^\/session\/([A-Z0-9]{4,10})$/i);
    if (sessionMatch) {
      const id = sessionMatch[1].toUpperCase();
      // GET (read) / PUT (full write) / PATCH (atomic partial merge) /
      // POST (atomic named claim — used to elect one device for deck generation).
      if (!["GET", "PUT", "PATCH", "POST"].includes(request.method)) {
        return json({ error: "method not allowed" }, 405);
      }
      const stub = env.SESSION_ROOM.get(env.SESSION_ROOM.idFromName(id));
      return stub.fetch(request);
    }

    // ── Movie Discovery ──
    if (url.pathname === "/discover") {
      const genreNames = (url.searchParams.get("genres") || "").split(",").filter(Boolean);
      const vetoNames = (url.searchParams.get("veto_genres") || "").split(",").filter(Boolean);
      const duration = url.searchParams.get("duration"); // "short" | "long" | ""
      const languages = (url.searchParams.get("languages") || "en").split(",").filter(Boolean);
      const yearFrom = parseInt(url.searchParams.get("year_from")) || 1980;
      const yearTo = parseInt(url.searchParams.get("year_to")) || new Date().getFullYear();
      const allowedRatings = (url.searchParams.get("allowed_ratings") || "").split(",").filter(Boolean);
      // Movies the caller has already watched in past sessions — filter them out
      const excludeIds = new Set(
        (url.searchParams.get("exclude_ids") || "")
          .split(",")
          .map(s => parseInt(s, 10))
          .filter(n => Number.isFinite(n))
      );

      const genreIds = genreNames.map(g => GENRE_MAP[g]).filter(Boolean).join("|");
      // Vetoes use comma (AND-NOT) in TMDB: without_genres=27,10749 excludes either
      const vetoIds = vetoNames.map(g => GENRE_MAP[g]).filter(Boolean).join(",");
      const langQuery = languages.join("|");

      // Sort mix: ~45% of sessions sort by popularity (surfaces well-known / trending /
      // recent films — "stuff a group has actually heard of"); the rest sort by rating
      // across a wide page range so the accessible pool rotates instead of repeating the
      // same top-100. Popularity uses a shallow page range (the genuinely popular films);
      // rating goes deeper.
      const usePopularity = Math.random() < 0.45;
      const sortBy = usePopularity ? "popularity.desc" : "vote_average.desc";
      const maxPage = usePopularity ? 8 : 18;

      const page1 = Math.floor(Math.random() * maxPage) + 1;
      let page2;
      do { page2 = Math.floor(Math.random() * maxPage) + 1; } while (page2 === page1);

      // voteCount is the "how well-known" floor — the biggest lever against the obscure
      // indie long tail. A high floor (~800 votes) keeps the pool to movies a group would
      // recognize; we relax it only if the strict filters leave too few candidates.
      async function fetchPage(page, withDuration, voteCount) {
        let q = `${TMDB_BASE}/discover/movie?api_key=${TMDB_KEY}&sort_by=${sortBy}&vote_count.gte=${voteCount}&vote_average.gte=6.0&language=en-US&page=${page}`;
        if (genreIds) q += `&with_genres=${genreIds}`;
        if (vetoIds) q += `&without_genres=${vetoIds}`;
        q += `&with_original_language=${langQuery}`;
        q += `&primary_release_date.gte=${yearFrom}-01-01`;
        q += `&primary_release_date.lte=${yearTo}-12-31`;
        // Honor an explicit short/long preference; otherwise floor at 70 min so short
        // films and featurettes (not the "movie night" goal) are excluded.
        if (withDuration && duration === "short") q += "&with_runtime.lte=120&with_runtime.gte=60";
        else if (withDuration && duration === "long") q += "&with_runtime.gte=121";
        else q += "&with_runtime.gte=70";
        if (allowedRatings.length) {
          const CERT_ORDER = ["G", "PG", "PG-13", "R"];
          const min = CERT_ORDER.find(r => allowedRatings.includes(r));
          const max = [...CERT_ORDER].reverse().find(r => allowedRatings.includes(r));
          q += `&certification_country=US`;
          if (min) q += `&certification.gte=${encodeURIComponent(min)}`;
          if (max) q += `&certification.lte=${encodeURIComponent(max)}`;
        }
        const res = await fetch(q);
        const data = await res.json();
        return data.results || [];
      }

      function dedupe(arr) {
        const seen = new Set();
        return arr.filter(m => seen.has(m.id) ? false : seen.add(m.id));
      }

      // Two pages in parallel doubles the candidate pool. Progressive relaxation so narrow
      // queries still fill a deck: strict first, then drop the duration constraint, then
      // lower the well-known floor. Worst case 6 discover + 40 enrichment subrequests (< 50).
      const HI_VOTES = 800, LO_VOTES = 300;
      const bothPages = async (withDur, votes) =>
        dedupe((await Promise.all([fetchPage(page1, withDur, votes), fetchPage(page2, withDur, votes)])).flat());

      let results = await bothPages(true, HI_VOTES);
      if (results.length < 12 && duration) results = await bothPages(false, HI_VOTES);
      if (results.length < 12) results = await bothPages(false, LO_VOTES);

      // Hard-filter by language before enrichment — cheaper than post-filtering and immune
      // to races where the client sends stale criteria. TMDB's with_original_language param
      // is used as a hint only; this is the authoritative check.
      results = results.filter(m => languages.includes(m.original_language));

      // Drop any movies the caller has already watched, before we spend subrequests on enrichment
      if (excludeIds.size) {
        results = results.filter(m => !excludeIds.has(m.id));
      }

      // Shuffle so repeated sessions on the same page get different ordering
      results.sort(() => Math.random() - 0.5);
      const top = results.slice(0, 20);

      const enriched = await Promise.all(top.map(async (m) => {
        try {
          // Fetch TMDB detail first — imdb_id is included in the response
          const detailRes = await fetch(`${TMDB_BASE}/movie/${m.id}?api_key=${TMDB_KEY}&append_to_response=credits&language=en-US`);
          const detail = await detailRes.json();

          // Use imdb_id from detail to call OMDB (no separate external_ids call needed).
          // OMDb answers (RT score, MPAA rating, director, awards) barely change, and the
          // free key allows only 1,000 calls/day — which caps deck generation at ~50/day
          // uncached. Cache each movie's answer in KV for 14 days so the daily budget is
          // only spent on movies we've never seen; popular films (which the discovery bias
          // deliberately favors) hit the cache almost every time.
          let omdb = null;
          if (detail.imdb_id) {
            const omdbCacheKey = `omdb:${detail.imdb_id}`;
            omdb = await env.SESSIONS.get(omdbCacheKey, "json");
            if (!omdb) {
              const omdbRes = await fetch(`https://www.omdbapi.com/?i=${detail.imdb_id}&apikey=${OMDB_KEY}`);
              omdb = await omdbRes.json();
              // Only cache real answers — never pin an error/rate-limit response for 2 weeks.
              if (omdb?.Response === "True") {
                await env.SESSIONS.put(omdbCacheKey, JSON.stringify(omdb), { expirationTtl: 60 * 60 * 24 * 14 });
              }
            }
          }

          let rt = null, mpaa = null, director = null, awards = null, imdbScore = null;
          if (omdb?.Response === "True") {
            const rtRating = omdb.Ratings?.find(r => r.Source === "Rotten Tomatoes");
            rt = rtRating ? parseInt(rtRating.Value) : null;
            mpaa = omdb.Rated && omdb.Rated !== "N/A" ? omdb.Rated : null;
            director = omdb.Director && omdb.Director !== "N/A" ? omdb.Director : null;
            awards = omdb.Awards && omdb.Awards !== "N/A" && omdb.Awards !== "N/A." ? omdb.Awards : null;
            imdbScore = omdb.imdbRating && omdb.imdbRating !== "N/A" ? parseFloat(omdb.imdbRating) : null;
          }

          const cast = (detail.credits?.cast || []).slice(0, 5).map(a => a.name);
          const genres = (detail.genres || []).map(g => g.name === "Science Fiction" ? "Sci-Fi" : g.name);

          // belongs_to_collection is already in the TMDB detail response — no extra fetch.
          const title = detail.title || m.title;

          // Sequel bias signals: a confirmed numbered/part sequel is tiered to the back;
          // a film that merely belongs to a franchise (unmarked sequels like "Aliens" AND
          // franchise originals) gets a mild penalty so standalones surface first.
          // franchisePen 0.7 → a franchise film only beats a standalone in ~5% of
          // head-to-heads, so standalones fill the deck first and franchise entries
          // (including subtitle sequels like "…: Civil War") mostly fill leftover slots.
          const collection = detail.belongs_to_collection;
          const confirmedSeq = isLikelySequel(title, collection) ? 1 : 0;
          const franchisePen = (collection?.name && !confirmedSeq) ? 0.7 : 0;

          return {
            id: m.id,
            title,
            year: m.release_date ? parseInt(m.release_date.slice(0, 4)) : null,
            genres,
            description: m.overview || "",
            actors: cast,
            duration: detail.runtime || 0,
            imdb: imdbScore ?? parseFloat((m.vote_average || 0).toFixed(1)),
            rt,
            mpaa,
            director,
            awards,
            poster: m.poster_path ? `${TMDB_IMG}${m.poster_path}` : null,
            // 16:9 backdrop — the card's trailer header falls back to this (matching
            // the trailer's aspect ratio) when a movie has no trailer or the YouTube
            // thumbnail is missing, instead of cropping the portrait poster.
            backdrop: (m.backdrop_path || detail.backdrop_path)
              ? `${TMDB_BACKDROP}${m.backdrop_path || detail.backdrop_path}` : null,
            streaming: [],
            color: "#1a1a24",
            _confirmedSeq: confirmedSeq, // stripped before return
            _franchisePen: franchisePen,
          };
        } catch {
          return null;
        }
      }));

      const vetoSet = new Set(vetoNames);
      // Hard-filter to enforce duration + veto constraints — TMDB's discover filters are fuzzy
      const finalMovies = enriched.filter(m => {
        if (!m) return false;
        // Veto check: drop the movie if any of its genres is on the veto list
        if (vetoSet.size && (m.genres || []).some(g => vetoSet.has(g))) return false;
        if (!duration) return true;
        if (!m.duration) return true; // no runtime data — keep it
        if (duration === "short") return m.duration <= 120;
        if (duration === "long")  return m.duration >= 121;
        return true;
      });

      // Strong bias against sequels. Tier 1: confirmed numbered/part sequels sort strictly
      // to the back — they only make the deck if there aren't enough other films to fill
      // it. Tier 2 (within the rest): a mild random penalty for franchise films so
      // standalones surface first. Client takes the first 10.
      finalMovies.sort((a, b) =>
        (a._confirmedSeq - b._confirmedSeq) ||
        ((Math.random() + a._franchisePen) - (Math.random() + b._franchisePen))
      );
      // Strip the internal hints — clients don't need to see them.
      finalMovies.forEach(m => { delete m._confirmedSeq; delete m._franchisePen; });

      return json(finalMovies);
    }

    // ── Trailer lookup ──
    if (url.pathname === "/videos") {
      const movieId = url.searchParams.get("id");
      if (!movieId) return json({ error: "missing id" }, 400);
      const res = await fetch(`${TMDB_BASE}/movie/${movieId}/videos?api_key=${TMDB_KEY}&language=en-US`);
      const data = await res.json();
      const results = data.results || [];
      const trailer = results.find(v => v.type === "Trailer" && v.site === "YouTube")
        || results.find(v => v.site === "YouTube");
      return json({ key: trailer?.key || null });
    }

    // ── Restaurant discovery (food-night feature) ──
    // Each participant picks up to 3 cuisines + 1 veto (mirrors movie genres). We
    // search the UNION of picked cuisines (one Places searchText per cuisine, each
    // cached 6h by (zip,cuisine,radius) so most sessions cost $0), merge+dedupe, then
    // filter by veto / rating / order-type / open-at-time server-side per request.
    //   GET /restaurants?zip=98103&cuisines=pizza,sushi&vetoCuisines=indian
    //                   &radius=8000&minRating=4&mode=delivery|takeout|dine_in&day=2&minute=1170
    // day (0=Sun..6=Sat) + minute (0..1439) are the intended ORDER/DINING time in the
    // user's local timezone (the browser sends them; the group is local to the ZIP).
    // mode=dine_in filters by dineIn and accepts optional narrowing flags:
    //   &reservable=1 &outdoorSeating=1 &alcohol=1 &goodForGroups=1 &vegetarian=1
    //   &dogs=1 &liveMusic=1 &sports=1 &dessert=1 &kidsMenu=1 &diningStyle=casual|formal
    if (url.pathname === "/restaurants") {
      const key = env.GOOGLE_PLACES_KEY;
      if (!key) return json({ error: "GOOGLE_PLACES_KEY not configured" }, 500);

      const zip = (url.searchParams.get("zip") || "").trim();
      const cuisineList = (url.searchParams.get("cuisines") || url.searchParams.get("cuisine") || "restaurants")
        .split(",").map(s => s.trim()).filter(Boolean).slice(0, 6);
      const vetoList = (url.searchParams.get("vetoCuisines") || "")
        .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
      const priceList = (url.searchParams.get("prices") || "")
        .split(",").map(s => s.trim()).filter(Boolean); // e.g. ["$","$$"] — empty = no constraint
      const PRICE_LABEL = {
        PRICE_LEVEL_INEXPENSIVE: "$", PRICE_LEVEL_MODERATE: "$$",
        PRICE_LEVEL_EXPENSIVE: "$$$", PRICE_LEVEL_VERY_EXPENSIVE: "$$$$",
      };
      const radius = Math.min(Math.max(parseInt(url.searchParams.get("radius")) || 8000, 500), 50000);
      const minRating = parseFloat(url.searchParams.get("minRating")) || 0;
      const modeParam = url.searchParams.get("mode");
      const mode = modeParam === "delivery" ? "delivery" : modeParam === "dine_in" ? "dine_in" : "takeout";
      // Optional dine-in narrowing filters (only meaningful when mode === "dine_in").
      const on = (k) => url.searchParams.get(k) === "1";
      const wantReservable = on("reservable");
      const wantOutdoor = on("outdoorSeating");
      const wantAlcohol = on("alcohol");
      const wantGroups = on("goodForGroups");
      const wantVegetarian = on("vegetarian");
      const wantDogs = on("dogs");
      const wantLiveMusic = on("liveMusic");
      const wantSports = on("sports");
      const wantDessert = on("dessert");
      const wantKidsMenu = on("kidsMenu");
      const diningStyle = ["casual", "formal"].includes(url.searchParams.get("diningStyle"))
        ? url.searchParams.get("diningStyle") : null;
      const day = url.searchParams.has("day") ? parseInt(url.searchParams.get("day")) : null;
      const minute = url.searchParams.has("minute") ? parseInt(url.searchParams.get("minute")) : null;
      const BUFFER = 45; // minutes the place must stay open past the order time

      if (!/^\d{5}$/.test(zip)) return json({ error: "valid 5-digit zip required" }, 400);

      // 1) Geocode ZIP (keyless, free). Cache the centroid too.
      let center = await env.SESSIONS.get(`geo:${zip}`, "json");
      if (!center) {
        const gr = await fetch(`https://api.zippopotam.us/us/${zip}`);
        if (!gr.ok) return json({ error: `zip ${zip} not found` }, 404);
        const gd = await gr.json();
        const p = gd.places[0];
        center = { lat: Number(p.latitude), lng: Number(p.longitude), label: `${p["place name"]}, ${p["state abbreviation"]}` };
        await env.SESSIONS.put(`geo:${zip}`, JSON.stringify(center), { expirationTtl: 60 * 60 * 24 * 30 });
      }

      // 2) Union search across the picked cuisines, each cached 6h by (zip,cuisine,radius).
      const FIELD_MASK = [
        "places.id", "places.displayName", "places.formattedAddress", "places.location",
        "places.rating", "places.userRatingCount", "places.priceLevel", "places.priceRange",
        "places.primaryTypeDisplayName", "places.primaryType", "places.types",
        "places.googleMapsUri", "places.websiteUri", "places.photos",
        "places.currentOpeningHours", "places.regularOpeningHours",
        "places.editorialSummary", "places.takeout", "places.delivery", "places.dineIn",
        "places.reservable", "places.outdoorSeating", "places.menuForChildren",
        "places.servesBeer", "places.servesWine", "places.servesCocktails",
        "places.goodForGroups", "places.servesVegetarianFood", "places.allowsDogs",
        "places.liveMusic", "places.goodForWatchingSports", "places.servesDessert",
      ].join(",");
      const byId = new Map();
      const matchedBy = new Map(); // place id -> Set of picked cuisines that surfaced it
      for (const cuisine of cuisineList) {
        // Cache version tracks the field mask — bump the prefix whenever the mask
        // changes so old rows (missing the new atmosphere fields) aren't reused.
        const cacheKey = `food5:${zip}:${cuisine.toLowerCase()}:${radius}`;
        let pl = await env.SESSIONS.get(cacheKey, "json");
        if (!pl) {
          const pr = await fetch("https://places.googleapis.com/v1/places:searchText", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": FIELD_MASK },
            body: JSON.stringify({
              textQuery: `${cuisine} near ${zip}`,
              includedType: "restaurant",
              locationBias: { circle: { center: { latitude: center.lat, longitude: center.lng }, radius } },
              maxResultCount: 20,
            }),
          });
          const pb = await pr.json();
          if (!pr.ok) return json({ error: "places error", detail: pb }, 502);
          pl = pb.places || [];
          await env.SESSIONS.put(cacheKey, JSON.stringify(pl), { expirationTtl: 60 * 60 * 6 });
        }
        // Tag each place with the cuisine(s) whose search returned it, so the app
        // can rank by how many of a group's picked cuisines a spot matches.
        for (const p of pl) {
          if (!p.id) continue;
          if (!byId.has(p.id)) byId.set(p.id, p);
          if (!matchedBy.has(p.id)) matchedBy.set(p.id, new Set());
          matchedBy.get(p.id).add(cuisine);
        }
      }
      const places = [...byId.values()];

      // Exclude places whose type matches any vetoed cuisine.
      const vetoMatch = (p) => {
        if (!vetoList.length) return false;
        const t = (p.primaryTypeDisplayName?.text || "").toLowerCase();
        return vetoList.some(v => t.includes(v));
      };

      // 3) Filter by rating, order-type, and open-at-order-time (+buffer).
      const openAtTime = (periods) => {
        if (day == null || minute == null) return true; // no time filter
        if (!periods?.length) return true;               // keep if hours unknown
        const target = day * 1440 + minute;
        for (const per of periods) {
          if (!per.open || !per.close) continue;
          let openMin = per.open.day * 1440 + (per.open.hour * 60 + per.open.minute);
          let closeMin = per.close.day * 1440 + (per.close.hour * 60 + per.close.minute);
          if (closeMin <= openMin) closeMin += 7 * 1440; // wraps past week end
          for (const shift of [0, 7 * 1440]) {           // also test the prior week's wrap
            const o = openMin - shift, c = closeMin - shift;
            if (target >= o && target < c && (c - target) >= BUFFER) return true;
          }
        }
        return false;
      };

      // Alcohol = beer OR wine OR cocktails. true if any known-true; false only if
      // all three are known-false; null when Google has no data on any of them.
      const servesAlcohol = (p) => {
        const v = [p.servesBeer, p.servesWine, p.servesCocktails];
        if (v.some(x => x === true)) return true;
        if (v.every(x => x === false)) return false;
        return null;
      };

      // Dining style from Google's venue TYPES (not service-option types like
      // meal_takeaway, which sit-down places also carry). Quick / counter-serve →
      // "casual"; anything else is treated as table-service ("sit-down", up to formal).
      const QUICK_TYPES = new Set([
        "fast_food_restaurant", "cafe", "coffee_shop", "coffee_stand", "food_court",
        "sandwich_shop", "hamburger_restaurant", "donut_shop", "cafeteria", "bakery",
        "ice_cream_shop", "tea_house", "bagel_shop", "juice_shop",
      ]);
      const isQuickService = (p) => {
        const types = [p.primaryType, ...(p.types || [])].filter(Boolean);
        return types.some(t => QUICK_TYPES.has(t));
      };

      const filtered = places.filter(p => {
        if (mode === "dine_in") {
          if (p.dineIn !== true) return false;                // must offer dine-in
          // Optional narrowing: only exclude a place when Google explicitly says it
          // LACKS the attribute — keep unknowns so the deck doesn't collapse.
          if (wantReservable && p.reservable === false) return false;
          if (wantOutdoor && p.outdoorSeating === false) return false;
          if (wantAlcohol && servesAlcohol(p) === false) return false;
          if (wantGroups && p.goodForGroups === false) return false;
          if (wantVegetarian && p.servesVegetarianFood === false) return false;
          if (wantDogs && p.allowsDogs === false) return false;
          if (wantLiveMusic && p.liveMusic === false) return false;
          if (wantSports && p.goodForWatchingSports === false) return false;
          if (wantDessert && p.servesDessert === false) return false;
          if (wantKidsMenu && p.menuForChildren === false) return false;
          // Dining style: casual keeps only quick/counter-serve; formal keeps only
          // table-service (sit-down and up). Unknown/typeless places count as table-service.
          if (diningStyle === "casual" && !isQuickService(p)) return false;
          if (diningStyle === "formal" && isQuickService(p)) return false;
        } else {
          if (p.takeout !== true) return false;               // takeout/delivery must offer takeout
          if (mode === "delivery" && p.delivery !== true) return false;
        }
        if (minRating && (p.rating ?? 0) < minRating) return false;
        if (vetoMatch(p)) return false;
        // Price filter — only when narrowed. Keep places with unknown price (~20%).
        if (priceList.length) {
          const label = PRICE_LABEL[p.priceLevel];
          if (label && !priceList.includes(label)) return false;
        }
        if (!openAtTime(p.regularOpeningHours?.periods)) return false;
        return true;
      });

      // Balance the deck across the picked cuisines rather than taking a global top-10 by
      // rating — otherwise one cuisine whose spots happen to rate higher (e.g. Mediterranean)
      // crowds out the others (e.g. American). Build a per-cuisine bucket (a place can be in
      // several, since a search can surface it under multiple cuisines), sort each by rating,
      // then round-robin: take turns pulling each cuisine's best unused spot until the deck
      // is full. Cuisines with few matches simply run dry and the rest fill the remainder.
      const DECK = 10;
      const cuisineOrder = [...cuisineList].sort(() => Math.random() - 0.5); // fair starting turn
      const buckets = new Map(cuisineOrder.map(c => [c, []]));
      for (const p of filtered) {
        for (const c of (matchedBy.get(p.id) || [])) {
          if (buckets.has(c)) buckets.get(c).push(p);
        }
      }
      for (const arr of buckets.values()) arr.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));

      const balanced = [];
      const used = new Set();
      let pulled = true;
      while (balanced.length < DECK && pulled) {
        pulled = false;
        for (const c of cuisineOrder) {
          const arr = buckets.get(c);
          while (arr && arr.length && used.has(arr[0].id)) arr.shift(); // skip already-picked
          if (arr && arr.length) {
            const p = arr.shift();
            used.add(p.id);
            balanced.push(p);
            pulled = true;
            if (balanced.length >= DECK) break;
          }
        }
      }

      // Format Google's priceRange (Money start/end) into a compact "$15–30".
      const CUR = { USD: "$", CAD: "$", AUD: "$", NZD: "$", EUR: "€", GBP: "£", JPY: "¥", INR: "₹" };
      const priceRange = (pr) => {
        if (!pr) return null;
        const s = pr.startPrice, e = pr.endPrice;
        const sym = CUR[(s || e)?.currencyCode] || "";
        if (s?.units != null && e?.units != null) return `${sym}${s.units}–${e.units}`;
        if (s?.units != null) return `${sym}${s.units}+`;
        if (e?.units != null) return `up to ${sym}${e.units}`;
        return null;
      };

      // 4) Resolve one photo each to a key-less URL + shape to card fields.
      const toRad = d => d * Math.PI / 180;
      const distMi = (a, b) => {
        const R = 3958.8, dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
        const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
      };
      const resolvePhoto = async (name) => {
        if (!name) return null;
        const cached = await env.SESSIONS.get(`photo:${name}`);
        if (cached) return cached;
        try {
          const r = await fetch(`https://places.googleapis.com/v1/${name}/media?maxWidthPx=800&skipHttpRedirect=true`,
            { headers: { "X-Goog-Api-Key": key } });
          const b = await r.json();
          if (b.photoUri) { await env.SESSIONS.put(`photo:${name}`, b.photoUri, { expirationTtl: 60 * 60 * 6 }); return b.photoUri; }
        } catch {}
        return null;
      };

      const cards = await Promise.all(balanced.map(async p => ({
        id: p.id,
        name: p.displayName?.text || "Unknown",
        address: p.formattedAddress || "",
        distanceMi: Math.round(distMi(center, { lat: p.location.latitude, lng: p.location.longitude }) * 10) / 10,
        cuisine: p.primaryTypeDisplayName?.text || null,
        matchedCuisines: [...(matchedBy.get(p.id) || [])],
        rating: p.rating ?? null,
        reviews: p.userRatingCount ?? 0,
        priceLevel: p.priceLevel ?? null,
        description: p.editorialSummary?.text || null,
        openNow: p.currentOpeningHours?.openNow ?? null,
        takeout: p.takeout ?? null,
        delivery: p.delivery ?? null,
        dineIn: p.dineIn ?? null,
        reservable: p.reservable ?? null,
        outdoorSeating: p.outdoorSeating ?? null,
        servesAlcohol: servesAlcohol(p),
        goodForGroups: p.goodForGroups ?? null,
        servesVegetarianFood: p.servesVegetarianFood ?? null,
        allowsDogs: p.allowsDogs ?? null,
        liveMusic: p.liveMusic ?? null,
        goodForWatchingSports: p.goodForWatchingSports ?? null,
        servesDessert: p.servesDessert ?? null,
        menuForChildren: p.menuForChildren ?? null,
        serviceStyle: isQuickService(p) ? "counter" : "table",
        priceRange: priceRange(p.priceRange),
        website: p.websiteUri || null,
        mapsUri: p.googleMapsUri || null,
        photo: await resolvePhoto(p.photos?.[0]?.name),
      })));

      return json({ center: center.label, count: cards.length, restaurants: cards });
    }

    // ── TMDB Proxy (watch providers etc.) ──
    const tmdbPath = url.pathname + url.search;
    const tmdbUrl = `${TMDB_BASE}${tmdbPath}&api_key=${TMDB_KEY}`;
    try {
      const res = await fetch(tmdbUrl);
      const body = await res.text();
      return new Response(body, { status: res.status, headers: { "Content-Type": "application/json", ...CORS } });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },
};

// ── Session Durable Object ──
// One instance per session id (SESSION_ROOM.idFromName(id)). Stores the session
// JSON blob under a single "data" key. Strongly consistent, so joins/votes show
// up on every device on the next poll instead of waiting out KV's edge cache.
// An alarm deletes the data ~24h after the last write to mirror the old TTL.
export class SessionRoom {
  constructor(state) {
    this.state = state;
  }

  // Plan-ahead (async) sessions live for 7 days; live sessions for 24h.
  ttlMsFor(session) {
    return (session && session.asyncMode ? ASYNC_SESSION_TTL : SESSION_TTL) * 1000;
  }

  async fetch(request) {
    if (request.method === "GET") {
      const val = await this.state.storage.get("data");
      if (!val) return json({ error: "not found" }, 404);
      return new Response(val, { headers: { "Content-Type": "application/json", ...CORS } });
    }
    if (request.method === "PUT") {
      const body = await request.text();
      const bad = badBody(body);
      if (bad) return bad;
      await this.state.storage.put("data", body);
      let parsed = null;
      try { parsed = JSON.parse(body); } catch {}
      await this.state.storage.setAlarm(Date.now() + this.ttlMsFor(parsed));
      return json({ ok: true });
    }
    // POST { claim: "<name>" } — atomically claim a named lock (e.g. deck generation)
    // so exactly ONE device runs the expensive step even when several poll the same
    // "everyone's done" state at once. The claim lives in its own storage key (NOT the
    // session blob) so a client PUT of the session can never clobber it. A claim goes
    // stale after 120s, so a device that died mid-generate doesn't wedge the session.
    if (request.method === "POST") {
      const raw = await request.text();
      const bad = badBody(raw);
      if (bad) return bad;
      const name = (JSON.parse(raw) || {}).claim;
      if (typeof name !== "string" || !/^[a-z]{1,24}$/i.test(name)) {
        return json({ error: "claim name required" }, 400);
      }
      let claimed = false, exists = true;
      await this.state.blockConcurrencyWhile(async () => {
        const data = await this.state.storage.get("data");
        if (!data) { exists = false; return; }
        const key = `claim:${name.toLowerCase()}`;
        const prev = await this.state.storage.get(key);
        if (prev && Date.now() - prev < 120 * 1000) return; // held & fresh — denied
        await this.state.storage.put(key, Date.now());
        claimed = true;
      });
      if (!exists) return json({ error: "not found" }, 404);
      return json({ claimed });
    }
    // PATCH — atomic partial update of the session, wrapped in blockConcurrencyWhile
    // so overlapping writers serialize instead of clobbering each other. Accepts any
    // combination of:
    //   participant: {id, ...fields} — upsert ONE participant (add, else shallow-merge)
    //   criteria:    {...fields}     — shallow-merge into session.criteria (admin writes)
    //   set:         {...fields}     — top-level sets, allowlisted (deck-generation,
    //                                  roster and final-pick fields only, so clients
    //                                  can't overwrite arbitrary session state here)
    if (request.method === "PATCH") {
      const raw = await request.text();
      const bad = badBody(raw);
      if (bad) return bad;
      const patch = JSON.parse(raw); // badBody already validated it parses
      const p = patch && patch.participant;
      const crit = patch && patch.criteria;
      const set = patch && patch.set;
      const SETTABLE = ["expectedCount", "movies", "moviesGenerated", "restaurants", "foodReady", "chosenId"];
      if (p && !p.id) return json({ error: "participant.id required" }, 400);
      if (!p && !crit && !set) return json({ error: "nothing to patch" }, 400);

      let status = 200, out = null;
      await this.state.blockConcurrencyWhile(async () => {
        const raw = await this.state.storage.get("data");
        if (!raw) { status = 404; return; }
        let session;
        try { session = JSON.parse(raw); } catch { status = 500; return; }
        if (p) {
          if (!Array.isArray(session.participants)) session.participants = [];
          const i = session.participants.findIndex(x => x.id === p.id);
          if (i === -1) session.participants.push(p);
          else session.participants[i] = { ...session.participants[i], ...p };
        }
        if (crit && typeof crit === "object") {
          session.criteria = { ...(session.criteria || {}), ...crit };
        }
        if (set && typeof set === "object") {
          for (const k of SETTABLE) if (k in set) session[k] = set[k];
        }
        out = JSON.stringify(session);
        await this.state.storage.put("data", out);
        await this.state.storage.setAlarm(Date.now() + this.ttlMsFor(session));
      });

      if (status === 404) return json({ error: "not found" }, 404);
      if (status === 500) return json({ error: "corrupt session" }, 500);
      return new Response(out, { headers: { "Content-Type": "application/json", ...CORS } });
    }
    return json({ error: "method not allowed" }, 405);
  }

  // Fired ~24h after the last write; clears the session so DO storage doesn't grow
  // unbounded (mirrors the KV expirationTtl the sessions used to have).
  async alarm() {
    await this.state.storage.deleteAll();
  }
}
