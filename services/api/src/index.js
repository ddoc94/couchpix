// TMDB_KEY and OMDB_KEY are Worker secrets (set via `wrangler secret put`),
// read from `env` inside fetch() — never hardcode API keys in source.
const TMDB_BASE = "https://api.themoviedb.org/3";
const TMDB_IMG = "https://image.tmdb.org/t/p/w500";
const SESSION_TTL = 60 * 60 * 24;          // 24 hours
const PROFILE_TTL = 60 * 60 * 24 * 90;     // 90 days — sliding window, refreshed on each write

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
// Missed cases (acceptable for slight bias): "Avengers: Endgame", "Empire Strikes
// Back", "Aliens" — these don't carry a sequel marker. Slight bias doesn't need
// to catch every sequel, just demote the obvious ones.
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
    const titleWithoutNum = title.replace(/\s\d{1,2}\s*$/, '').trim().toLowerCase();
    const series = collection.name.replace(/\s*Collection\s*$/i, '').trim().toLowerCase();
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

    // ── User Profile API ──
    // Keyed by a SHA-256 hash of the email (first 24 hex chars) so we never store
    // the raw email as a KV key. The hash is derived client-side; the body still
    // contains the raw email so we can display it back to the user.
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
        await env.SESSIONS.put(userKey, body, { expirationTtl: PROFILE_TTL });
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
      // GET (read) / PUT (full write) / PATCH (atomic single-participant merge).
      if (!["GET", "PUT", "PATCH"].includes(request.method)) {
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

      // 25% of sessions use popularity sort (surfaces trending/recent films instead of
      // all-time classics). The remaining 75% use rating sort across a wide page range
      // so the ~400-movie accessible pool rotates rather than the same top-100 repeating.
      const usePopularity = Math.random() < 0.25;
      const sortBy = usePopularity ? "popularity.desc" : "vote_average.desc";
      const maxPage = usePopularity ? 8 : 20;

      // Pick 2 different random pages and fetch them in parallel — doubles the candidate
      // pool before filtering, keeping us well within the 50 subrequest free-plan limit
      // (2 discover + up to 40 enrichment = 42 worst case).
      const page1 = Math.floor(Math.random() * maxPage) + 1;
      let page2;
      do { page2 = Math.floor(Math.random() * maxPage) + 1; } while (page2 === page1);

      async function fetchPage(page, withDuration) {
        let q = `${TMDB_BASE}/discover/movie?api_key=${TMDB_KEY}&sort_by=${sortBy}&vote_count.gte=200&vote_average.gte=6.0&language=en-US&page=${page}`;
        if (genreIds) q += `&with_genres=${genreIds}`;
        if (vetoIds) q += `&without_genres=${vetoIds}`;
        q += `&with_original_language=${langQuery}`;
        q += `&primary_release_date.gte=${yearFrom}-01-01`;
        q += `&primary_release_date.lte=${yearTo}-12-31`;
        if (withDuration && duration === "short") q += "&with_runtime.lte=120&with_runtime.gte=60";
        if (withDuration && duration === "long") q += "&with_runtime.gte=121";
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

      let [r1, r2] = await Promise.all([fetchPage(page1, true), fetchPage(page2, true)]);
      let results = dedupe([...r1, ...r2]);
      // If duration filter leaves fewer than 10, retry both pages without it
      if (duration && results.length < 10) {
        [r1, r2] = await Promise.all([fetchPage(page1, false), fetchPage(page2, false)]);
        results = dedupe([...r1, ...r2]);
      }

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

          // Use imdb_id from detail to call OMDB (no separate external_ids call needed)
          let omdb = null;
          if (detail.imdb_id) {
            const omdbRes = await fetch(`https://www.omdbapi.com/?i=${detail.imdb_id}&apikey=${OMDB_KEY}`);
            omdb = await omdbRes.json();
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
            streaming: [],
            color: "#1a1a24",
            _isSequel: isLikelySequel(title, detail.belongs_to_collection), // stripped before return
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

      // Slight bias against sequels: weighted random sort where sequels get a +0.3
      // offset (keys in [0.3, 1.3) vs [0, 1) for originals). With this offset, a
      // non-sequel beats a sequel ~75% of head-to-heads. Client takes the first 10,
      // so sequels mostly land outside without being eliminated entirely.
      finalMovies.sort((a, b) => {
        const aKey = Math.random() + (a._isSequel ? 0.3 : 0);
        const bKey = Math.random() + (b._isSequel ? 0.3 : 0);
        return aKey - bKey;
      });
      // Strip the internal hint — clients don't need to see it.
      finalMovies.forEach(m => { delete m._isSequel; });

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
    //                   &radius=8000&minRating=4&mode=delivery|takeout&day=2&minute=1170
    // day (0=Sun..6=Sat) + minute (0..1439) are the intended ORDER time in the
    // user's local timezone (the browser sends them; the group is local to the ZIP).
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
      const mode = url.searchParams.get("mode") === "delivery" ? "delivery" : "takeout";
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
        "places.rating", "places.userRatingCount", "places.priceLevel",
        "places.primaryTypeDisplayName", "places.googleMapsUri", "places.photos",
        "places.currentOpeningHours", "places.regularOpeningHours",
        "places.editorialSummary", "places.takeout", "places.delivery",
      ].join(",");
      const byId = new Map();
      const matchedBy = new Map(); // place id -> Set of picked cuisines that surfaced it
      for (const cuisine of cuisineList) {
        const cacheKey = `food:${zip}:${cuisine.toLowerCase()}:${radius}`;
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

      const filtered = places.filter(p => {
        if (p.takeout !== true) return false;                 // all options must offer takeout
        if (mode === "delivery" && p.delivery !== true) return false;
        if (minRating && (p.rating ?? 0) < minRating) return false;
        if (vetoMatch(p)) return false;
        // Price filter — only when narrowed. Keep places with unknown price (~20%).
        if (priceList.length) {
          const label = PRICE_LABEL[p.priceLevel];
          if (label && !priceList.includes(label)) return false;
        }
        if (!openAtTime(p.regularOpeningHours?.periods)) return false;
        return true;
      })
        // Union spans multiple cuisines — rank best-rated first, then cap the deck.
        .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
        .slice(0, 10);

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

      const cards = await Promise.all(filtered.map(async p => ({
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

  async fetch(request) {
    if (request.method === "GET") {
      const val = await this.state.storage.get("data");
      if (!val) return json({ error: "not found" }, 404);
      return new Response(val, { headers: { "Content-Type": "application/json", ...CORS } });
    }
    if (request.method === "PUT") {
      const body = await request.text();
      await this.state.storage.put("data", body);
      await this.state.storage.setAlarm(Date.now() + SESSION_TTL * 1000);
      return json({ ok: true });
    }
    // PATCH { participant: {id, ...fields} } — atomically upsert ONE participant
    // (add if new, else shallow-merge the given fields). The read-modify-write is
    // wrapped in blockConcurrencyWhile so overlapping PATCHes serialize and can't
    // clobber each other the way a client GET-modify-PUT of the whole blob did.
    if (request.method === "PATCH") {
      let patch;
      try { patch = JSON.parse(await request.text()); } catch { return json({ error: "bad json" }, 400); }
      const p = patch && patch.participant;
      if (!p || !p.id) return json({ error: "participant.id required" }, 400);

      let status = 200, out = null;
      await this.state.blockConcurrencyWhile(async () => {
        const raw = await this.state.storage.get("data");
        if (!raw) { status = 404; return; }
        let session;
        try { session = JSON.parse(raw); } catch { status = 500; return; }
        if (!Array.isArray(session.participants)) session.participants = [];
        const i = session.participants.findIndex(x => x.id === p.id);
        if (i === -1) session.participants.push(p);
        else session.participants[i] = { ...session.participants[i], ...p };
        out = JSON.stringify(session);
        await this.state.storage.put("data", out);
        await this.state.storage.setAlarm(Date.now() + SESSION_TTL * 1000);
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
