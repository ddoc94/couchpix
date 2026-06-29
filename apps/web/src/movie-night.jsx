import { useState, useEffect, useRef, useCallback, useId } from "react";
import { QRCodeSVG } from "qrcode.react";
import { GENRES, LANGUAGES, SERVICES, PROVIDER_MAP, applyStreamingFilter, ACTIVITIES, pickRandomQuestion, drawFromBag } from "./utils.js";

// ─── Palette & Theme ───────────────────────────────────────────────────────────
// Blueprint: cool, technical, fresh. Soft blue-gray base with electric blue accent
// and amber as the secondary gold-ish color (true yellow gold reads muddy on a cool
// background). The action bar / floating elements use the bg color for their backdrop
// fade so they blend seamlessly with the rest of the UI.
const C = {
  bg: "#f4f7fa",         // soft blue-gray (page background)
  surface: "#ffffff",    // header, lifted panels
  card: "#ffffff",       // cards (genres, movie rows, results)
  border: "#dde6ef",     // subtle blue-tinted borders
  accent: "#2563eb",     // electric blue (primary action)
  accentSoft: "rgba(37,99,235,0.10)",
  gold: "#f59e0b",       // amber (super-like star, UNDO highlight)
  text: "#0f172a",       // slate near-black
  muted: "#64748b",      // slate gray
  green: "#059669",      // emerald (Watch / yes vote)
  greenSoft: "rgba(5,150,105,0.10)",
  red: "#dc2626",        // red (Skip / no vote, veto, errors)
  redSoft: "rgba(220,38,38,0.10)",
  // Backdrop color used for fixed floating bars (action bar etc.) — same as bg
  // so the gradient fade-in feels native rather than as a dark overlay.
  backdrop: "rgba(244,247,250,0.95)",
};



function useStorage(key, init) {
  const [val, setVal] = useState(() => {
    try { const s = sessionStorage.getItem(key); return s ? JSON.parse(s) : (typeof init === "function" ? init() : init); } catch { return typeof init === "function" ? init() : init; }
  });
  const set = useCallback(v => {
    setVal(prev => {
      const next = typeof v === "function" ? v(prev) : v;
      try {
        if (next === null || next === undefined) sessionStorage.removeItem(key);
        else sessionStorage.setItem(key, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, [key]);
  return [val, set];
}

// Persisted across tabs/sessions — used for the optional email identity
function useLocalStorage(key, init) {
  const [val, setVal] = useState(() => {
    try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : (typeof init === "function" ? init() : init); } catch { return typeof init === "function" ? init() : init; }
  });
  const set = useCallback(v => {
    setVal(prev => {
      const next = typeof v === "function" ? v(prev) : v;
      try {
        if (next === null || next === undefined) localStorage.removeItem(key);
        else localStorage.setItem(key, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, [key]);
  return [val, set];
}

// Hash email → stable user key. SubtleCrypto SHA-256, first 24 hex chars
// (96 bits of entropy — plenty unique for this scale, and shorter URLs).
async function emailToUserKey(email) {
  const norm = (email || "").trim().toLowerCase();
  if (!norm) return "";
  const data = new TextEncoder().encode(norm);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

async function getProfile(userKey) {
  if (!userKey) return null;
  try {
    const res = await fetch(`${TMDB_PROXY}/user/${userKey}`);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function putProfile(userKey, data) {
  if (!userKey) return;
  try {
    await fetch(`${TMDB_PROXY}/user/${userKey}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  } catch {}
}

const TMDB_IMG = "https://image.tmdb.org/t/p/w500";
const TMDB_PROXY = "https://netpix-proxy.netpix2026.workers.dev";

// 6-character session code drawn from an unambiguous alphabet. Excludes 0/O,
// 1/I/L to avoid the obvious confusables when reading a code aloud or copying
// it across devices. 31 chars ^ 6 = ~887M codes, plenty for our scale.
// Existing codes generated under the old A-Z0-9 alphabet still work — the
// worker accepts any [A-Z0-9]{4,10} for /session/{id}, this only narrows
// what NEW codes can contain.
const SESSION_CODE_ALPHA = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
function generateSessionCode(length = 6) {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += SESSION_CODE_ALPHA[Math.floor(Math.random() * SESSION_CODE_ALPHA.length)];
  }
  return out;
}

async function getSession(id) {
  try {
    const res = await fetch(`${TMDB_PROXY}/session/${id}`);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function putSession(session) {
  try {
    await fetch(`${TMDB_PROXY}/session/${session.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(session),
    });
  } catch {}
}

// Adaptive polling: fetch the session and run `onData(s)` for every result, but
// space fetches out (min → max, ×factor) while the session is UNCHANGED, snapping
// back to fast on any change or when the tab/app regains focus. Same UX as fixed
// polling for the actor (their own write resets the cadence on the next tick), but
// far fewer KV reads during the long "waiting for everyone" idle stretches.
function useAdaptivePoll(sessionId, onData, { min = 2000, max = 8000, factor = 1.5 } = {}) {
  const cbRef = useRef(onData);
  cbRef.current = onData;
  useEffect(() => {
    if (!sessionId) return;
    let active = true, timer = null, delay = min, lastFP = null;
    const run = () => {
      getSession(sessionId).then(s => {
        if (!active) return;
        if (s) {
          const fp = JSON.stringify(s);
          if (fp === lastFP) delay = Math.min(Math.round(delay * factor), max);
          else { delay = min; lastFP = fp; }
          cbRef.current(s);
        }
        if (active) timer = setTimeout(run, delay);
      }).catch(() => { if (active) timer = setTimeout(run, delay); });
    };
    const onVisible = () => {
      if (document.visibilityState === "visible" && active) { delay = min; clearTimeout(timer); run(); }
    };
    document.addEventListener("visibilitychange", onVisible);
    run();
    return () => { active = false; clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [sessionId]);
}

// Collect movie IDs the local user has marked as watched across all their saved sessions.
// We read directly from localStorage so this is naturally scoped to the device that's
// triggering the discover call (the admin). Returns [] if not signed in.
function readWatchedMovieIds() {
  try {
    const raw = localStorage.getItem("mn_profile");
    if (!raw) return [];
    const prof = JSON.parse(raw);
    const ids = new Set();
    for (const s of prof?.sessions || []) {
      for (const m of s.finalMovies || []) {
        if (m.watchStatus === "watched" && m.id) ids.add(m.id);
      }
    }
    return [...ids];
  } catch { return []; }
}

// Collect movie IDs the local user has permanently hidden ("don't show again").
function readHiddenMovieIds() {
  try {
    const raw = localStorage.getItem("mn_profile");
    if (!raw) return [];
    const prof = JSON.parse(raw);
    return prof?.hiddenMovieIds || [];
  } catch { return []; }
}

async function discoverMovies(session) {
  // Vetoes win over picks: if anyone vetoes a genre, it's excluded entirely
  // — even if another participant picked it. This is the "absolute no" semantic.
  const allVetoes = [...new Set((session.participants || []).flatMap(p => p.vetoes || []))];
  const vetoSet = new Set(allVetoes);
  const allGenres = [...new Set((session.participants || []).flatMap(p => p.genres || []))]
    .filter(g => !vetoSet.has(g)); // strip vetoed genres from the pick union
  const duration = session.criteria?.duration || "";
  const languages = session.criteria?.languages?.length ? session.criteria.languages : ["en"];
  const yearFrom = session.criteria?.yearFrom ?? 1980;
  const yearTo = session.criteria?.yearTo ?? new Date().getFullYear();
  const ALL_CERT_ORDER = ["G", "PG", "PG-13", "R"];
  const allowedRatings = session.criteria?.allowedRatings || ALL_CERT_ORDER;
  const watchedIds = readWatchedMovieIds();
  const hiddenIds = readHiddenMovieIds();
  const excludeIds = [...new Set([...watchedIds, ...hiddenIds])];
  const params = new URLSearchParams();
  if (allGenres.length) params.set("genres", allGenres.join(","));
  if (allVetoes.length) params.set("veto_genres", allVetoes.join(","));
  if (duration) params.set("duration", duration);
  params.set("languages", languages.join(","));
  params.set("year_from", yearFrom);
  params.set("year_to", yearTo);
  if (allowedRatings.length < ALL_CERT_ORDER.length) params.set("allowed_ratings", allowedRatings.join(","));
  if (excludeIds.length) params.set("exclude_ids", excludeIds.join(","));
  try {
    const res = await fetch(`${TMDB_PROXY}/discover?${params}`);
    const discovered = res.ok ? await res.json() : [];
    // Prepend any saved-for-later movies the admin chose to include (deduped).
    const savedMovies = (session.savedMovies || []).filter(m => !excludeIds.includes(m.id));
    if (!savedMovies.length) return discovered;
    const savedIds = new Set(savedMovies.map(m => m.id));
    return [...savedMovies, ...discovered.filter(m => !savedIds.has(m.id))];
  } catch { return session.savedMovies || []; }
}


// Fetch live US streaming providers for a set of movies in parallel.
// Returns { [movieId]: { streaming, flatrate, rent } | null }
// null = fetch attempted but failed; undefined = not yet attempted
function useTMDBMovieData(movies) {
  const [data, setData] = useState({});

  useEffect(() => {
    if (!movies?.length) return;
    let cancelled = false;

    async function fetchAll() {
      const results = {};

      await Promise.all(
        movies.map(async (m) => {
          const url = `${TMDB_PROXY}/movie/${m.id}?append_to_response=watch%2Fproviders`;
          try {
            const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
            if (!res.ok) { results[m.id] = null; return; }
            const d = await res.json();

            const usProviders = d["watch/providers"]?.results?.US;
            const flatrate = usProviders?.flatrate || [];
            const rent = usProviders?.rent || [];
            const flatrateIds = [...new Set(flatrate.map(p => PROVIDER_MAP[p.provider_id]).filter(Boolean))];
            const rentIds = [...new Set(rent.map(p => PROVIDER_MAP[p.provider_id]).filter(Boolean))];
            const streaming = [...new Set([...flatrateIds, ...rentIds])];

            results[m.id] = { streaming, flatrate: flatrateIds, rent: rentIds };
          } catch(e) {
            results[m.id] = null;
          }
        })
      );

      if (!cancelled) setData(results);
    }

    // Hard 10s timeout — if fetches hang, unblock with whatever we have
    const timer = setTimeout(() => {
      if (!cancelled) {
        console.warn("[CouchPix] Timeout hit — unblocking with partial data");
        setData(prev => {
          const filled = { ...prev };
          movies.forEach(m => { if (filled[m.id] === undefined) filled[m.id] = null; });
          return filled;
        });
      }
    }, 10000);

    fetchAll().finally(() => clearTimeout(timer));
    return () => { cancelled = true; clearTimeout(timer); };
  }, [movies?.map(m => m.id).join(",")]);

  return data;
}


function MiniQR({ text, size = 200 }) {
  return (
    <QRCodeSVG
      value={text}
      size={size}
      bgColor="#ffffff"
      fgColor="#000000"
      level="M"
      style={{ borderRadius: 8 }}
    />
  );
}

// ─── Swipe Card ───────────────────────────────────────────────────────────────
function TrailerModal({ movieId, title, onClose }) {
  const [ytKey, setYtKey] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    fetch(`${TMDB_PROXY}/videos?id=${movieId}`)
      .then(r => r.json())
      .then(d => {
        if (d.key) setYtKey(d.key);
        else setNotFound(true);
        setLoading(false);
      })
      .catch(() => { setNotFound(true); setLoading(false); });
  }, [movieId]);

  return (
    <div
      onClick={onClose}
      style={{ position:"fixed", inset:0, zIndex:1000, background:"rgba(0,0,0,0.92)", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:20 }}
    >
      <div onClick={e => e.stopPropagation()} style={{ width:"100%", maxWidth:640 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
          <div style={{ color:"#fff", fontSize:16, fontWeight:700 }}>{title}</div>
          <button onClick={onClose} style={{ background:"rgba(255,255,255,0.15)", border:"none", borderRadius:"50%", width:36, height:36, color:"#fff", fontSize:18, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" }}>✕</button>
        </div>
        {loading && <div style={{ color:C.muted, textAlign:"center", padding:40 }}>Loading trailer…</div>}
        {notFound && <div style={{ color:C.muted, textAlign:"center", padding:40 }}>No trailer available</div>}
        {ytKey && (
          <iframe
            src={`https://www.youtube.com/embed/${ytKey}?autoplay=1`}
            style={{ width:"100%", aspectRatio:"16/9", border:"none", borderRadius:12 }}
            allow="autoplay; fullscreen"
            allowFullScreen
          />
        )}
      </div>
    </div>
  );
}

// Cache trailer keys (movieId -> key|null) so swiping back/forward is instant and
// upcoming cards can be prefetched. fetchTrailerKey dedupes in-flight requests.
const trailerKeyCache = new Map();
const trailerKeyPending = new Map();
function fetchTrailerKey(movieId) {
  if (trailerKeyCache.has(movieId)) return Promise.resolve(trailerKeyCache.get(movieId));
  if (trailerKeyPending.has(movieId)) return trailerKeyPending.get(movieId);
  const p = fetch(`${TMDB_PROXY}/videos?id=${movieId}`)
    .then(r => r.json())
    .then(d => { const k = d.key || null; trailerKeyCache.set(movieId, k); trailerKeyPending.delete(movieId); return k; })
    .catch(() => { trailerKeyCache.set(movieId, null); trailerKeyPending.delete(movieId); return null; });
  trailerKeyPending.set(movieId, p);
  return p;
}
// Warm the key + thumbnail image cache for an upcoming movie so its card paints instantly.
function prefetchTrailer(movieId) {
  fetchTrailerKey(movieId).then(k => {
    if (k) { const img = new Image(); img.src = `https://img.youtube.com/vi/${k}/maxresdefault.jpg`; }
  });
}

// Card header: shows the movie's trailer thumbnail with a play button, and plays
// the trailer inline in that same space when tapped. Falls back to the poster image
// when no trailer exists. The native YouTube player handles fullscreen.
function CardTrailerHeader({ movie, posterUrl, height = 280 }) {
  // Seed from cache synchronously when available so prefetched cards never flash.
  const [ytKey, setYtKey] = useState(() => trailerKeyCache.has(movie.id) ? trailerKeyCache.get(movie.id) : undefined); // undefined = loading, null = none, string = key
  const [playing, setPlaying] = useState(false);
  const [posterError, setPosterError] = useState(false);
  const [thumbError, setThumbError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPlaying(false); setThumbError(false);
    if (trailerKeyCache.has(movie.id)) { setYtKey(trailerKeyCache.get(movie.id)); return; }
    setYtKey(undefined);
    fetchTrailerKey(movie.id).then(k => { if (!cancelled) setYtKey(k); });
    return () => { cancelled = true; };
  }, [movie.id]);

  // maxresdefault is sharp but not always generated; mqdefault is 16:9 and always exists.
  const thumbUrl = ytKey
    ? `https://img.youtube.com/vi/${ytKey}/${thumbError ? "mqdefault" : "maxresdefault"}.jpg`
    : null;
  // Only fall back to the poster once we've CONFIRMED there's no trailer (ytKey === null).
  // While the key is still loading (undefined) we show a neutral background so the poster
  // doesn't flash in and then get replaced by the trailer thumbnail.
  const showPoster = ytKey === null && posterUrl && !posterError;
  const stop = e => e.stopPropagation();

  // When maxresdefault doesn't exist, YouTube returns a 404 whose BODY is a 120×90
  // gray placeholder. iOS WebView renders that body instead of firing onError, so we
  // also detect the placeholder by its tiny dimensions on load and fall back to mqdefault.
  const handleThumbLoad = e => {
    if (!thumbError && e.target.naturalWidth > 0 && e.target.naturalWidth <= 120) {
      setThumbError(true);
    }
  };

  return (
    <div style={{ height, position:"relative", background:`linear-gradient(135deg, ${C.accentSoft}, ${C.bg})`, overflow:"hidden" }}>
      {playing && ytKey ? (
        <iframe
          src={`https://www.youtube.com/embed/${ytKey}?autoplay=1&playsinline=1`}
          style={{ width:"100%", height:"100%", border:"none", display:"block" }}
          allow="autoplay; fullscreen; encrypted-media"
          allowFullScreen
        />
      ) : (
        <>
          {thumbUrl ? (
            <img src={thumbUrl} alt={movie.title} onError={() => setThumbError(true)} onLoad={handleThumbLoad}
              style={{ width:"100%", height:"100%", objectFit:"cover", display:"block" }} />
          ) : showPoster ? (
            <img src={posterUrl} alt={movie.title} onError={() => setPosterError(true)}
              style={{ width:"100%", height:"100%", objectFit:"cover", display:"block" }} />
          ) : ytKey === undefined ? (
            // Key still loading — neutral gradient (the container background), no flash.
            <div style={{ width:"100%", height:"100%" }} />
          ) : (
            <div style={{ width:"100%", height:"100%", display:"flex", alignItems:"center", justifyContent:"center", fontSize:100 }}>
              <span style={{ filter:"drop-shadow(0 4px 20px rgba(0,0,0,0.5))" }}>🎬</span>
            </div>
          )}

          {/* Play button — only when a trailer exists */}
          {ytKey && (
            <button
              onMouseDown={stop} onTouchStart={stop}
              onClick={e => { stop(e); setPlaying(true); }}
              aria-label="Play trailer"
              style={{
                position:"absolute", inset:0, margin:"auto", width:64, height:64, borderRadius:"50%",
                border:"none", background:"rgba(0,0,0,0.6)", color:"#fff", fontSize:24, cursor:"pointer",
                display:"flex", alignItems:"center", justifyContent:"center",
                backdropFilter:"blur(2px)", boxShadow:"0 4px 20px rgba(0,0,0,0.5)", paddingLeft:6,
              }}
            >▶</button>
          )}
          {ytKey && (
            <div style={{ position:"absolute", bottom:12, left:12, background:"rgba(0,0,0,0.7)", borderRadius:6, padding:"3px 8px", fontSize:10, color:"#fff", fontWeight:700, letterSpacing:0.5, textTransform:"uppercase", backdropFilter:"blur(4px)" }}>
              ▶ Trailer
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SwipeCard({ movie, posterUrl, liveStreaming, tmdbEntry, onSwipe, index, total, matches }) {
  const cardRef = useRef(null);
  const dragRef = useRef({ x: 0, y: 0, dragging: false, startX: 0, startY: 0 });
  const [drag, setDrag] = useState({ x: 0, y: 0, dragging: false, startX: 0, startY: 0 });
  const [decision, setDecision] = useState(null);

  // Non-passive touchmove listener so we can preventDefault for horizontal swipes
  // while still letting the browser handle vertical scrolling. We "lock" the gesture
  // direction on first significant movement: horizontal → swipe, vertical → scroll.
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const onTouchMove = (e) => {
      const d = dragRef.current;
      if (!d.dragging) return;
      // Once locked as horizontal swipe, block vertical scroll to keep the gesture clean
      if (d.axis === "x") e.preventDefault();
    };
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => el.removeEventListener("touchmove", onTouchMove);
  }, []);

  const handleStart = (clientX, clientY) => {
    const s = { x: 0, y: 0, dragging: true, startX: clientX, startY: clientY, axis: null };
    dragRef.current = s;
    setDrag(s);
  };
  const handleMove = (clientX, clientY) => {
    const d = dragRef.current;
    if (!d.dragging) return;
    const dx = clientX - d.startX;
    const dy = clientY - d.startY;

    // Determine gesture axis on first significant movement (>10px).
    // If vertical, abandon the drag entirely so the browser scrolls naturally.
    if (!d.axis) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return; // still in deadzone
      if (Math.abs(dy) > Math.abs(dx)) {
        dragRef.current = { ...d, dragging: false, axis: "y" };
        setDrag({ x: 0, y: 0, dragging: false, startX: 0, startY: 0, axis: null });
        setDecision(null);
        return;
      }
      dragRef.current.axis = "x"; // commit to horizontal swipe
    }

    dragRef.current = { ...dragRef.current, x: dx, y: dy };
    setDrag(s => ({ ...s, x: dx, y: dy }));
    if (dx > 60) setDecision("yes");
    else if (dx < -60) setDecision("no");
    else setDecision(null);
  };
  const handleEnd = () => {
    const d = dragRef.current;
    if (!d.dragging) {
      // Already abandoned (vertical scroll) — nothing to clean up
      return;
    }
    const dx = d.x;
    const reset = { x: 0, y: 0, dragging: false, startX: 0, startY: 0, axis: null };
    dragRef.current = reset;
    if (Math.abs(dx) > 80) {
      onSwipe(dx > 0 ? "yes" : "no");
    } else {
      setDrag(reset);
      setDecision(null);
    }
  };

  const rot = drag.x * 0.08;
  const opacity = Math.max(0, 1 - Math.abs(drag.x) / 300);
  // Prefer live TMDB data; fall back to hardcoded while loading
  const streamingIds = liveStreaming ?? movie.streaming;

  return (
    <div
      ref={cardRef}
      className="swipe-card"
      onMouseDown={e => handleStart(e.clientX, e.clientY)}
      onMouseMove={e => handleMove(e.clientX, e.clientY)}
      onMouseUp={handleEnd}
      onMouseLeave={handleEnd}
      onTouchStart={e => handleStart(e.touches[0].clientX, e.touches[0].clientY)}
      onTouchMove={e => handleMove(e.touches[0].clientX, e.touches[0].clientY)}
      onTouchEnd={handleEnd}
      style={{
        position: "relative",
        width: "100%",
        maxWidth: 420,
        cursor: drag.dragging ? "grabbing" : "grab",
        transform: `translateX(${drag.x}px) translateY(${drag.y * 0.3}px) rotate(${rot}deg)`,
        transition: drag.dragging ? "none" : "transform 0.3s ease",
        zIndex: 10,
      }}
    >
      {/* YES / NO overlays */}
      {decision === "yes" && (
        <div style={{ position:"absolute", top:20, left:20, zIndex:20, border:`4px solid ${C.green}`, borderRadius:8, padding:"8px 20px", transform:"rotate(-15deg)", color:C.green, fontSize:28, fontWeight:900, fontFamily:"monospace" }}>WATCH</div>
      )}
      {decision === "no" && (
        <div style={{ position:"absolute", top:20, right:20, zIndex:20, border:`4px solid ${C.red}`, borderRadius:8, padding:"8px 20px", transform:"rotate(15deg)", color:C.red, fontSize:28, fontWeight:900, fontFamily:"monospace" }}>SKIP</div>
      )}

      <div style={{ background: C.card, borderRadius:20, overflow:"hidden", boxShadow:"0 16px 40px rgba(15,23,42,0.12)", border:`1px solid ${C.border}` }}>
        {/* Trailer thumbnail / inline player */}
        <CardTrailerHeader movie={movie} posterUrl={posterUrl} />

        {/* Info */}
        <div style={{ padding:"16px 20px 20px" }}>
          <div style={{ display:"flex", alignItems:"baseline", gap:8, marginBottom:6, flexWrap:"wrap" }}>
            <h2 style={{ margin:0, fontSize:22, fontWeight:800, color:C.text, fontFamily:"'Georgia', serif", lineHeight:1.2 }}>{movie.title}</h2>
            <span style={{ color:C.muted, fontSize:14, flexShrink:0 }}>{movie.year}</span>
            {movie.duration > 0 && (
              <span style={{ color:C.muted, fontSize:14, flexShrink:0 }}>
                · {Math.floor(movie.duration / 60) > 0 ? `${Math.floor(movie.duration / 60)}h ` : ""}{movie.duration % 60}m
              </span>
            )}
            {movie.mpaa && (
              <span style={{ fontSize:11, border:`1px solid ${C.border}`, borderRadius:4, padding:"1px 6px", color:C.muted, fontWeight:600, flexShrink:0 }}>{movie.mpaa}</span>
            )}
          </div>

          {/* Ratings */}
          <div style={{ display:"flex", gap:8, marginBottom:10 }}>
            <span style={{ display:"inline-flex", alignItems:"center", gap:4, background:`${C.gold}1a`, border:`1px solid ${C.gold}55`, borderRadius:8, padding:"3px 10px", fontSize:13, color:C.gold, fontWeight:700 }}>
              ⭐ {movie.imdb}<span style={{ fontSize:10, opacity:0.7, fontWeight:600 }}>IMDb</span>
            </span>
            <span style={{ display:"inline-flex", alignItems:"center", gap:4, background:"#fa4b3a1a", border:"1px solid #fa4b3a55", borderRadius:8, padding:"3px 10px", fontSize:13, color:"#fa4b3a", fontWeight:700 }}>
              🍅 {movie.rt}%<span style={{ fontSize:10, opacity:0.7, fontWeight:600 }}>RT</span>
            </span>
          </div>

          {movie.director && (
            <div style={{ fontSize:12, color:C.muted, marginBottom:8 }}>dir. {movie.director}</div>
          )}

          <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginBottom:12 }}>
            {movie.genres.map(g => (
              <span key={g} style={{ background:C.accentSoft, color:C.accent, borderRadius:20, padding:"2px 10px", fontSize:11, fontWeight:600, border:`1px solid ${C.accent}44` }}>{g}</span>
            ))}
          </div>

          {matches?.length > 0 && (
            <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginBottom:12 }}>
              {matches.slice(0, 4).map((m, i) => (
                <span key={i} style={{
                  background: m.kind === "service" ? `${m.color}22` : C.greenSoft,
                  color: m.kind === "service" ? m.color : C.green,
                  border: `1px solid ${m.kind === "service" ? `${m.color}55` : `${C.green}55`}`,
                  borderRadius: 6,
                  padding: "2px 8px",
                  fontSize: 11,
                  fontWeight: 600,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                }}>
                  <span style={{ fontSize: 9 }}>✨</span>
                  {m.label}
                </span>
              ))}
            </div>
          )}

          <p style={{ margin:"0 0 12px", color:C.text, fontSize:13.5, lineHeight:1.6, opacity:0.85 }}>{movie.description}</p>

          <div style={{ marginBottom:10 }}>
            <div style={{ fontSize:11, color:C.muted, marginBottom:4, textTransform:"uppercase", letterSpacing:1 }}>Cast</div>
            <div style={{ fontSize:13, color:C.text }}>{movie.actors.slice(0,5).join(" · ")}</div>
          </div>

          {movie.awards && (
            <div style={{ fontSize:11, color:C.gold, marginBottom:10, display:"flex", alignItems:"flex-start", gap:6 }}>
              <span>🏆</span>
              <span>{movie.awards}</span>
            </div>
          )}

          {streamingIds.length > 0 ? (
            <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
              {streamingIds.map(s => {
                const svc = SERVICES.find(sv => sv.id === s);
                if (!svc) return null;
                const isFlatrate = tmdbEntry?.flatrate?.includes(s);
                const isRentOnly = !isFlatrate && tmdbEntry?.rent?.includes(s);
                return (
                  <span key={s} style={{ background:`${svc.color}22`, color:svc.color, border:`1px solid ${svc.color}55`, borderRadius:6, padding:"2px 8px", fontSize:11, fontWeight:600, display:"flex", alignItems:"center", gap:4 }}>
                    {svc.label}
                    {isRentOnly && <span style={{ fontSize:10, opacity:0.8, fontWeight:400 }}>· rent</span>}
                    {isFlatrate && <span style={{ fontSize:10, opacity:0.8, fontWeight:400 }}>· free</span>}
                  </span>
                );
              })}
            </div>
          ) : liveStreaming === undefined ? (
            <div style={{ fontSize:11, color:C.muted }}>Loading streaming info…</div>
          ) : (
            <div style={{ fontSize:11, color:C.muted }}>Not available to stream or rent</div>
          )}
        </div>
      </div>

      {/* Progress */}
      <div style={{ textAlign:"center", marginTop:12, color:C.muted, fontSize:13 }}>{index + 1} of {total}</div>
    </div>
  );
}


export default function MovieNightApp() {
  const [screen, setScreen] = useStorage("mn_screen", "home");
  const [session, setSession] = useStorage("mn_session", null);
  // userId & userName live in localStorage so they survive PWA force-quit
  // (sessionStorage clears on close, which led to admins losing their admin
  // status when they reopened the app and rejoined their own session).
  // Both initializers fall back to sessionStorage so users who had a value
  // there from before this change don't lose continuity on first launch.
  const [userName, setUserName] = useLocalStorage("mn_username", () => {
    try { const old = sessionStorage.getItem("mn_username"); if (old) return JSON.parse(old); } catch {}
    return "";
  });
  const [userId] = useLocalStorage("mn_userid", () => {
    try { const old = sessionStorage.getItem("mn_userid"); if (old) return JSON.parse(old); } catch {}
    return Math.random().toString(36).slice(2,10);
  });

  // ── Optional email identity (persists in localStorage so it survives tab close) ──
  const [profile, setProfile] = useLocalStorage("mn_profile", null); // { email, userKey, sessions: [...] } or null

  // Enter a session by id. Used by the URL-param effect (invite link) AND the
  // QR scanner. If we already have a usable name (signed-in displayName, or a
  // userName from a prior session), add the user as a participant and route
  // straight to the lobby. Otherwise route to the join screen so they can
  // type a name first. Returns true if the session was found, false if not.
  const enterSession = async (sid) => {
    const s = await getSession(sid);
    if (!s) return false;
    const nameToUse = profile?.displayName?.trim() || userName?.trim();
    if (nameToUse) {
      const alreadyIn = s.participants?.some(p => p.id === userId);
      if (alreadyIn) {
        setSession(s);
      } else {
        const updated = {
          ...s,
          participants: [
            ...s.participants,
            { id: userId, name: nameToUse, votes: {}, done: false, genres: [], vetoes: [], passionPick: null, prefsDone: false },
          ],
        };
        setSession(updated);
        putSession(updated);
      }
      setScreen("lobby");
    } else {
      setSession(s);
      setScreen("join");
    }
    return true;
  };

  // ── Parse URL params for session joining ──
  // Consume the ?session=XXX param exactly once on mount, then strip it from the URL
  // so a later refresh (e.g. after the user hit Reset) doesn't re-trigger the auto-join.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sid = params.get("session");
    if (!sid) return;
    // Strip the param right away so refreshes are idempotent
    const cleanUrl = window.location.pathname + window.location.hash;
    window.history.replaceState({}, "", cleanUrl);
    if (screen === "home") enterSession(sid);
  }, []);

  // Auto-prefill the user's name if they're signed in.
  // Prefers the explicit displayName from the profile, falls back to email prefix.
  // Also re-syncs if the user updates their displayName via the Profile screen.
  useEffect(() => {
    if (!profile?.email) return;
    const preferred = profile.displayName?.trim() || profile.email.split("@")[0];
    if (preferred && preferred !== userName) setUserName(preferred);
  }, [profile?.email, profile?.displayName]);

  const syncSession = (s) => {
    setSession(s);
    if (s) putSession(s);
  };

  const goHome = () => { setScreen("home"); setSession(null); };

  // Create a movie-night session without going through the SetupScreen. Used as
  // the fast path on the home button when we already know who the user is
  // (signed-in displayName, or a userName from a past session).
  const createAndEnterSession = async (name) => {
    if (setUserName) setUserName(name);
    const sid = generateSessionCode();
    const newSession = {
      id: sid,
      adminId: userId,
      activity: ACTIVITIES.MOVIES,
      participants: [{ id: userId, name, votes: {}, done: false, genres: [], vetoes: [], passionPick: null, prefsDone: false }],
      criteria: { services: [], subscriptionOnly: false, duration: null, languages: ["en"] },
      movies: [],
      started: false,
      round: 1,
    };
    await putSession(newSession);
    setSession(newSession);
    setScreen("lobby");
  };

  // Movie Night start handler. Fast-paths to lobby if we know the user's name;
  // falls through to Setup if not. Fun Questions doesn't go through here — it's
  // a standalone, sessionless experience that launches directly into its screen.
  const startMoviesSession = () => {
    const nameToUse = profile?.displayName?.trim() || userName?.trim();
    if (nameToUse) createAndEnterSession(nameToUse);
    else setScreen("setup");
  };

  // Food Night session creation. Mirrors the movie path but with the food activity
  // and an empty restaurants deck (the admin fills criteria on FoodPreferencesScreen).
  const createAndEnterFoodSession = async (name) => {
    if (setUserName) setUserName(name);
    const sid = generateSessionCode();
    const newSession = {
      id: sid,
      adminId: userId,
      activity: ACTIVITIES.FOOD,
      participants: [{ id: userId, name, votes: {}, done: false }],
      criteria: {},
      restaurants: [],
      started: false,
      round: 1,
    };
    await putSession(newSession);
    setSession(newSession);
    setScreen("lobby");
  };
  const startFoodSession = () => {
    let nameToUse = profile?.displayName?.trim() || userName?.trim();
    if (!nameToUse) {
      const entered = (typeof window !== "undefined" && window.prompt("Your name?") || "").trim();
      if (!entered) return;
      nameToUse = entered;
    }
    createAndEnterFoodSession(nameToUse);
  };

  const screens = {
    home: <HomeScreen
      profile={profile}
      onStartMovies={() => setScreen("movienight")}
      onStartFood={() => setScreen("foodnight")}
      onStartQuestions={() => setScreen("questions")}
      onSignIn={() => setScreen("signin")}
      onViewProfile={() => setScreen("profile")} />,
    movienight: <MovieNightScreen
      onCreateSession={startMoviesSession}
      onJoinSession={() => setScreen("join")}
      onScanQR={() => setScreen("scanqr")} />,
    foodnight: <FoodNightScreen
      onCreateSession={startFoodSession}
      onJoinSession={() => setScreen("join")}
      onScanQR={() => setScreen("scanqr")} />,
    signin: <SignInScreen onSignedIn={(p) => { setProfile(p); setScreen("home"); }} onCancel={() => setScreen("home")} />,
    profile: <ProfileScreen profile={profile} setProfile={setProfile} onSignOut={() => { setProfile(null); setScreen("home"); }} onHome={() => setScreen("home")} />,
    scanqr: <QRScanScreen
      onDetected={(code) => {
        // Routes to lobby (auto-joined) if we have a name, else to the join screen.
        enterSession(code).then(ok => {
          if (!ok) {
            alert("Session not found. Double-check the code or ask the host to refresh the QR.");
            setScreen("home");
          }
        });
      }}
      onCancel={() => setScreen("home")} />,
    setup: <SetupScreen userId={userId} userName={userName} setUserName={setUserName} onCreated={(s) => { syncSession(s); setScreen("lobby"); }} />,
    join: <JoinScreen session={session} userId={userId} userName={userName} setUserName={setUserName}
      onJoined={(s) => { syncSession(s); setScreen("lobby"); }}
      onSessionLoad={(s) => syncSession(s)} />,
    lobby: <LobbyScreen session={session} userId={userId} onStarted={(s) => {
      syncSession(s);
      if (s.activity === ACTIVITIES.FOOD) {
        setScreen("foodprefs");
      } else if (s.adminId === userId && profile?.savedLater?.length) {
        setScreen("savedmovies");
      } else {
        setScreen("prefs");
      }
    }} onSync={(s) => setSession(s)} />,
    savedmovies: <SavedMoviesScreen
      profile={profile}
      setProfile={setProfile}
      session={session}
      onContinue={(toInclude) => {
        const updated = { ...session, savedMovies: toInclude };
        syncSession(updated);
        setScreen("prefs");
      }}
      onSkip={() => setScreen("prefs")}
    />,
    prefs: <PreferencesScreen session={session} userId={userId} profile={profile} setProfile={setProfile} onMoviesReady={(s) => { syncSession(s); setScreen("swiping"); }} />,
    swiping: <SwipingScreen session={session} userId={userId} profile={profile} setProfile={setProfile} onDone={(s) => { syncSession(s); setScreen("results"); }} />,
    results: <ResultsScreen session={session} userId={userId} profile={profile} setProfile={setProfile} onRestart={(s) => { syncSession(s); setScreen("swiping"); }} onHome={goHome} />,
    foodprefs: <FoodPreferencesScreen session={session} userId={userId} profile={profile} setProfile={setProfile} onReady={(s) => { syncSession(s); setScreen("foodswiping"); }} />,
    foodswiping: <FoodSwipingScreen session={session} userId={userId} onDone={(s) => { syncSession(s); setScreen("foodresults"); }} />,
    foodresults: <FoodResultsScreen session={session} userId={userId}
      onRestart={async () => {
        // Fresh round: clear the deck + everyone's picks/votes so prefs starts clean.
        const s = (await getSession(session.id)) || session;
        const reset = {
          ...s,
          restaurants: [],
          foodReady: false,
          participants: (s.participants || []).map(p => ({ ...p, prefsDone: false, votes: {}, done: false, cuisines: [], vetoCuisines: [] })),
        };
        await putSession(reset);
        syncSession(reset);
        setScreen("foodprefs");
      }}
      onRoundReset={(s) => { syncSession(s); setScreen("foodprefs"); }}
      onHome={goHome} />,
    questions: <QuestionsScreen profile={profile} setProfile={setProfile} onDone={goHome} />,
  };

  return (
    <div style={{ height:"100dvh", background:C.bg, color:C.text, fontFamily:"'Helvetica Neue', Arial, sans-serif", display:"flex", flexDirection:"column", overflow:"hidden" }}>
      <div style={{ flex:1, overflowY:"auto", overscrollBehavior:"none", WebkitOverflowScrolling:"touch" }}>
        <div style={{
          width:"100%",
          maxWidth:500,
          margin:"0 auto",
          // Top padding respects iOS safe area. On non-home screens we add extra
          // headroom (~36px) so page content starts BELOW the floating Reset pill
          // instead of colliding with it vertically.
          padding: screen === "home"
            ? "calc(env(safe-area-inset-top, 0px) + 16px) 16px 40px"
            : "calc(env(safe-area-inset-top, 0px) + 56px) 16px 40px",
        }}>
          {screens[screen] || screens.home}
        </div>
      </div>

      {/* Floating Back arrow — shown on every screen BEFORE the swiping flow
          (setup, signin, profile, join, scanqr, lobby, prefs). Top-left mirror
          of the Reset pill on the right. Both currently go home; Back uses the
          standard navigation affordance while Reset signals "abort/start over". */}
      {["movienight","foodnight","setup","signin","profile","join","scanqr","lobby","savedmovies","prefs","foodprefs"].includes(screen) && (
        <button
          onClick={goHome}
          aria-label="Back"
          style={{
            position: "fixed",
            top: "calc(env(safe-area-inset-top, 0px) + 12px)",
            left: 12,
            zIndex: 50,
            width: 34,
            height: 34,
            background: "rgba(255,255,255,0.85)",
            backdropFilter: "blur(8px)",
            WebkitBackdropFilter: "blur(8px)",
            border: `1px solid ${C.border}`,
            borderRadius: "50%",
            color: C.muted,
            padding: 0,
            fontSize: 18,
            fontWeight: 700,
            lineHeight: 1,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 2px 8px rgba(15,23,42,0.06)",
          }}
        >‹</button>
      )}

      {/* Floating Reset — shown on every non-home screen. Sits in the top-right
          with a blurred backdrop so it stays legible against any underlying UI. */}
      {screen !== "home" && (
        <button
          onClick={goHome}
          aria-label="Reset and return to home"
          style={{
            position: "fixed",
            top: "calc(env(safe-area-inset-top, 0px) + 12px)",
            right: 12,
            zIndex: 50,
            background: "rgba(255,255,255,0.85)",
            backdropFilter: "blur(8px)",
            WebkitBackdropFilter: "blur(8px)",
            border: `1px solid ${C.border}`,
            borderRadius: 999,
            color: C.muted,
            padding: "6px 12px",
            fontSize: 12,
            fontWeight: 600,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 4,
            boxShadow: "0 2px 8px rgba(15,23,42,0.06)",
            whiteSpace: "nowrap",
          }}
        >↩ Reset</button>
      )}
    </div>
  );
}

// ─── Brand Logo ───────────────────────────────────────────────────────────────
// "Swipe phone" — a smartphone framing a stack of swipe cards: a faded movie
// card (play) peeking left, the chosen card with a green check in the middle,
// and a faded food card (fork & knife) peeking right. Implies group decisions
// on what to watch or where to eat. Uses palette refs so it retints with the
// theme. The `size` prop sets the rendered HEIGHT; width is derived from the
// natural 220:300 (portrait) aspect ratio.
function Logo({ size = 40 }) {
  // Unique id per instance so multiple Logos in the DOM don't share a clipPath
  const uid = useId();
  const clipId = `logo-screen-${uid.replace(/[:]/g, '')}`;
  return (
    <svg
      width={size * (220 / 300)}
      height={size}
      viewBox="0 0 220 300"
      xmlns="http://www.w3.org/2000/svg"
      style={{
        display: "inline-block",
        verticalAlign: "middle",
        filter: `drop-shadow(0 4px 12px ${C.accent}22)`,
      }}
      aria-label="CouchPix"
    >
      <defs>
        <clipPath id={clipId}>
          <rect x="55" y="42" width="110" height="216" rx="14"/>
        </clipPath>
      </defs>
      {/* Phone body */}
      <rect x="44" y="12" width="132" height="276" rx="30" fill={C.card} stroke={C.accent} strokeWidth="10"/>
      {/* Screen */}
      <rect x="55" y="42" width="110" height="216" rx="14" fill={C.bg}/>
      {/* Earpiece + camera */}
      <rect x="98" y="27" width="24" height="4" rx="2" fill={C.accent} opacity="0.55"/>
      <circle cx="130" cy="29" r="2.5" fill={C.accent} opacity="0.55"/>
      {/* Swipe cards (clipped to the screen so they peek behind the bezel) */}
      <g clipPath={`url(#${clipId})`}>
        {/* Left peeking card — a movie (play) */}
        <g transform="translate(40,92) rotate(-7)">
          <rect width="54" height="150" rx="10" fill={C.card} stroke={C.border} strokeWidth="5"/>
          <polygon points="19,56 39,70 19,84" fill={C.border}/>
        </g>
        {/* Right peeking card — food (fork & knife) */}
        <g transform="translate(126,92) rotate(7)">
          <rect width="54" height="150" rx="10" fill={C.card} stroke={C.border} strokeWidth="5"/>
          <path d="M17,50 v9 M21,50 v9 M25,50 v9" stroke={C.border} strokeWidth="2.4" strokeLinecap="round"/>
          <path d="M21,57 v29" stroke={C.border} strokeWidth="3.2" strokeLinecap="round"/>
          <path d="M35,50 c5,3 5,13 0,16 z" fill={C.border}/>
          <path d="M35,64 v22" stroke={C.border} strokeWidth="3.2" strokeLinecap="round"/>
        </g>
        {/* Center card (the pick) — green check */}
        <g transform="translate(73,80)">
          <rect width="74" height="158" rx="13" fill={C.card} stroke={C.green} strokeWidth="5"/>
          <path d="M22,72 l9,11 l21,-27" fill="none" stroke={C.green} strokeWidth="8" strokeLinecap="round" strokeLinejoin="round"/>
          <rect x="16" y="116" width="42" height="7" rx="3" fill={C.muted} opacity="0.5"/>
          <rect x="16" y="131" width="28" height="6" rx="3" fill={C.muted} opacity="0.35"/>
        </g>
      </g>
      {/* Home indicator */}
      <rect x="94" y="270" width="32" height="5" rx="2.5" fill={C.accent} opacity="0.45"/>
    </svg>
  );
}

// ─── Home Screen ──────────────────────────────────────────────────────────────
function HomeScreen({ profile, onStartMovies, onStartFood, onStartQuestions, onSignIn, onViewProfile }) {
  // Prefer the explicit display name; fall back to the email prefix for older profiles
  const firstName = profile?.displayName?.trim() || (profile?.email ? profile.email.split("@")[0] : null);
  return (
    <div style={{ paddingTop:32, display:"flex", flexDirection:"column", alignItems:"center", gap:18 }}>
      <div style={{ textAlign:"center" }}>
        <div style={{ marginBottom:12, display:"flex", justifyContent:"center" }}><Logo size={140} /></div>
        <h1 style={{ margin:0, fontSize:32, fontWeight:900, color:C.text, fontFamily:"Georgia, serif", letterSpacing:-1 }}>CouchPix</h1>
        <p style={{ color:C.muted, fontSize:15, marginTop:6 }}>Swipe right on movies everyone wants to watch</p>
      </div>

      {/* ── Account: either the logged-in chip OR a prominent login card ── */}
      {profile?.email ? (
        <div style={{ width:"100%", background:C.card, border:`1px solid ${C.border}`, borderRadius:12, padding:"10px 14px", display:"flex", alignItems:"center", gap:10 }}>
          <div style={{ width:32, height:32, borderRadius:"50%", background:C.accentSoft, color:C.accent, display:"flex", alignItems:"center", justifyContent:"center", fontWeight:800 }}>
            {firstName?.[0]?.toUpperCase() || "?"}
          </div>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontSize:13, fontWeight:700, color:C.text, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>Hi, {firstName}</div>
            <div style={{ fontSize:11, color:C.muted }}>{(profile.sessions || []).length} saved session{(profile.sessions || []).length === 1 ? "" : "s"}</div>
          </div>
          <button onClick={onViewProfile} style={{ background:"transparent", border:`1px solid ${C.border}`, borderRadius:8, color:C.text, padding:"6px 12px", fontSize:12, fontWeight:600, cursor:"pointer" }}>Profile</button>
        </div>
      ) : (
        <button
          onClick={onSignIn}
          style={{
            width:"100%",
            background:C.card,
            border:`1.5px solid ${C.accent}`,
            borderRadius:12,
            padding:"12px 16px",
            display:"flex",
            alignItems:"center",
            gap:12,
            cursor:"pointer",
            textAlign:"left",
            boxShadow:`0 2px 8px ${C.accent}1a`,
            transition:"all 0.15s",
          }}
        >
          <div style={{ width:38, height:38, borderRadius:"50%", background:C.accentSoft, color:C.accent, display:"flex", alignItems:"center", justifyContent:"center", fontWeight:800, fontSize:18, flexShrink:0 }}>👤</div>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontSize:14, fontWeight:800, color:C.text }}>Log in with username</div>
            <div style={{ fontSize:11, color:C.muted, marginTop:2, lineHeight:1.4 }}>
              Save your session history and get better recommendations over time.
            </div>
          </div>
          <span style={{ color:C.accent, fontSize:18, fontWeight:800, flexShrink:0 }}>→</span>
        </button>
      )}

      {/* ── Activity tiles: pick what you want to do ── */}
      <div style={{ width:"100%", display:"flex", flexDirection:"column", gap:10 }}>
        <div style={{ textAlign:"center", color:C.muted, fontSize:13, fontWeight:700, letterSpacing:0.5, marginBottom:2 }}>
          What's the activity?
        </div>
        <ActivityTile
          icon="🎬"
          title="NetPix"
          description="Swipe through movies and pick what to watch together"
          onClick={onStartMovies}
        />
        <ActivityTile
          icon="🍔"
          title="FoodPix"
          description="Find a nearby restaurant everyone wants to order from"
          onClick={onStartFood}
        />

        <div style={{ textAlign:"center", color:C.muted, fontSize:13, fontWeight:700, letterSpacing:0.5, marginTop:14, marginBottom:2 }}>
          Games
        </div>
        <ActivityTile
          icon="💬"
          title="Unhinged Questions"
          description="Ask each other things you've never thought about before"
          onClick={onStartQuestions}
        />
      </div>

      <div style={{ marginTop:"auto", paddingTop:32, paddingBottom:16, textAlign:"center", display:"flex", flexDirection:"column", gap:8 }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:6 }}>
          <img
            src="https://www.themoviedb.org/assets/2/v4/logos/v2/blue_short-8e7b30f73a4020692ccca9c88bafe5dcb20f582e4c76e05c5a0d4c78c48f9a8b.svg"
            alt="TMDB"
            style={{ height:12, opacity:0.5 }}
          />
          <span style={{ color:C.muted, fontSize:10 }}>
            This product uses the TMDB API but is not endorsed or certified by TMDB.
          </span>
        </div>
        <div style={{ color:C.muted, fontSize:10 }}>
          Ratings &amp; metadata provided by{" "}
          <a href="https://www.omdbapi.com" target="_blank" rel="noopener noreferrer"
            style={{ color:C.muted, textDecoration:"underline" }}>OMDb API</a>.
        </div>
      </div>
    </div>
  );
}

// ─── Movie Night Screen ──────────────────────────────────────────────────────
// Sub-home for the Movie Night activity. Users land here after tapping the
// Movie Night tile on home and choose to either start a fresh session or join
// an existing one (via QR or code).
function MovieNightScreen({ onCreateSession, onJoinSession, onScanQR }) {
  return (
    <div style={{ paddingTop:24, display:"flex", flexDirection:"column", gap:24, alignItems:"center" }}>
      <div style={{ textAlign:"center" }}>
        <div style={{ fontSize:56, marginBottom:8, lineHeight:1 }}>🎬</div>
        <h2 style={{ margin:0, fontSize:24, fontWeight:900, color:C.text, fontFamily:"Georgia, serif", letterSpacing:-0.5 }}>NetPix</h2>
        <p style={{ color:C.muted, fontSize:13, margin:"6px 0 0", maxWidth:280, lineHeight:1.5 }}>
          Swipe through movies with friends and pick what to watch together.
        </p>
      </div>

      {/* Primary: start a new session */}
      <Btn onClick={onCreateSession} big>Create a Session</Btn>

      {/* Secondary: join an existing session */}
      <div style={{ width:"100%" }}>
        <div style={{ textAlign:"center", color:C.muted, fontSize:13, fontWeight:700, marginBottom:10, letterSpacing:0.5 }}>
          — or join one —
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <Btn onClick={onScanQR} outline flex>📷 Scan QR Code</Btn>
          <Btn onClick={onJoinSession} outline flex>Enter Code</Btn>
        </div>
      </div>
    </div>
  );
}

// ─── Sign-In Screen (optional email identity) ─────────────────────────────────
function SignInScreen({ onSignedIn, onCancel }) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    const clean = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
      setError("Please enter a valid email address");
      return;
    }
    const cleanName = displayName.trim();
    if (!cleanName) {
      setError("Please enter a display name");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const userKey = await emailToUserKey(clean);
      // Try to load an existing profile; if none exists, create a fresh one
      let prof = await getProfile(userKey);
      if (!prof) {
        prof = { email: clean, userKey, displayName: cleanName, createdAt: Date.now(), sessions: [] };
        await putProfile(userKey, prof);
      } else {
        // Existing profile — keep their sessions, but update email/key and let the
        // newly-entered name overwrite the saved one (a returning user might want to
        // change how they appear in sessions).
        prof = { ...prof, email: clean, userKey, displayName: cleanName };
        await putProfile(userKey, prof);
      }
      onSignedIn(prof);
    } catch (e) {
      setError("Could not sign in. Try again?");
      setBusy(false);
    }
  };

  return (
    <div style={{ paddingTop:24, display:"flex", flexDirection:"column", gap:20 }}>
      <div style={{ textAlign:"center" }}>
        <div style={{ fontSize:44, marginBottom:8 }}>💾</div>
        <h2 style={{ margin:"0 0 6px", fontSize:22 }}>Save your picks</h2>
        <p style={{ color:C.muted, fontSize:13, margin:0, lineHeight:1.5 }}>
          Optional — enter your email to remember which movies you've watched and your
          past genre preferences. No password, no marketing, no tracking. You can sign out
          and delete your data anytime.
        </p>
      </div>

      <Field label="Email" required>
        <input
          type="email"
          value={email}
          onChange={e => { setEmail(e.target.value); setError(""); }}
          onKeyDown={e => e.key === "Enter" && submit()}
          placeholder="you@example.com"
          autoComplete="email"
          autoCapitalize="off"
          style={inputStyle}
        />
      </Field>

      <Field label="Display name" required>
        <input
          type="text"
          value={displayName}
          onChange={e => { setDisplayName(e.target.value); setError(""); }}
          onKeyDown={e => e.key === "Enter" && submit()}
          placeholder="e.g. Alex"
          autoComplete="given-name"
          maxLength={30}
          style={inputStyle}
        />
        <div style={{ fontSize:11, color:C.muted, marginTop:4 }}>
          This is the name your friends will see in sessions. You won't have to type it again.
        </div>
      </Field>

      {error && <div style={{ color:C.red, fontSize:13 }}>{error}</div>}

      <div style={{ fontSize:11, color:C.muted, lineHeight:1.5, background:C.card, border:`1px solid ${C.border}`, borderRadius:10, padding:"10px 14px" }}>
        Your email is hashed before it's used as a storage key. Profiles auto-expire
        after 90 days of inactivity.
      </div>

      <Btn onClick={submit} big disabled={busy || !email.trim()}>{busy ? "Saving…" : "Continue →"}</Btn>
      <button onClick={onCancel} style={{ background:"transparent", border:"none", color:C.muted, fontSize:13, cursor:"pointer", padding:"4px" }}>
        No thanks
      </button>
    </div>
  );
}

// ─── QR Scan Screen ───────────────────────────────────────────────────────────
// Opens the device camera and scans for a CouchPix session QR code. When detected
// we extract the session ID from the URL (?session=XXXXXX) and route to the
// join flow with the code pre-filled.
function QRScanScreen({ onDetected, onCancel }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("Point your camera at the QR code");

  // Start camera + decode loop on mount
  useEffect(() => {
    let cancelled = false;
    let jsQRMod;

    async function start() {
      try {
        // Lazy-load jsQR so the bundle stays small on the home screen
        jsQRMod = (await import("jsqr")).default;
        if (cancelled) return;

        if (!navigator.mediaDevices?.getUserMedia) {
          setError("Your browser doesn't support camera access. Use the Enter Code option instead.");
          return;
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } }, // prefer rear camera
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach(t => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();

        // Decode loop — sample a frame from <video> into a hidden <canvas>
        // and pass the pixel data to jsQR.
        const canvas = canvasRef.current;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });

        const tick = () => {
          if (cancelled || video.readyState !== video.HAVE_ENOUGH_DATA) {
            rafRef.current = requestAnimationFrame(tick);
            return;
          }
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQRMod(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
          if (code?.data) {
            // Parse the QR — accept either a full CouchPix URL or a bare session code
            const match = code.data.match(/[?&]session=([A-Z0-9]{4,10})/i) || code.data.match(/^([A-Z0-9]{4,10})$/i);
            if (match) {
              setStatus("Code found — joining…");
              cancelled = true;
              onDetected(match[1].toUpperCase());
              return;
            } else {
              setStatus("That's a QR code but not a CouchPix one — try again");
            }
          }
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch (e) {
        if (cancelled) return;
        if (e.name === "NotAllowedError") {
          setError("Camera access was denied. Use the Enter Code option instead.");
        } else if (e.name === "NotFoundError") {
          setError("No camera found on this device.");
        } else {
          setError("Couldn't open the camera. Use the Enter Code option instead.");
        }
      }
    }

    start();

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
        streamRef.current = null;
      }
    };
  }, [onDetected]);

  return (
    <div style={{ paddingTop:20, display:"flex", flexDirection:"column", gap:16, alignItems:"center" }}>
      <div style={{ textAlign:"center" }}>
        <h2 style={{ margin:"0 0 4px", fontSize:20 }}>Scan a QR Code</h2>
        <p style={{ color:C.muted, margin:0, fontSize:13 }}>{error || status}</p>
      </div>

      {!error && (
        <div style={{
          position:"relative",
          width:"100%",
          maxWidth:360,
          aspectRatio:"1/1",
          borderRadius:18,
          overflow:"hidden",
          background:"#000",
          boxShadow:`0 8px 24px ${C.accent}22`,
          border:`1px solid ${C.border}`,
        }}>
          <video
            ref={videoRef}
            playsInline
            muted
            style={{ width:"100%", height:"100%", objectFit:"cover", display:"block" }}
          />
          {/* Reticle */}
          <div style={{
            position:"absolute", top:"15%", left:"15%", right:"15%", bottom:"15%",
            border:`3px solid ${C.accent}`, borderRadius:14, pointerEvents:"none",
            boxShadow:`0 0 0 9999px rgba(0,0,0,0.35)`,
          }} />
        </div>
      )}

      {/* Hidden canvas — used as a scratchpad to decode video frames */}
      <canvas ref={canvasRef} style={{ display:"none" }} />

      <Btn onClick={onCancel} outline>Cancel</Btn>
    </div>
  );
}

// ─── Profile Screen ───────────────────────────────────────────────────────────
function ProfileScreen({ profile, setProfile, onSignOut, onHome }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(profile?.displayName || "");

  const saveDisplayName = async () => {
    const cleaned = nameDraft.trim();
    if (!cleaned || cleaned === profile?.displayName) {
      setEditingName(false);
      return;
    }
    const updated = { ...profile, displayName: cleaned };
    setProfile(updated);
    setEditingName(false);
    await putProfile(profile.userKey, updated);
  };

  if (!profile?.email) {
    return (
      <div style={{ paddingTop:40, textAlign:"center", color:C.muted }}>
        You're not signed in.
        <div style={{ marginTop:12 }}>
          <Btn onClick={onHome} outline>Back to home</Btn>
        </div>
      </div>
    );
  }

  const sessions = profile.sessions || [];

  // Aggregate stats across saved sessions
  const genreCounts = {};
  const vetoCounts = {};
  let totalYes = 0, totalNo = 0, totalPassion = 0;
  for (const s of sessions) {
    (s.genres || []).forEach(g => { genreCounts[g] = (genreCounts[g] || 0) + 1; });
    if (s.veto) vetoCounts[s.veto] = (vetoCounts[s.veto] || 0) + 1;
    totalYes += s.votes?.yes || 0;
    totalNo  += s.votes?.no  || 0;
    if (s.passionPick) totalPassion += 1;
  }
  const topGenres = Object.entries(genreCounts).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const topVetoes = Object.entries(vetoCounts).sort((a, b) => b[1] - a[1]).slice(0, 3);

  const handleSignOut = async () => {
    if (confirmDelete) {
      // Hard delete the server-side profile too
      try { await fetch(`${TMDB_PROXY}/user/${profile.userKey}`, { method: "DELETE" }); } catch {}
    }
    onSignOut();
  };

  return (
    <div style={{ paddingTop:24, display:"flex", flexDirection:"column", gap:20 }}>
      {/* Header card */}
      <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:12, padding:16, display:"flex", alignItems:"center", gap:14 }}>
        <div style={{ width:48, height:48, borderRadius:"50%", background:C.accentSoft, color:C.accent, display:"flex", alignItems:"center", justifyContent:"center", fontSize:20, fontWeight:800 }}>
          {(profile.displayName?.[0] || profile.email[0])?.toUpperCase()}
        </div>
        <div style={{ flex:1, minWidth:0 }}>
          {editingName ? (
            <div style={{ display:"flex", gap:6, alignItems:"center" }}>
              <input
                value={nameDraft}
                onChange={e => setNameDraft(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") saveDisplayName(); if (e.key === "Escape") { setNameDraft(profile.displayName || ""); setEditingName(false); } }}
                autoFocus
                maxLength={30}
                style={{ ...inputStyle, padding:"6px 10px", fontSize:14 }}
              />
              <button onClick={saveDisplayName} style={{ background:C.accent, border:"none", color:"#fff", borderRadius:8, padding:"6px 12px", fontSize:12, fontWeight:700, cursor:"pointer" }}>Save</button>
            </div>
          ) : (
            <>
              <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                <div style={{ fontSize:15, fontWeight:700, color:C.text, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                  {profile.displayName || profile.email.split("@")[0]}
                </div>
                <button
                  onClick={() => { setNameDraft(profile.displayName || ""); setEditingName(true); }}
                  title="Edit display name"
                  style={{ background:"transparent", border:"none", color:C.muted, fontSize:12, cursor:"pointer", padding:"2px 4px" }}
                >✎</button>
              </div>
              <div style={{ fontSize:12, color:C.muted, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{profile.email}</div>
              <div style={{ fontSize:11, color:C.muted, marginTop:2 }}>{sessions.length} session{sessions.length === 1 ? "" : "s"} saved</div>
            </>
          )}
        </div>
      </div>

      {/* Stats */}
      {sessions.length > 0 ? (
        <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8 }}>
            <Stat label="Sessions" value={sessions.length} />
            <Stat label="Yes swipes" value={totalYes} />
            <Stat label="Stars used" value={totalPassion} />
          </div>
          {topGenres.length > 0 && (
            <Field label="Most-picked genres">
              <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                {topGenres.map(([g, n]) => (
                  <span key={g} style={{ background:C.accentSoft, color:C.accent, borderRadius:20, padding:"3px 10px", fontSize:12, fontWeight:600, border:`1px solid ${C.accent}44` }}>
                    {g} · {n}
                  </span>
                ))}
              </div>
            </Field>
          )}
          {topVetoes.length > 0 && (
            <Field label="Most-vetoed">
              <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                {topVetoes.map(([g, n]) => (
                  <span key={g} style={{ background:C.redSoft, color:C.red, borderRadius:20, padding:"3px 10px", fontSize:12, fontWeight:600, border:`1px solid ${C.red}44` }}>
                    {g} · {n}
                  </span>
                ))}
              </div>
            </Field>
          )}
        </div>
      ) : (
        <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:12, padding:20, textAlign:"center", color:C.muted, fontSize:13 }}>
          No sessions saved yet. Complete a movie night to see it here.
        </div>
      )}

      {/* Session history */}
      {sessions.length > 0 && (
        <Field label={`Recent sessions (${sessions.length})`}>
          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            {sessions.slice().reverse().slice(0, 20).map(s => (
              <div key={s.id + ":" + s.date} style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:10, overflow:"hidden" }}>
                <div style={{ padding:"10px 12px", display:"flex", alignItems:"center", gap:10, borderBottom: s.finalMovies?.length ? `1px solid ${C.border}` : "none" }}>
                  <div style={{ fontSize:11, color:C.muted, flex:1 }}>
                    {new Date(s.date).toLocaleDateString(undefined, { month:"short", day:"numeric", year:"numeric" })}
                    {" · "}
                    {s.role === "admin" ? "Host" : "Guest"}
                    {s.participantCount > 1 && ` · ${s.participantCount} people`}
                  </div>
                  {s.passionPick && <span style={{ fontSize:11, color:C.gold }}>★</span>}
                </div>
                {s.finalMovies?.length > 0 && (
                  <div style={{ padding:"8px 12px 10px", display:"flex", flexDirection:"column", gap:6 }}>
                    {s.finalMovies.slice(0, 3).map(m => (
                      <div key={m.id} style={{ display:"flex", alignItems:"center", gap:8 }}>
                        <div style={{ width:24, height:36, background:C.surface, borderRadius:4, overflow:"hidden", flexShrink:0 }}>
                          {m.poster && <img src={m.poster} alt="" style={{ width:"100%", height:"100%", objectFit:"cover" }} />}
                        </div>
                        <div style={{ fontSize:13, color:C.text, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                          {m.title} <span style={{ color:C.muted, fontSize:11 }}>· {m.year}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Field>
      )}

      <div style={{ display:"flex", flexDirection:"column", gap:8, marginTop:8 }}>
        <label style={{ display:"flex", alignItems:"center", gap:8, color:C.muted, fontSize:12, cursor:"pointer" }}>
          <input type="checkbox" checked={confirmDelete} onChange={e => setConfirmDelete(e.target.checked)} />
          Also delete my saved data from the server
        </label>
        <Btn onClick={handleSignOut} outline>Sign out</Btn>
        <Btn onClick={onHome} outline>Back to home</Btn>
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:10, padding:"10px 8px", textAlign:"center" }}>
      <div style={{ fontSize:22, fontWeight:800, color:C.text }}>{value}</div>
      <div style={{ fontSize:10, color:C.muted, textTransform:"uppercase", letterSpacing:0.6 }}>{label}</div>
    </div>
  );
}

// ─── Setup Screen ─────────────────────────────────────────────────────────────
function SetupScreen({ userId, userName, setUserName, onCreated }) {
  // Initialize from the global userName (which the App effect pre-fills from the
  // signed-in profile's displayName). If empty, the user can still type a name.
  const [name, setName] = useState(userName || "");

  const create = () => {
    if (!name.trim()) return alert("Please enter your name");
    // Remember the name globally too so future sessions skip this step
    if (setUserName) setUserName(name.trim());
    const sid = generateSessionCode();
    const session = {
      id: sid,
      adminId: userId,
      activity: ACTIVITIES.MOVIES,
      participants: [{ id: userId, name: name.trim(), votes: {}, done: false, genres: [], vetoes: [], passionPick: null, prefsDone: false }],
      criteria: { services: [], subscriptionOnly: false, duration: null, languages: ["en"] },
      movies: [],
      started: false,
      round: 1,
    };
    putSession(session).then(() => onCreated(session));
  };

  return (
    <div style={{ paddingTop:24, display:"flex", flexDirection:"column", gap:24 }}>
      <Field label="Your Name" required>
        <input value={name} onChange={e=>setName(e.target.value)} placeholder="e.g. Alex" style={inputStyle} />
      </Field>

      <Btn onClick={create} big>Create Session →</Btn>
    </div>
  );
}

// ─── Lobby Screen ─────────────────────────────────────────────────────────────
function LobbyScreen({ session, userId, onStarted, onSync }) {
  const [copied, setCopied] = useState(false);
  const sessionUrl = `${window.location.origin}${window.location.pathname}?session=${session?.id}`;

  useAdaptivePoll(session?.id, (s) => {
    if (s.started === true && session.started !== true) {
      onStarted(s);
    } else {
      onSync(s);
    }
  });

  const copyUrl = () => {
    navigator.clipboard.writeText(sessionUrl).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  };

  // Native Share Sheet — lets the admin send the invite via iMessage / WhatsApp /
  // any installed app. Falls back to copy if the browser doesn't support it.
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
  const shareUrl = async () => {
    // Name the activity so the invite reads right. Only movie (NetPix) and food
    // (FoodPix) sessions ever reach the lobby — Unhinged Questions runs locally
    // on the admin's device and never creates a shared session.
    const activityLabel = session?.activity === ACTIVITIES.FOOD ? "FoodPix" : "NetPix";
    const text = `Join my CouchPix ${activityLabel} session`;
    try {
      if (canShare) {
        await navigator.share({ title: "CouchPix", text, url: sessionUrl });
      } else {
        copyUrl();
      }
    } catch (e) {
      // User cancelled the share sheet — no-op
      if (e?.name !== "AbortError") copyUrl();
    }
  };

  const startSession = () => {
    getSession(session.id).then(fresh => {
      if (!fresh) return;
      fresh.started = true;
      putSession(fresh).then(() => onStarted(fresh));
    });
  };

  if (!session) return null;
  const isAdmin = session.adminId === userId;

  return (
    <div style={{ paddingTop:24, display:"flex", flexDirection:"column", gap:20 }}>
      <div style={{ textAlign:"center" }}>
        <div style={{ fontSize:13, color:C.muted, marginBottom:4 }}>Session Code</div>
        <div style={{ fontSize:40, fontWeight:900, letterSpacing:8, color:C.accent, fontFamily:"monospace" }}>{session.id}</div>
      </div>

      <div style={{ display:"flex", justifyContent:"center" }}>
        <MiniQR text={sessionUrl} size={180} />
      </div>

      <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
        {/* Big primary share button — opens the OS share sheet so the admin can
            text/iMessage/WhatsApp the link in one tap. Falls back to copy if
            navigator.share isn't supported (mainly older desktop browsers). */}
        <Btn onClick={shareUrl} big>📤 Share invite link</Btn>
        <div style={{ display:"flex", gap:8 }}>
          <input value={sessionUrl} readOnly style={{ ...inputStyle, flex:1, fontSize:12, color:C.muted }} />
          <Btn onClick={copyUrl} outline>{copied ? "✓ Copied" : "Copy"}</Btn>
        </div>
      </div>

      <div style={{ background:C.card, borderRadius:12, padding:16, border:`1px solid ${C.border}` }}>
        <div style={{ fontSize:13, color:C.muted, marginBottom:12 }}>Participants ({session.participants?.length || 0})</div>
        {session.participants?.map(p => (
          <div key={p.id} style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 0", borderBottom:`1px solid ${C.border}` }}>
            <div style={{ width:32, height:32, borderRadius:"50%", background:C.accent, display:"flex", alignItems:"center", justifyContent:"center", fontSize:14, fontWeight:700 }}>
              {p.name[0].toUpperCase()}
            </div>
            <span style={{ flex:1 }}>{p.name}</span>
            {p.id === session.adminId && <span style={{ fontSize:11, color:C.gold, background:`${C.gold}22`, padding:"2px 8px", borderRadius:10 }}>Admin</span>}
          </div>
        ))}
      </div>

      {isAdmin ? (
        <Btn onClick={startSession} big disabled={!session.participants?.length}>Start Session →</Btn>
      ) : (
        <div style={{ textAlign:"center", color:C.muted, padding:16, background:C.card, borderRadius:12, border:`1px solid ${C.border}` }}>
          Waiting for the organizer to start…
          <div style={{ marginTop:8 }}><span style={{ display:"inline-block", animation:"spin 1s linear infinite" }}>⟳</span></div>
        </div>
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ─── Preferences Screen ───────────────────────────────────────────────────────
const YEAR_MIN = 1920;

function PreferencesScreen({ session, userId, profile, setProfile, onMoviesReady }) {
  const isAdmin = session.adminId === userId;
  const participantCount = session.participants?.length || 1;
  const maxGenres = participantCount > 3 ? 2 : 3;
  const currentYear = new Date().getFullYear();

  const [genres, setGenres] = useState([]);
  const [vetoes, setVetoes] = useState([]); // up to 2 vetoed genres
  const [services, setServices] = useState([]);
  const [subscriptionOnly, setSubscriptionOnly] = useState(false);
  const [duration, setDuration] = useState(null); // null | "short" | "long"
  const [languages, setLanguages] = useState(["en"]); // English default
  const [yearFrom, setYearFrom] = useState(1980);
  const [yearTo, setYearTo] = useState(() => new Date().getFullYear());
  const ALL_RATINGS = ["G", "PG", "PG-13", "R"];
  const [allowedRatings, setAllowedRatings] = useState([...ALL_RATINGS]);
  const toggleRating = (r) => setAllowedRatings(prev =>
    prev.includes(r)
      ? prev.length > 1 ? prev.filter(x => x !== r) : prev // keep at least 1
      : [...prev, r]
  );
  const [submitted, setSubmitted] = useState(false);
  const submittedRef = useRef(false); // ref so the poll closure always reads the current value
  const submittedDataRef = useRef(null); // stores the full session object we PUT, for self-healing
  const generatingRef = useRef(false); // prevent concurrent discover calls across adaptive polls
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);
  const [latestSession, setLatestSession] = useState(session);

  const MAX_VETOES = 1;
  const toggleGenre = g => {
    // Selecting a genre auto-clears its veto if present (can't both want and avoid)
    setVetoes(prev => prev.filter(x => x !== g));
    setGenres(prev =>
      prev.includes(g) ? prev.filter(x => x !== g) : prev.length < maxGenres ? [...prev, g] : prev
    );
  };
  const toggleVeto = g => {
    // Vetoing a genre auto-clears its pick if present
    setGenres(prev => prev.filter(x => x !== g));
    setVetoes(prev =>
      prev.includes(g) ? prev.filter(x => x !== g) : prev.length < MAX_VETOES ? [...prev, g] : prev
    );
  };
  const toggleService = s => setServices(prev =>
    prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s]
  );
  const toggleLanguage = code => setLanguages(prev =>
    prev.includes(code)
      ? prev.length > 1 ? prev.filter(x => x !== code) : prev // always keep at least one
      : [...prev, code]
  );

  // Poll for updates and movie readiness (adaptive cadence — fewer reads while idle).
  useAdaptivePoll(session.id, (s) => {
    const generateAndAdvance = (sess) => {
      if (generatingRef.current) return;
      generatingRef.current = true;
      discoverMovies(sess).then(movies => {
        if (!mountedRef.current) return;
        const updated = {
          ...sess,
          movies: movies.length ? movies : sess.movies,
          moviesGenerated: true,
        };
        putSession(updated).then(() => { if (mountedRef.current) onMoviesReady(updated); });
      });
    };

    // Self-healing KV race fix: if we submitted but our prefsDone was clobbered by
    // a concurrent write (e.g. admin and participant wrote at the same time from the
    // same stale snapshot), detect it and re-write our data merged onto the fresh KV base.
    if (submittedRef.current && submittedDataRef.current) {
      const me = s.participants?.find(p => p.id === userId);
      if (me && !me.prefsDone) {
        // Our write was lost — restore our participant data onto the current KV base
        const ourParticipant = submittedDataRef.current.participants?.find(p => p.id === userId);
        const restored = {
          ...s, // fresh KV base (preserves other participants' state)
          participants: s.participants.map(p =>
            p.id === userId ? (ourParticipant || { ...p, prefsDone: true }) : p
          ),
          ...(isAdmin && { criteria: submittedDataRef.current.criteria }),
        };
        putSession(restored); // fire-and-forget re-write
        s = restored;        // use restored state for local checks below
      }
    } else if (submittedRef.current) {
      // submittedDataRef not yet set (very rare timing) — at least force prefsDone on display
      s = {
        ...s,
        participants: s.participants.map(p =>
          p.id === userId ? { ...p, prefsDone: true } : p
        ),
      };
    }

    setLatestSession(s);
    if (s.movies?.length > 0) { onMoviesReady(s); return; }
    if (s.moviesGenerated) { onMoviesReady(s); return; }

    if (s.adminId === userId) {
      const allDone = s.participants.every(p => p.prefsDone);
      if (allDone) generateAndAdvance(s);
    }
  });

  // Admin can only confirm once all other participants have submitted their genres.
  // This ensures admin's write always lands last on a settled KV base, eliminating
  // the concurrent write race entirely.
  const otherParticipantsDone = latestSession.participants
    ?.filter(p => p.id !== userId)
    .every(p => p.prefsDone) ?? true; // true when solo (no others to wait for)

  const submit = () => {
    if (!genres.length) return alert("Please select at least one genre");
    getSession(session.id).then(s => {
      if (!s) return;
      const updated = {
        ...s,
        participants: s.participants.map(p =>
          p.id === userId ? { ...p, genres, vetoes, prefsDone: true } : p
        ),
        criteria: isAdmin
          ? { ...s.criteria, services, subscriptionOnly, duration, languages, yearFrom, yearTo, allowedRatings }
          : s.criteria,
      };
      submittedRef.current = true;
      submittedDataRef.current = updated; // store for self-healing if our write gets clobbered
      setSubmitted(true);
      // Write our preferences to KV and let the poll handle movie generation.
      // Generation must go through one path only (the poll's generateAndAdvance)
      // so all participants read the exact same movie list from KV.
      putSession(updated).then(() => setLatestSession(updated));
    });
  };

  const allDone = latestSession.participants?.every(p => p.prefsDone);
  const myEntry = latestSession.participants?.find(p => p.id === userId);
  const iAmDone = submitted || myEntry?.prefsDone;

  if (iAmDone) {
    return (
      <div style={{ paddingTop: 40, display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
        <div style={{ fontSize: 44 }}>⏳</div>
        <h2 style={{ margin: 0 }}>Waiting for everyone…</h2>
        <div style={{ width: "100%", background: C.card, borderRadius: 12, padding: 16, border: `1px solid ${C.border}` }}>
          {latestSession.participants?.map(p => (
            <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: `1px solid ${C.border}` }}>
              <div style={{ width: 28, height: 28, borderRadius: "50%", background: p.prefsDone ? C.green : C.border, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>
                {p.prefsDone ? "✓" : "…"}
              </div>
              <span style={{ flex: 1 }}>{p.name}</span>
              <span style={{ fontSize: 12, color: p.prefsDone ? C.green : C.muted }}>{p.prefsDone ? "Ready" : "Choosing…"}</span>
            </div>
          ))}
        </div>
        {allDone && <div style={{ color: C.muted, fontSize: 13 }}>Generating movie list…</div>}
      </div>
    );
  }

  // Find the most recent prior session (not this one) and any of its final movies
  // that still need a "did you actually watch this?" answer.
  const priorSession = (profile?.sessions || [])
    .filter(s => s.id !== session.id)
    .slice(-1)[0];
  const unconfirmedFromPrior = (priorSession?.finalMovies || [])
    .filter(m => !m.watchStatus || m.watchStatus === "unconfirmed");

  const answerPriorPick = (movieId, status) => {
    if (!profile?.userKey || !priorSession) return;
    const updatedSessions = (profile.sessions || []).map(s =>
      s.id !== priorSession.id ? s : {
        ...s,
        finalMovies: (s.finalMovies || []).map(m =>
          m.id === movieId ? { ...m, watchStatus: status } : m
        ),
      }
    );
    const updated = { ...profile, sessions: updatedSessions };
    setProfile(updated);
    putProfile(profile.userKey, updated);
  };

  return (
    <div style={{ paddingTop: 24, display: "flex", flexDirection: "column", gap: 24 }}>
      {/* Pre-prefs check: ask about unconfirmed picks from the last session.
          Once all answered, the section vanishes naturally on the next render. */}
      {profile?.userKey && unconfirmedFromPrior.length > 0 && (
        <div style={{ background:C.card, border:`1px solid ${C.gold}66`, borderRadius:12, padding:14, display:"flex", flexDirection:"column", gap:10 }}>
          <div style={{ fontSize:13, fontWeight:700, color:C.gold }}>
            Quick check from last time…
          </div>
          <div style={{ fontSize:12, color:C.muted, marginBottom:2 }}>
            Did you actually watch {unconfirmedFromPrior.length === 1 ? "this" : "any of these"}? Answering helps us avoid recommending them again.
          </div>
          {unconfirmedFromPrior.map(m => (
            <div key={m.id} style={{ display:"flex", alignItems:"center", gap:10, paddingTop:6, borderTop:`1px solid ${C.border}` }}>
              <div style={{ width:36, height:54, background:C.surface, borderRadius:4, overflow:"hidden", flexShrink:0 }}>
                {m.poster && <img src={m.poster} alt="" style={{ width:"100%", height:"100%", objectFit:"cover" }} />}
              </div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:13, fontWeight:600, color:C.text, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{m.title}</div>
                <div style={{ fontSize:11, color:C.muted }}>{m.year}</div>
              </div>
              <div style={{ display:"flex", gap:6 }}>
                <button
                  onClick={() => answerPriorPick(m.id, "watched")}
                  style={{ background:C.greenSoft, border:`1px solid ${C.green}55`, color:C.green, borderRadius:8, padding:"6px 10px", fontSize:11, fontWeight:700, cursor:"pointer" }}
                >Watched</button>
                <button
                  onClick={() => answerPriorPick(m.id, "skipped")}
                  style={{ background:"transparent", border:`1px solid ${C.border}`, color:C.muted, borderRadius:8, padding:"6px 10px", fontSize:11, fontWeight:600, cursor:"pointer" }}
                >Skipped</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 13, color: C.muted }}>What are you in the mood for?</div>
        <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>Pick up to {maxGenres} genre{maxGenres > 1 ? "s" : ""}</div>
      </div>

      <Field label={`Genres (pick up to ${maxGenres})`} required>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {GENRES.map(g => (
            <Chip key={g} active={genres.includes(g)} onClick={() => toggleGenre(g)}
              disabled={!genres.includes(g) && genres.length >= maxGenres}>{g}</Chip>
          ))}
        </div>
        <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>{genres.length}/{maxGenres} selected</div>
      </Field>

      <Field label="Veto (1 genre)">
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 8 }}>
          Block one genre entirely — vetoes override anyone else's pick.
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {GENRES.map(g => (
            <Chip
              key={g}
              active={vetoes.includes(g)}
              onClick={() => toggleVeto(g)}
              disabled={!vetoes.includes(g) && vetoes.length >= MAX_VETOES}
              accentColor={C.red}
            >{g}</Chip>
          ))}
        </div>
        <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>
          {vetoes.length ? `Vetoed: ${vetoes[0]}` : "No veto"}
        </div>
      </Field>

      {isAdmin && (
        <>
          <Field label="Release year">
            <div style={{ display:"flex", alignItems:"center", gap:10 }}>
              <select
                value={yearFrom}
                onChange={e => {
                  const v = parseInt(e.target.value);
                  setYearFrom(v);
                  if (yearTo < v) setYearTo(v);
                }}
                style={{ ...inputStyle, flex:1, appearance:"none", WebkitAppearance:"none", backgroundImage:`url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%2394a3b8'/%3E%3C/svg%3E")`, backgroundRepeat:"no-repeat", backgroundPosition:"right 12px center", paddingRight:30 }}
              >
                {Array.from({ length: currentYear - YEAR_MIN + 1 }, (_, i) => YEAR_MIN + i).map(y => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
              <span style={{ color:C.muted, fontSize:13, flexShrink:0 }}>–</span>
              <select
                value={yearTo}
                onChange={e => setYearTo(parseInt(e.target.value))}
                style={{ ...inputStyle, flex:1, appearance:"none", WebkitAppearance:"none", backgroundImage:`url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%2394a3b8'/%3E%3C/svg%3E")`, backgroundRepeat:"no-repeat", backgroundPosition:"right 12px center", paddingRight:30 }}
              >
                {Array.from({ length: currentYear - yearFrom + 1 }, (_, i) => yearFrom + i).map(y => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </div>
          </Field>

          <Field label="Audio language">
            <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>Select all languages you're open to</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {LANGUAGES.map(lang => (
                <Chip
                  key={lang.code}
                  active={languages.includes(lang.code)}
                  onClick={() => toggleLanguage(lang.code)}
                  disabled={languages.includes(lang.code) && languages.length === 1}
                >
                  {lang.label}
                </Chip>
              ))}
            </div>
          </Field>

          <Field label="Movie length (optional)">
            <div style={{ display: "flex", gap: 8 }}>
              {[
                { value: null, label: "Any length" },
                { value: "short", label: "Under 2 hrs" },
                { value: "long", label: "Over 2 hrs" },
              ].map(opt => (
                <button key={String(opt.value)} onClick={() => setDuration(opt.value)}
                  style={{ flex: 1, padding: "10px 8px", borderRadius: 10, border: `1.5px solid ${duration === opt.value ? C.accent : C.border}`, background: duration === opt.value ? C.accentSoft : "transparent", color: duration === opt.value ? C.accent : C.text, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
                  {opt.label}
                </button>
              ))}
            </div>
          </Field>

          <Field label="Ratings">
            <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>Deselect ratings to exclude them</div>
            <div style={{ display: "flex", gap: 8 }}>
              {ALL_RATINGS.map(r => {
                const active = allowedRatings.includes(r);
                return (
                  <button key={r} onClick={() => toggleRating(r)}
                    style={{ flex: 1, padding: "10px 8px", borderRadius: 10, border: `1.5px solid ${active ? C.accent : C.border}`, background: active ? C.accentSoft : "transparent", color: active ? C.accent : C.muted, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
                    {r}
                  </button>
                );
              })}
            </div>
          </Field>

          <Field label="Streaming services (optional)">
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {SERVICES.map(s => (
                <Chip key={s.id} active={services.includes(s.id)} onClick={() => toggleService(s.id)} accentColor={s.color}>{s.label}</Chip>
              ))}
            </div>
            {services.length > 0 && (
              <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ fontSize: 12, color: C.muted }}>Movies will be filtered to these services</div>
                <button
                  onClick={() => setSubscriptionOnly(v => !v)}
                  style={{ display: "flex", alignItems: "center", gap: 10, background: "transparent", border: `1px solid ${subscriptionOnly ? C.accent : C.border}`, borderRadius: 10, padding: "10px 14px", cursor: "pointer", textAlign: "left" }}
                >
                  <div style={{ width: 36, height: 20, borderRadius: 10, flexShrink: 0, background: subscriptionOnly ? C.accent : C.border, position: "relative" }}>
                    <div style={{ position: "absolute", top: 3, left: subscriptionOnly ? 19 : 3, width: 14, height: 14, borderRadius: "50%", background: "#fff", transition: "left 0.2s" }} />
                  </div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: subscriptionOnly ? C.accent : C.text }}>Subscription only</div>
                    <div style={{ fontSize: 11, color: C.muted, marginTop: 1 }}>{subscriptionOnly ? "Only free with subscription" : "Also include rentals"}</div>
                  </div>
                </button>
              </div>
            )}
          </Field>
        </>
      )}

      {isAdmin && !otherParticipantsDone && (
        <div style={{ textAlign: "center", fontSize: 12, color: C.muted }}>
          Waiting for other participants to submit selections…
        </div>
      )}
      <Btn onClick={submit} big disabled={!genres.length || (isAdmin && !otherParticipantsDone)}>Confirm Preferences →</Btn>
    </div>
  );
}

// ─── Join Screen ──────────────────────────────────────────────────────────────
function JoinScreen({ session, userId, userName, setUserName, onJoined, onSessionLoad }) {
  const [code, setCode] = useState(session?.id || "");
  const [localName, setLocalName] = useState(userName || "");
  const [error, setError] = useState("");

  const [joining, setJoining] = useState(false);
  const join = () => {
    if (!localName.trim()) return setError("Please enter your name");
    const sid = code.trim().toUpperCase();
    if (!sid) return setError("Please enter a session code");
    setJoining(true);
    setError("");
    getSession(sid).then(s => {
      if (!s) { setError("Session not found. Check the code or ask the host to reshare the link."); setJoining(false); return; }
      if (!s.participants.find(p => p.id === userId)) {
        s.participants.push({ id: userId, name: localName.trim(), votes: {}, done: false, genres: [], vetoes: [], passionPick: null, prefsDone: false });
      }
      setUserName(localName.trim());
      putSession(s).then(() => { setJoining(false); onJoined(s); });
    });
  };

  return (
    <div style={{ paddingTop:40, display:"flex", flexDirection:"column", gap:20 }}>
      <div style={{ textAlign:"center", marginBottom:8 }}>
        <div style={{ fontSize:40 }}>🔗</div>
        <p style={{ color:C.muted, margin:"8px 0 0" }}>Enter the session code from the host's screen</p>
      </div>
      <Field label="Your Name" required>
        <input value={localName} onChange={e=>setLocalName(e.target.value)} placeholder="e.g. Jordan" style={inputStyle} />
      </Field>
      <Field label="Session Code" required>
        <input value={code} onChange={e=>setCode(e.target.value.toUpperCase())} placeholder="e.g. AB12CD" maxLength={6} style={{ ...inputStyle, fontFamily:"monospace", fontSize:22, letterSpacing:6, textAlign:"center" }} />
      </Field>
      {error && <div style={{ color:C.red, fontSize:13, background:C.redSoft, borderRadius:8, padding:"10px 14px" }}>{error}</div>}
      <Btn onClick={join} big disabled={joining}>{joining ? "Joining…" : "Join Session →"}</Btn>
    </div>
  );
}

// ─── Swiping Screen ───────────────────────────────────────────────────────────
function SwipingScreen({ session, userId, profile, setProfile, onDone }) {
  const [idx, setIdx] = useState(0);
  const [votes, setVotes] = useState({});
  const [animDir, setAnimDir] = useState(null);
  const [history, setHistory] = useState([]); // stack of {idx, vote, movieId} for undo
  // Each user has one "passion pick" — a movie they really want to watch. Used as a
  // tiebreaker on the results screen when no movie reaches a clear majority. Selected
  // on the Review screen so the user can compare across the full deck.
  const [myPassionPick, setMyPassionPick] = useState(null);
  const [reviewTrailer, setReviewTrailer] = useState(null); // { id, title } | null
  // Two-phase flow: "swiping" → "review" → submit
  const [phase, setPhase] = useState("swiping");
  const [submitting, setSubmitting] = useState(false);
  const lockedMovies = useRef(null); // frozen once swiping starts to prevent mid-swipe list changes

  if (!session || !session.movies?.length) return <div style={{ padding:40, textAlign:"center", color:C.muted }}>No movies found. Try adjusting your criteria.</div>;

  const criteria = session.criteria || {};
  const candidatePool = session.movies;
  const tmdbData = useTMDBMovieData(candidatePool);

  // tmdbData[id] === undefined → not yet fetched; null → fetched but failed; object → success
  const tmdbLoaded = candidatePool.every(m => tmdbData[m.id] !== undefined);
  const needsStreamingFilter = criteria.services?.length > 0;

  // Compute the list, then lock it into a ref so tmdbData updates mid-swipe can't change the length
  const computedMovies = (needsStreamingFilter && tmdbLoaded)
    ? applyStreamingFilter(candidatePool, criteria, tmdbData)
    : candidatePool.slice(0, 10);

  if (!lockedMovies.current && computedMovies.length > 0 && (!needsStreamingFilter || tmdbLoaded)) {
    lockedMovies.current = computedMovies;
  }
  const movies = lockedMovies.current || computedMovies;

  const current = movies[idx];

  // Prefetch trailer keys + thumbnails for the current and next couple of cards so
  // swiping forward paints the trailer image instantly instead of flashing.
  useEffect(() => {
    for (let i = idx; i <= idx + 2 && i < movies.length; i++) {
      if (movies[i]?.id != null) prefetchTrailer(movies[i].id);
    }
  }, [idx, movies]);

  // Show loading state while waiting for TMDB data if services are selected
  if (needsStreamingFilter && !tmdbLoaded) {
    return (
      <div style={{ paddingTop:60, textAlign:"center", display:"flex", flexDirection:"column", alignItems:"center", gap:16, color:C.muted }}>
        <div style={{ fontSize:40 }}>🎬</div>
        <div style={{ fontSize:16, fontWeight:600, color:C.text }}>Finding movies on your services…</div>
        <div style={{ fontSize:13 }}>Checking streaming availability</div>
        <div style={{ width:200, height:4, background:C.border, borderRadius:2, overflow:"hidden" }}>
          <div style={{ height:"100%", width:`${(Object.keys(tmdbData).length / candidatePool.length) * 100}%`, background:C.accent, borderRadius:2, transition:"width 0.3s" }} />
        </div>
      </div>
    );
  }

  if (!movies.length) {
    return (
      <div style={{ paddingTop:60, textAlign:"center", display:"flex", flexDirection:"column", alignItems:"center", gap:16 }}>
        <div style={{ fontSize:40 }}>😕</div>
        <div style={{ fontSize:16, fontWeight:600, color:C.text }}>No movies found on your services</div>
        <p style={{ color:C.muted, fontSize:13, maxWidth:300 }}>
          None of the {criteria.subscriptionOnly ? "subscription" : "streaming or rental"} options matched your selected services. Try adding more services or turning off the subscription-only filter.
        </p>
      </div>
    );
  }

  const swipe = (dir) => {
    if (animDir || !current) return; // prevent double-trigger during animation
    setAnimDir(dir);
    const newVotes = { ...votes, [current.id]: dir };
    setVotes(newVotes);
    setHistory(h => [...h, { idx, vote: dir, movieId: current.id }]);

    setTimeout(() => {
      setAnimDir(null);
      if (idx + 1 >= movies.length) {
        // Move to review instead of submitting straight to KV — gives the user
        // a chance to compare across the full deck before locking in their
        // passion pick.
        setPhase("review");
      } else {
        setIdx(i => i + 1);
      }
    }, 300);
  };

  const undo = () => {
    if (!history.length || animDir) return;
    const last = history[history.length - 1];
    setHistory(h => h.slice(0, -1));
    setVotes(v => {
      const next = { ...v };
      delete next[last.movieId];
      return next;
    });
    setIdx(last.idx);
    setAnimDir(null);
  };

  // ── Review-phase handlers ──────────────────────────────────────────────────
  const setReviewVote = (movieId, vote) => {
    setVotes(v => ({ ...v, [movieId]: vote }));
    // If user switches a starred movie to "no", clear the star — only yes-voted
    // movies can be passion picks (the results screen requires both signals).
    if (vote === "no" && myPassionPick === movieId) setMyPassionPick(null);
  };

  const toggleStar = (movieId) => {
    if (votes[movieId] !== "yes") return; // can only star yes-voted movies
    setMyPassionPick(p => (p === movieId ? null : movieId));
  };

  // "Don't show again" — stores the ID in profile.hiddenMovieIds so discoverMovies
  // excludes it from all future sessions. Only available when signed in.
  const isHidden = (movieId) => (profile?.hiddenMovieIds || []).includes(movieId);
  const toggleHidden = (movieId) => {
    if (!profile?.userKey) return;
    const current = profile.hiddenMovieIds || [];
    const next = current.includes(movieId)
      ? current.filter(id => id !== movieId)
      : [...current, movieId];
    const updated = { ...profile, hiddenMovieIds: next };
    setProfile(updated);
    putProfile(profile.userKey, updated);
  };

  const submitFinal = () => {
    if (submitting) return;
    setSubmitting(true);
    getSession(session.id).then(stored => {
      if (!stored) { setSubmitting(false); return; }
      const me = stored.participants?.find(p => p.id === userId);
      if (me) {
        me.votes = votes;
        me.done = true;
        me.passionPick = myPassionPick;
      }
      stored.movies = movies;
      putSession(stored).then(() => onDone({ ...stored }));
    });
  };

  // ── Compute "why this matched" badges for the current card ──
  // 1) Per movie genre, find which participants picked it (excluding self → "Your pick").
  // 2) For each selected streaming service the movie is available on, show a colored chip.
  const computeMatches = (m) => {
    if (!m) return [];
    const out = [];
    const participants = session.participants || [];
    for (const g of m.genres || []) {
      const fans = participants.filter(p => (p.genres || []).includes(g));
      if (!fans.length) continue;
      const me = fans.find(p => p.id === userId);
      const others = fans.filter(p => p.id !== userId).map(p => p.name.split(" ")[0]);
      let label;
      if (fans.length === participants.length && participants.length > 1) {
        label = `Everyone picked ${g}`;
      } else if (me && others.length === 0) {
        label = `Your ${g} pick`;
      } else if (me) {
        label = `You + ${others.join(", ")} · ${g}`;
      } else {
        label = `${others.join(", ")} · ${g}`;
      }
      out.push({ kind: "genre", label });
    }
    // Streaming service matches (only if admin restricted to specific services)
    const selectedServices = criteria.services || [];
    if (selectedServices.length) {
      const live = tmdbData[m.id]?.streaming || m.streaming || [];
      for (const sid of selectedServices) {
        if (!live.includes(sid)) continue;
        const svc = SERVICES.find(sv => sv.id === sid);
        if (!svc) continue;
        out.push({ kind: "service", label: `On ${svc.label}`, color: svc.color });
      }
    }
    return out;
  };
  const currentMatches = computeMatches(current);

  const progress = (idx / movies.length) * 100;

  // ── Review phase: lets the user audit every vote across the deck and pick
  //    one passion-pick star with full context (you can't make a good "super
  //    like" call mid-swipe when you haven't seen the other 9 movies yet). ──
  if (phase === "review") {
    const yesCount = movies.filter(m => votes[m.id] === "yes").length;
    const noCount = movies.filter(m => votes[m.id] === "no").length;
    return (
      <div style={{ paddingTop:16, display:"flex", flexDirection:"column", gap:12, paddingBottom:120 }}>
        <div style={{ textAlign:"center" }}>
          <h2 style={{ margin:"0 0 4px", fontSize:22 }}>Review your picks</h2>
          <p style={{ color:C.muted, margin:0, fontSize:13 }}>
            Tap a vote to flip it. {yesCount} yes · {noCount} no
          </p>
        </div>

        {/* Super-like explainer */}
        <div style={{
          background: C.card,
          border: `1px solid ${C.gold}44`,
          borderRadius: 10,
          padding: "10px 14px",
          fontSize: 12,
          color: C.muted,
          lineHeight: 1.5,
        }}>
          <span style={{ color: C.gold, fontWeight:800 }}>★ Super-like (optional)</span>
          {" — "}
          Star one movie you'd really love to watch. It's a tiebreaker: if the group
          can't agree on a movie, your super-like gives one a boost. You get one star total.
        </div>

        {movies.map(movie => {
          const vote = votes[movie.id];
          const isYes = vote === "yes";
          const isStarred = myPassionPick === movie.id;
          const hidden = isHidden(movie.id);
          return (
            <div key={movie.id} style={{
              background: C.card,
              border: `1px solid ${isStarred ? C.gold : C.border}`,
              borderRadius: 12,
              overflow: "hidden",
              display: "flex",
              boxShadow: isStarred ? `0 0 16px ${C.gold}33` : "none",
              opacity: hidden ? 0.55 : 1,
              transition: "border-color 0.15s, box-shadow 0.15s, opacity 0.15s",
            }}>
              <PosterThumb poster={movie.poster} title={movie.title} />
              <div style={{ flex:1, padding:"10px 12px", display:"flex", flexDirection:"column", gap:8 }}>
                <div>
                  <div style={{ display:"flex", alignItems:"baseline", gap:6, flexWrap:"wrap" }}>
                    <h3 style={{ margin:0, fontSize:15, fontWeight:800, color:C.text, lineHeight:1.2 }}>{movie.title}</h3>
                    <span style={{ color:C.muted, fontSize:11 }}>{movie.year}</span>
                  </div>
                  <div style={{ fontSize:11, color:C.muted, marginTop:2 }}>
                    {movie.genres?.slice(0, 3).join(" · ")}
                  </div>
                </div>
                <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                  <button
                    onClick={() => setReviewVote(movie.id, "no")}
                    aria-label="Skip"
                    style={{
                      flex:1, padding:"7px 10px", borderRadius:8,
                      border: `1.5px solid ${vote === "no" ? C.red : C.border}`,
                      background: vote === "no" ? C.redSoft : "transparent",
                      color: vote === "no" ? C.red : C.muted,
                      fontSize:14, fontWeight:700, cursor:"pointer",
                      transition:"all 0.1s",
                    }}
                  >✕ Skip</button>
                  <button
                    onClick={() => setReviewVote(movie.id, "yes")}
                    aria-label="Watch"
                    style={{
                      flex:1, padding:"7px 10px", borderRadius:8,
                      border: `1.5px solid ${isYes ? C.green : C.border}`,
                      background: isYes ? C.greenSoft : "transparent",
                      color: isYes ? C.green : C.muted,
                      fontSize:14, fontWeight:700, cursor:"pointer",
                      transition:"all 0.1s",
                    }}
                  >♥ Watch</button>
                  <button
                    onClick={() => toggleStar(movie.id)}
                    disabled={!isYes}
                    aria-label={isStarred ? "Remove super-like" : "Super-like this movie"}
                    title={!isYes
                      ? "You can only super-like movies you'd watch"
                      : isStarred ? "Tap again to remove" : "Super-like this movie"}
                    style={{
                      width:42, height:38, borderRadius:8,
                      border: `1.5px solid ${isStarred ? C.gold : isYes ? C.gold + "55" : C.border + "55"}`,
                      background: isStarred ? C.gold : "transparent",
                      color: isStarred ? "#1a1300" : isYes ? C.gold : C.muted + "55",
                      fontSize:18, fontWeight:800,
                      cursor: isYes ? "pointer" : "not-allowed",
                      display:"flex", alignItems:"center", justifyContent:"center",
                      transition:"all 0.1s",
                      flexShrink:0,
                    }}
                  >★</button>
                </div>
                <div style={{ display:"flex", gap:6 }}>
                  <button
                    onClick={() => setReviewTrailer({ id: movie.id, title: movie.title })}
                    style={{ flex:1, padding:"6px 10px", borderRadius:8, border:`1.5px solid ${C.border}`, background:"transparent", color:C.muted, fontSize:11, fontWeight:700, cursor:"pointer" }}
                  >▶ Trailer</button>
                  {profile?.userKey && (
                    <button
                      onClick={() => toggleHidden(movie.id)}
                      style={{
                        flex:1,
                        background: hidden ? C.redSoft : "transparent",
                        border: `1.5px solid ${hidden ? C.red : C.border}`,
                        borderRadius: 8,
                        padding: "6px 10px",
                        fontSize: 11,
                        color: hidden ? C.red : C.muted,
                        cursor: "pointer",
                        fontWeight: 700,
                        transition: "all 0.15s",
                      }}
                    >
                      {hidden ? "⊘ Hidden" : "⊘ Hide"}
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}

        {reviewTrailer && <TrailerModal movieId={reviewTrailer.id} title={reviewTrailer.title} onClose={() => setReviewTrailer(null)} />}

        {/* Fixed bottom submit bar */}
        <div style={{
          position:"fixed",
          bottom:0,
          left:0,
          right:0,
          padding:"12px 16px calc(12px + env(safe-area-inset-bottom)) 16px",
          background: `linear-gradient(to top, ${C.backdrop} 60%, rgba(244,247,250,0))`,
          zIndex: 100,
        }}>
          <div style={{ maxWidth:500, margin:"0 auto" }}>
            <Btn onClick={submitFinal} big disabled={submitting}>
              {submitting ? "Submitting…" : "Submit Final Picks →"}
            </Btn>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ paddingTop:20, display:"flex", flexDirection:"column", alignItems:"center", gap:20 }}>
      {/* Progress bar */}
      <div style={{ width:"100%", height:4, background:C.border, borderRadius:2 }}>
        <div style={{ height:"100%", width:`${progress}%`, background:C.accent, borderRadius:2, transition:"width 0.3s" }} />
      </div>

      {current && (
        <div style={{ width:"100%", display:"flex", justifyContent:"center",
          transform: animDir === "yes" ? "translateX(200%) rotate(30deg)" : animDir === "no" ? "translateX(-200%) rotate(-30deg)" : "none",
          opacity: animDir ? 0 : 1,
          transition: animDir ? "all 0.3s ease" : "none",
        }}>
          <SwipeCard key={current?.id} movie={current} posterUrl={current?.poster} liveStreaming={tmdbData[current?.id]?.streaming} tmdbEntry={tmdbData[current?.id]} onSwipe={swipe} index={idx} total={movies.length} matches={currentMatches} />
        </div>
      )}

      {/* Spacer so the last bit of the card isn't hidden behind the floating action bar */}
      <div style={{ height: 100 }} />

      {/* Floating action bar — fixed to bottom of viewport so it's always reachable on mobile.
          pointerEvents:"none" on the wrapper lets card swipe gestures pass through the
          gradient backdrop; each button re-enables pointer events on itself. */}
      <div style={{
        position:"fixed",
        bottom:0,
        left:0,
        right:0,
        padding:"16px 20px calc(16px + env(safe-area-inset-bottom)) 20px",
        background:`linear-gradient(to top, ${C.backdrop} 50%, rgba(244,247,250,0))`,
        display:"flex",
        alignItems:"center",
        gap:12,
        zIndex:100,
        pointerEvents:"none",
      }}>
        {/* Left corner: Skip (✕) */}
        <div style={{ flex:1, display:"flex", justifyContent:"flex-start" }}>
          <button onClick={()=>swipe("no")}
            style={{ pointerEvents:"auto", width:60, height:60, borderRadius:"50%", background:C.redSoft, border:`2px solid ${C.red}`, color:C.red, fontSize:26, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", transition:"transform 0.1s", backdropFilter:"blur(8px)", WebkitBackdropFilter:"blur(8px)" }}
            onMouseDown={e=>e.currentTarget.style.transform="scale(0.9)"} onMouseUp={e=>e.currentTarget.style.transform="scale(1)"}>✕</button>
        </div>

        {/* Center: Undo pill (passion-pick star moved to the Review screen) */}
        <div style={{ display:"flex", gap:12, pointerEvents:"auto", alignItems:"center" }}>
          <button
            onClick={undo}
            disabled={!history.length || !!animDir}
            title="Undo last swipe"
            style={{
              height:44,
              padding:"0 18px",
              borderRadius:22,
              background: history.length ? C.gold : "transparent",
              border: `2px solid ${history.length ? C.gold : C.gold + "44"}`,
              color: history.length ? "#1a1300" : C.gold + "66",
              fontSize:13,
              fontWeight:800,
              letterSpacing:1,
              cursor: history.length && !animDir ? "pointer" : "default",
              display:"flex", alignItems:"center", justifyContent:"center",
              transition:"transform 0.1s",
              boxShadow: history.length ? `0 4px 12px ${C.gold}44` : "none",
            }}
            onMouseDown={e => history.length && (e.currentTarget.style.transform="scale(0.92)")}
            onMouseUp={e => e.currentTarget.style.transform="scale(1)"}
          >UNDO</button>
        </div>

        {/* Right corner: Watch (♥) */}
        <div style={{ flex:1, display:"flex", justifyContent:"flex-end" }}>
          <button onClick={()=>swipe("yes")}
            style={{ pointerEvents:"auto", width:60, height:60, borderRadius:"50%", background:C.greenSoft, border:`2px solid ${C.green}`, color:C.green, fontSize:26, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", transition:"transform 0.1s", backdropFilter:"blur(8px)", WebkitBackdropFilter:"blur(8px)" }}
            onMouseDown={e=>e.currentTarget.style.transform="scale(0.9)"} onMouseUp={e=>e.currentTarget.style.transform="scale(1)"}>♥</button>
        </div>
      </div>
    </div>
  );
}

function PosterThumb({ poster, title }) {
  const [err, setErr] = useState(false);
  return (
    <div style={{ width:90, flexShrink:0, height:130, background:`linear-gradient(135deg, ${C.accentSoft}, ${C.bg})`, overflow:"hidden", display:"flex", alignItems:"center", justifyContent:"center", color: C.muted }}>
      {poster && !err
        ? <img src={poster} alt={title} onError={() => setErr(true)} style={{ width:"100%", height:"100%", objectFit:"cover", display:"block" }} />
        : <span style={{ fontSize:36 }}>🎬</span>}
    </div>
  );
}

// ─── Results Screen ───────────────────────────────────────────────────────────
// ─── Unhinged Questions Screen ───────────────────────────────────────────────
// Lightweight standalone activity — single-device, no session. One person opens
// it, sees a question, the group talks about it, then taps Next (or swipes) for
// another. Uses a SHUFFLE BAG (random without replacement) so you never see a
// repeat until the whole library is exhausted, then it reshuffles.
//
// Bag persistence:
//   • Signed in  → bag state lives in profile.questionBag (localStorage + KV),
//     so progress continues across sessions AND devices.
//   • Anonymous  → bag state lives in localStorage ("mn_questionbag"), so
//     progress continues across sessions on this device.
const QUESTION_BAG_KEY = "mn_questionbag";
function QuestionsScreen({ profile, setProfile, onDone }) {
  // Read the persisted bag state from wherever it lives for this user.
  const readBag = () => {
    if (profile?.userKey) return profile.questionBag || null;
    try { return JSON.parse(localStorage.getItem(QUESTION_BAG_KEY)); } catch { return null; }
  };
  // Persist updated bag state. Signed-in → profile (local + KV). Anon → local.
  const persistBag = (state) => {
    if (profile?.userKey) {
      const updated = { ...profile, questionBag: state };
      setProfile(updated);
      putProfile(profile.userKey, updated);
    } else {
      try { localStorage.setItem(QUESTION_BAG_KEY, JSON.stringify(state)); } catch {}
    }
  };

  // bagRef holds the live bag state ({ seen: [...] }). Initialized by the first
  // draw below; advanced + persisted on each new question.
  const bagRef = useRef(undefined);

  // First question: draw once from the persisted bag (continuing where the user
  // left off), advancing the bag.
  const [history, setHistory] = useState(() => {
    const { question, nextState } = drawFromBag(readBag());
    bagRef.current = nextState;
    return [question];
  });
  const [idx, setIdx] = useState(0);
  const [animDir, setAnimDir] = useState(null); // "left" | "right" | null
  const touchRef = useRef({ x: 0, active: false });

  // Persist the initial draw once (the useState initializer advanced the bag
  // but shouldn't write storage as a side effect).
  useEffect(() => {
    if (bagRef.current) persistBag(bagRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = history[idx];
  const hasPrevious = idx > 0;

  const advance = (dir) => {
    if (animDir) return;
    setAnimDir(dir);
    setTimeout(() => {
      if (dir === "left") {
        // Next question
        if (idx < history.length - 1) {
          // Re-showing a question already in this viewing's history — don't draw
          setIdx(idx + 1);
        } else {
          // Draw a fresh question from the bag, advance + persist
          const { question, nextState } = drawFromBag(bagRef.current, current);
          bagRef.current = nextState;
          persistBag(nextState);
          setHistory(h => [...h, question]);
          setIdx(idx + 1);
        }
      } else if (dir === "right" && hasPrevious) {
        setIdx(idx - 1);
      }
      setAnimDir(null);
    }, 220);
  };

  // ── Touch swipe support ──
  const onTouchStart = (e) => {
    touchRef.current = { x: e.touches[0].clientX, active: true };
  };
  const onTouchEnd = (e) => {
    if (!touchRef.current.active) return;
    const dx = e.changedTouches[0].clientX - touchRef.current.x;
    touchRef.current.active = false;
    if (dx < -60) advance("left");
    else if (dx > 60 && hasPrevious) advance("right");
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:18, paddingTop:8 }}>
      {/* Counter */}
      <div style={{ textAlign:"center" }}>
        <div style={{ fontSize:11, color:C.muted, fontWeight:700, letterSpacing:1.5, textTransform:"uppercase" }}>
          Question {idx + 1}
        </div>
      </div>

      {/* Question card — the focal point. Listens for swipe gestures. */}
      <div
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        style={{
          background: C.card,
          border: `1px solid ${C.border}`,
          borderRadius: 18,
          padding: "36px 24px 32px",
          textAlign: "center",
          boxShadow: `0 4px 14px ${C.accent}1a`,
          minHeight: 220,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          gap: 14,
          // Animate the card off-screen briefly when advancing
          transform: animDir === "left"  ? "translateX(-110%) rotate(-6deg)" :
                     animDir === "right" ? "translateX(110%) rotate(6deg)"  : "none",
          opacity: animDir ? 0 : 1,
          transition: animDir ? "transform 0.22s ease, opacity 0.22s ease" : "transform 0.0s, opacity 0.15s",
          touchAction: "pan-y",
          userSelect: "none",
        }}>
        <div style={{ fontSize: 40, lineHeight: 1, color: C.accent, opacity: 0.32, fontFamily: "'Georgia', serif" }}>"</div>
        <p style={{
          margin: 0,
          fontSize: 22,
          fontWeight: 700,
          color: C.text,
          fontFamily: "'Georgia', serif",
          lineHeight: 1.4,
          maxWidth: 320,
        }}>{current}</p>
        <div style={{ fontSize: 40, lineHeight: 1, color: C.accent, opacity: 0.32, fontFamily: "'Georgia', serif" }}>"</div>
      </div>

      {/* Swipe hint */}
      <div style={{ textAlign:"center", fontSize:11, color:C.muted, marginTop: -6 }}>
        Swipe ← or tap Next for another question
      </div>

      {/* Controls */}
      <div style={{ display:"flex", gap:8 }}>
        <Btn onClick={() => advance("right")} disabled={!hasPrevious} outline flex>← Previous</Btn>
        <Btn onClick={() => advance("left")} flex>Next →</Btn>
      </div>

      <Btn onClick={onDone} outline>Done</Btn>
    </div>
  );
}

// ─── Saved Movies Screen ──────────────────────────────────────────────────────
// Shown to the admin between lobby and prefs when they have movies saved for later.
// They can toggle which saved movies to include in this session's swipe deck.
// Selected movies are stored on the session as `session.savedMovies` and prepended
// to the discover results in discoverMovies().
function SavedMoviesScreen({ profile, setProfile, session, onContinue, onSkip }) {
  const saved = profile?.savedLater || [];
  const [selected, setSelected] = useState(() => new Set(saved.map(m => m.id)));

  const toggle = (id) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const removeFromSaved = (id) => {
    if (!profile?.userKey) return;
    const updated = { ...profile, savedLater: (profile.savedLater || []).filter(m => m.id !== id) };
    setProfile(updated);
    putProfile(profile.userKey, updated);
    setSelected(prev => { const next = new Set(prev); next.delete(id); return next; });
  };

  const handleContinue = () => {
    const toInclude = saved.filter(m => selected.has(m.id));
    onContinue(toInclude);
  };

  if (!saved.length) { onSkip(); return null; }

  return (
    <div style={{ paddingTop:8, display:"flex", flexDirection:"column", gap:14 }}>
      <div style={{ textAlign:"center" }}>
        <div style={{ fontSize:44 }}>📌</div>
        <h2 style={{ margin:"8px 0 4px" }}>Saved for Later</h2>
        <p style={{ color:C.muted, margin:0, fontSize:13 }}>Include these in tonight's swipe deck?</p>
      </div>
      {saved.map(movie => {
        const on = selected.has(movie.id);
        return (
          <div
            key={movie.id}
            onClick={() => toggle(movie.id)}
            style={{
              background: on ? `linear-gradient(135deg, ${C.card}, ${C.accentSoft})` : C.card,
              border: `${on ? 2 : 1}px solid ${on ? C.accent : C.border}`,
              borderRadius:16, overflow:"hidden", display:"flex", cursor:"pointer",
              boxShadow: on ? `0 0 16px ${C.accent}22` : "none",
              transition:"all 0.15s",
            }}
          >
            <PosterThumb poster={movie.poster} title={movie.title} />
            <div style={{ flex:1, padding:"12px 12px", display:"flex", flexDirection:"column", justifyContent:"space-between" }}>
              <div>
                <div style={{ fontWeight:800, fontSize:15, color:C.text }}>{movie.title}</div>
                <div style={{ color:C.muted, fontSize:12, marginTop:2 }}>{movie.year}</div>
                <div style={{ fontSize:12, marginTop:4, display:"flex", gap:8 }}>
                  <span style={{ color:C.gold }}>⭐ {movie.imdb}</span>
                  <span style={{ color:"#fa4b3a" }}>🍅 {movie.rt}%</span>
                </div>
              </div>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginTop:8 }}>
                <span style={{ fontSize:12, color: on ? C.accent : C.muted, fontWeight: on ? 700 : 400 }}>
                  {on ? "✓ Include in session" : "Tap to include"}
                </span>
                <button
                  onClick={(e) => { e.stopPropagation(); removeFromSaved(movie.id); }}
                  style={{ background:"transparent", border:"none", fontSize:11, color:C.muted, cursor:"pointer", padding:"2px 4px" }}
                  title="Remove from saved"
                >✕ Remove</button>
              </div>
            </div>
          </div>
        );
      })}
      <div style={{ display:"flex", gap:10 }}>
        <Btn onClick={onSkip} outline>Skip</Btn>
        <Btn onClick={handleContinue} flex disabled={selected.size === 0}>
          {selected.size === 0 ? "None selected" : `Include ${selected.size} movie${selected.size !== 1 ? "s" : ""} →`}
        </Btn>
      </div>
    </div>
  );
}

function ResultsScreen({ session, userId, profile, setProfile, onRestart, onHome }) {
  const [latestSession, setLatestSession] = useState(session);
  const [phase, setPhase] = useState("waiting"); // "waiting" | "heart" | "final"
  // heartPool tracks which movie ids are still in contention for the current heart round
  const [heartPool, setHeartPool] = useState(null); // null = not yet determined
  const [myHeart, setMyHeart] = useState(null);
  const [heartRound, setHeartRound] = useState(1);

  // ── Poll KV for updates ──
  // heartPool and heartRound now live on the session (KV) rather than local state,
  // so every device sees the same canonical round state. Local React state is just
  // a mirror that re-syncs on each poll.
  useAdaptivePoll(session?.id, (s) => {
        setLatestSession(s);
        // Mirror server-side heart state into local React state
        if (Array.isArray(s.heartPool)) setHeartPool(s.heartPool);
        if (typeof s.heartRound === "number") setHeartRound(s.heartRound);

      const allSwipeDone = s.participants.every(p => p.done);
      if (!allSwipeDone) { setPhase("waiting"); return; }

      // Compute the initial yes pool from swipe votes
      const totalP = s.participants.length;
      const unanimousIds = new Set(
        (s.movies || [])
          .filter(m => s.participants.filter(p => p.votes?.[m.id] === "yes").length === totalP)
          .map(m => m.id)
      );

      if (unanimousIds.size <= 2) { setPhase("final"); return; }

      // If hearts have been cast, check whether we're still in heart phase or done
      const allHeartDone = s.participants.every(p => p.heart !== undefined);
      if (!allHeartDone) {
        setPhase("heart");
        // Initialize the server-side heart pool on the first device to detect this
        if (!Array.isArray(s.heartPool)) {
          const initial = { ...s, heartPool: [...unanimousIds], heartRound: 1 };
          putSession(initial).then(() => {
            setLatestSession(initial);
            setHeartPool(initial.heartPool);
            setHeartRound(1);
          });
        }
        return;
      }

      // All hearts submitted — compute survivors using the canonical server pool
      const pool = Array.isArray(s.heartPool) && s.heartPool.length
        ? s.heartPool
        : [...unanimousIds];
      const heartCounts = {};
      pool.forEach(id => { heartCounts[id] = s.participants.filter(p => p.heart === id).length; });
      const max = Math.max(...Object.values(heartCounts), 0);
      const survivors = pool.filter(id => (heartCounts[id] ?? 0) === max && max > 0);

      // Safety net: if hearts somehow didn't narrow the pool at all, force final
      // rather than infinite-looping. Each survivor becomes a top pick.
      const isStuck = survivors.length === pool.length;

      if (survivors.length > 2 && !isStuck) {
        // Still too many — start another heart round with just the survivors.
        // Persist the new heartPool/heartRound to KV so every device picks it up.
        const nextRound = (s.heartRound || 1) + 1;
        const resetSession = {
          ...s,
          heartPool: survivors,
          heartRound: nextRound,
          participants: s.participants.map(p => ({ ...p, heart: undefined })),
        };
        putSession(resetSession).then(() => {
          setLatestSession(resetSession);
          setHeartPool(survivors);
          setMyHeart(null);
          setHeartRound(nextRound);
          setPhase("heart");
        });
      } else {
        setPhase("final");
      }
  });

  // ── Persist this session to the signed-in profile (fires once when results finalize) ──
  // Declared at the top of the component, before any conditional returns, so the hook
  // count stays stable across render phases (otherwise React error #310 — "rendered
  // fewer hooks than during the previous render").
  const savedRef = useRef(false);
  useEffect(() => {
    if (savedRef.current) return;
    if (!profile?.userKey) return;
    if (phase !== "final") return;
    if (!latestSession) return;

    // Recompute the final movies inside the effect rather than reading them from
    // the render scope (which doesn't exist yet at the top of the component).
    const participants = latestSession.participants || [];
    const movies = latestSession.movies || [];
    const totalP = participants.length;
    const voteCounts = {};
    const passionCounts = {};
    movies.forEach(m => {
      voteCounts[m.id] = participants.filter(p => p.votes?.[m.id] === "yes").length;
      passionCounts[m.id] = participants.filter(p => p.passionPick === m.id && p.votes?.[m.id] === "yes").length;
    });
    const scoreOf = id => (voteCounts[id] || 0) + 2 * (passionCounts[id] || 0);
    const unanimousYes = movies.filter(m => voteCounts[m.id] === totalP);
    const majorityYes = movies
      .filter(m => voteCounts[m.id] > 1 && voteCounts[m.id] < totalP)
      .sort((a, b) => scoreOf(b.id) - scoreOf(a.id));
    const isTwo = totalP <= 2;
    const passionMovies = movies.filter(m => passionCounts[m.id] > 0).sort((a, b) => scoreOf(b.id) - scoreOf(a.id));
    let yesMovies;
    if (unanimousYes.length > 0) yesMovies = unanimousYes;
    else if (!isTwo && majorityYes.length > 0) yesMovies = majorityYes;
    else if (passionMovies.length > 0) yesMovies = passionMovies;
    else yesMovies = [];

    const pool = (Array.isArray(latestSession.heartPool) ? latestSession.heartPool : yesMovies.map(m => m.id))
      .map(id => movies.find(m => m.id === id))
      .filter(Boolean);
    const heartCounts = {};
    pool.forEach(m => { heartCounts[m.id] = participants.filter(p => p.heart === m.id).length; });
    const maxHearts = Math.max(...pool.map(m => heartCounts[m.id] ?? 0), 0);
    const round = latestSession.heartRound || 1;
    let finalMovies = round > 1 || yesMovies.length > 2
      ? pool.filter(m => (heartCounts[m.id] ?? 0) === maxHearts && maxHearts > 0)
      : yesMovies;
    if (finalMovies.length === 0) finalMovies = pool.length ? pool : yesMovies;
    if (!finalMovies.length) return;

    savedRef.current = true;

    const me = participants.find(p => p.id === userId);
    const myVotes = me?.votes || {};
    const yesCount = Object.values(myVotes).filter(v => v === "yes").length;
    const noCount = Object.values(myVotes).filter(v => v === "no").length;
    const passionMovie = me?.passionPick ? movies.find(m => m.id === me.passionPick) : null;

    const entry = {
      id: latestSession.id,
      date: Date.now(),
      role: latestSession.adminId === userId ? "admin" : "guest",
      participantCount: participants.length,
      genres: me?.genres || [],
      veto: (me?.vetoes || [])[0] || null,
      passionPick: passionMovie ? { id: passionMovie.id, title: passionMovie.title } : null,
      votes: { yes: yesCount, no: noCount },
      finalMovies: finalMovies.slice(0, 5).map(m => ({
        id: m.id, title: m.title, year: m.year, poster: m.poster,
        watchStatus: "unconfirmed",
      })),
    };

    const existing = profile.sessions || [];
    const filtered = existing.filter(s => s.id !== entry.id);
    const updated = { ...profile, sessions: [...filtered, entry].slice(-50) };
    setProfile(updated);
    putProfile(profile.userKey, updated);
  }, [phase, latestSession, profile?.userKey]);

  if (!latestSession) return null;

  const participants = latestSession.participants || [];
  const movies = latestSession.movies || [];
  const totalParticipants = participants.length;
  const tmdbData = useTMDBMovieData(movies);

  // ── Waiting for swipes ──
  if (phase === "waiting") {
    const notDone = participants.filter(p => !p.done);
    return (
      <div style={{ paddingTop:40, textAlign:"center", display:"flex", flexDirection:"column", alignItems:"center", gap:16 }}>
        <div style={{ fontSize:50 }}>⏳</div>
        <h2 style={{ margin:0 }}>Waiting for everyone…</h2>
        <p style={{ color:C.muted }}>Still swiping:</p>
        {notDone.map(p => <div key={p.id} style={{ background:C.card, borderRadius:8, padding:"8px 20px", color:C.muted }}>{p.name}</div>)}
      </div>
    );
  }

  // Tally swipe votes + passion picks. A passion pick is worth +2 points on a movie
  // the user said yes to — enough to break ties but not override a clear majority.
  const voteCounts = {};
  const passionCounts = {};
  movies.forEach(m => {
    voteCounts[m.id] = participants.filter(p => p.votes?.[m.id] === "yes").length;
    passionCounts[m.id] = participants.filter(p => p.passionPick === m.id && p.votes?.[m.id] === "yes").length;
  });
  const scoreOf = id => (voteCounts[id] || 0) + 2 * (passionCounts[id] || 0);

  const unanimousYes = movies.filter(m => voteCounts[m.id] === totalParticipants);
  const majorityYes = movies
    .filter(m => voteCounts[m.id] > 1 && voteCounts[m.id] < totalParticipants)
    .sort((a, b) => scoreOf(b.id) - scoreOf(a.id));
  const isTwo = totalParticipants <= 2;

  // Passion-pick rescue: if nothing got unanimous/majority, but at least one
  // person used their star on a movie they said yes to, surface those movies.
  // This is the "everyone shrugged" tiebreaker the star was designed for.
  const passionMovies = movies
    .filter(m => passionCounts[m.id] > 0)
    .sort((a, b) => scoreOf(b.id) - scoreOf(a.id));

  let yesMovies;
  if (unanimousYes.length > 0) {
    yesMovies = unanimousYes;
  } else if (!isTwo && majorityYes.length > 0) {
    yesMovies = majorityYes;
  } else if (passionMovies.length > 0) {
    yesMovies = passionMovies;
  } else {
    yesMovies = [];
  }
  const noMatch = yesMovies.length === 0;

  const doNewRound = () => {
    getSession(latestSession.id).then(stored => {
      if (!stored) return;
      discoverMovies(stored).then(newMovies => {
        stored.movies = newMovies;
        stored.round = (stored.round || 1) + 1;
        stored.participants = stored.participants.map(p => ({ ...p, votes: {}, done: false, heart: undefined }));
        putSession(stored).then(() => {
          setHeartPool(null);
          setMyHeart(null);
          setHeartRound(1);
          onRestart(stored);
        });
      });
    });
  };

  // ── No match ──
  if (noMatch) {
    return (
      <div style={{ paddingTop:24, display:"flex", flexDirection:"column", gap:16 }}>
        <div style={{ textAlign:"center", padding:24 }}>
          <div style={{ fontSize:50 }}>🎲</div>
          <h2>No matches yet!</h2>
          <p style={{ color:C.muted }}>{isTwo ? "You two didn't agree on anything — let's try a new set of movies!" : "No movies got enough votes."}</p>
          <Btn onClick={doNewRound} big>Try 10 New Movies →</Btn>
        </div>
      </div>
    );
  }

  // Current pool for heart round (falls back to full yes list on first round)
  const currentPool = (heartPool || yesMovies.map(m => m.id))
    .map(id => movies.find(m => m.id === id))
    .filter(Boolean);

  // ── Heart phase ──
  if (phase === "heart") {
    const alreadyHearted = myHeart !== null || participants.find(p => p.id === userId)?.heart !== undefined;
    const myHeartId = myHeart ?? participants.find(p => p.id === userId)?.heart;
    const stillWaiting = participants.filter(p => !p.isBot && p.heart === undefined && p.id !== userId);

    const submitHeart = (movieId) => {
      setMyHeart(movieId);
      getSession(latestSession.id).then(stored => {
        if (!stored) return;
        const me = stored.participants?.find(p => p.id === userId);
        if (me) me.heart = movieId;
        stored.participants.forEach(p => {
          if (p.isBot && p.heart === undefined) {
            p.heart = currentPool[Math.floor(Math.random() * currentPool.length)]?.id;
          }
        });
        putSession(stored).then(() => setLatestSession({ ...stored }));
      });
    };

    return (
      <div style={{ paddingTop:24, display:"flex", flexDirection:"column", gap:16 }}>
        <div style={{ textAlign:"center" }}>
          <div style={{ fontSize:44 }}>💝</div>
          <h2 style={{ margin:"8px 0 4px" }}>
            {heartRound > 1 ? `Still ${currentPool.length} options — round ${heartRound}!` : `You all said yes to ${currentPool.length} movies!`}
          </h2>
          <p style={{ color:C.muted, margin:0 }}>
            {alreadyHearted
              ? stillWaiting.length > 0
                ? `Waiting for ${stillWaiting.map(p => p.name.split(" ")[0]).join(", ")}…`
                : "Everyone picked — tallying hearts…"
              : heartRound > 1
                ? "Still too many! Heart your favourite to narrow it down further."
                : "Heart the one you most want to watch to help narrow it down."}
          </p>
          {heartRound > 1 && (
            <div style={{ marginTop:8, fontSize:12, color:C.muted }}>
              Eliminated in previous rounds: {yesMovies.filter(m => !currentPool.find(c => c.id === m.id)).map(m => m.title).join(", ")}
            </div>
          )}
        </div>

        {currentPool.map(movie => {
          const isHearted = myHeartId === movie.id;
          const heartCount = participants.filter(p => p.heart === movie.id).length;
          return (
            <div key={movie.id} style={{
              background: isHearted ? `linear-gradient(135deg, ${C.card}, ${C.accentSoft})` : C.card,
              borderRadius:16, overflow:"hidden",
              border: isHearted ? `2px solid ${C.accent}` : `1px solid ${C.border}`,
              display:"flex", transition:"all 0.2s",
              boxShadow: isHearted ? `0 0 20px ${C.accent}44` : "none",
            }}>
              <PosterThumb poster={movie.poster} title={movie.title} />
              <div style={{ flex:1, padding:"12px 14px", display:"flex", flexDirection:"column", justifyContent:"space-between" }}>
                <div>
                  <div style={{ display:"flex", alignItems:"baseline", gap:8, marginBottom:4, flexWrap:"wrap" }}>
                    <h3 style={{ margin:0, fontSize:16, fontWeight:800, color:C.text }}>{movie.title}</h3>
                    <span style={{ color:C.muted, fontSize:12 }}>{movie.year}</span>
                    {movie.duration > 0 && (
                      <span style={{ color:C.muted, fontSize:12 }}>
                        · {Math.floor(movie.duration / 60) > 0 ? `${Math.floor(movie.duration / 60)}h ` : ""}{movie.duration % 60}m
                      </span>
                    )}
                  </div>
                  <div style={{ display:"flex", gap:8, fontSize:12, marginBottom:8 }}>
                    <span style={{ color:C.gold }}>⭐ {movie.imdb}</span>
                    <span style={{ color:"#fa4b3a" }}>🍅 {movie.rt}%</span>
                  </div>
                  {alreadyHearted && heartCount > 0 && (
                    <div style={{ display:"flex", gap:5, flexWrap:"wrap", marginBottom:8 }}>
                      {participants.filter(p => p.heart === movie.id).map(p => (
                        <span key={p.id} style={{ fontSize:11, borderRadius:6, padding:"2px 8px", fontWeight:600, background:"rgba(232,71,42,0.15)", color:C.accent, border:`1px solid ${C.accent}44` }}>
                          ♥ {p.name.split(" ")[0]}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                {!alreadyHearted ? (
                  <button onClick={() => submitHeart(movie.id)} style={{
                    alignSelf:"flex-start", padding:"8px 18px", borderRadius:20, fontSize:13, fontWeight:700,
                    cursor:"pointer", border:`1.5px solid ${C.accent}`, background:C.accentSoft, color:C.accent,
                    transition:"all 0.15s",
                  }}
                    onMouseEnter={e => { e.currentTarget.style.background = C.accent; e.currentTarget.style.color = "#fff"; }}
                    onMouseLeave={e => { e.currentTarget.style.background = C.accentSoft; e.currentTarget.style.color = C.accent; }}
                  >♥ Heart this</button>
                ) : isHearted ? (
                  <span style={{ fontSize:13, color:C.accent, fontWeight:700 }}>♥ Your pick</span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // ── Final results ──
  // Recompute survivors from the last heart round
  const heartCounts = {};
  currentPool.forEach(m => { heartCounts[m.id] = participants.filter(p => p.heart === m.id).length; });
  const maxHearts = Math.max(...currentPool.map(m => heartCounts[m.id] ?? 0), 0);
  let finalMovies = heartRound > 1 || yesMovies.length > 2
    ? currentPool.filter(m => (heartCounts[m.id] ?? 0) === maxHearts && maxHearts > 0)
    : yesMovies;
  // Fallback: if hearts somehow produced no winners (cross-device race during a
  // round transition, or all hearts landed outside currentPool), surface the
  // unanimous yes pool so the user always sees something instead of an empty screen.
  if (finalMovies.length === 0) {
    finalMovies = currentPool.length ? currentPool : yesMovies;
  }

  // (auto-save effect lives near the top of the component, before conditional returns,
  // so React's hook-order invariant isn't violated)

  // Update the watch status of a specific movie inside the current session's entry.
  // Used by the "We're watching this" button below. Marking watched also removes the
  // movie from savedLater so it doesn't get proposed again.
  const setWatchStatus = (movieId, status) => {
    if (!profile?.userKey) return;
    const sessions = profile.sessions || [];
    const updatedSessions = sessions.map(s =>
      s.id !== latestSession.id ? s : {
        ...s,
        finalMovies: (s.finalMovies || []).map(m =>
          m.id === movieId ? { ...m, watchStatus: status } : m
        ),
      }
    );
    const savedLater = status === "watched"
      ? (profile.savedLater || []).filter(m => m.id !== movieId)
      : (profile.savedLater || []);
    const updated = { ...profile, sessions: updatedSessions, savedLater };
    setProfile(updated);
    putProfile(profile.userKey, updated);
  };

  // Look up the current status of a result movie from the live profile state
  const watchStatusOf = (movieId) => {
    if (!profile?.userKey) return null;
    const entry = (profile.sessions || []).find(s => s.id === latestSession.id);
    return entry?.finalMovies?.find(m => m.id === movieId)?.watchStatus || null;
  };

  // Save a final movie to profile.savedLater for proposal in a future session.
  const saveForLater = (movieId) => {
    if (!profile?.userKey) return;
    const movie = finalMovies.find(m => m.id === movieId);
    if (!movie) return;
    const existing = profile.savedLater || [];
    if (existing.some(m => m.id === movieId)) return;
    const entry = { id: movie.id, title: movie.title, year: movie.year, poster: movie.poster, imdb: movie.imdb, rt: movie.rt, duration: movie.duration };
    const updated = { ...profile, savedLater: [...existing, entry] };
    setProfile(updated);
    putProfile(profile.userKey, updated);
  };

  const isSavedForLater = (movieId) => (profile?.savedLater || []).some(m => m.id === movieId);

  const removeSavedForLater = (movieId) => {
    if (!profile?.userKey) return;
    const updated = { ...profile, savedLater: (profile.savedLater || []).filter(m => m.id !== movieId) };
    setProfile(updated);
    putProfile(profile.userKey, updated);
  };

  return (
    <div style={{ paddingTop:24, display:"flex", flexDirection:"column", gap:16 }}>
      <div style={{ textAlign:"center" }}>
        <div style={{ fontSize:50 }}>🎉</div>
        <h2 style={{ margin:"8px 0 4px" }}>
          {finalMovies.length === 1 ? "Tonight you're watching…" : `${finalMovies.length} top picks!`}
        </h2>
        {heartRound > 1 && <p style={{ color:C.muted, margin:0, fontSize:13 }}>Survived {heartRound} heart round{heartRound > 1 ? "s" : ""}</p>}
      </div>

      {finalMovies.map(movie => (
        <div key={movie.id} style={{ background: C.card, borderRadius:16, overflow:"hidden", border:`2px solid ${C.accent}55`, display:"flex", boxShadow:`0 0 30px ${C.accent}22` }}>
          <PosterThumb poster={movie.poster} title={movie.title} />
          <div style={{ flex:1, padding:"12px 14px" }}>
            <div style={{ display:"flex", alignItems:"baseline", gap:8, marginBottom:4, flexWrap:"wrap" }}>
              <h3 style={{ margin:0, fontSize:16, fontWeight:800, color:C.text }}>{movie.title}</h3>
              <span style={{ color:C.muted, fontSize:12 }}>{movie.year}</span>
              {movie.duration > 0 && (
                <span style={{ color:C.muted, fontSize:12 }}>
                  · {Math.floor(movie.duration / 60) > 0 ? `${Math.floor(movie.duration / 60)}h ` : ""}{movie.duration % 60}m
                </span>
              )}
            </div>
            <div style={{ display:"flex", gap:10, marginBottom:6, fontSize:12 }}>
              <span style={{ color:C.gold }}>⭐ {movie.imdb}</span>
              <span style={{ color:"#fa4b3a" }}>🍅 {movie.rt}%</span>
              {heartRound > 1 && <span style={{ color:C.accent, fontWeight:700 }}>♥ {heartCounts[movie.id] ?? 0}</span>}
            </div>
            {participants.some(p => p.passionPick === movie.id) && (
              <div style={{ display:"flex", gap:4, flexWrap:"wrap", marginBottom:6 }}>
                {participants.filter(p => p.passionPick === movie.id).map(p => (
                  <span key={p.id} style={{
                    fontSize:11,
                    borderRadius:6,
                    padding:"2px 7px",
                    fontWeight:700,
                    background: `${C.gold}22`,
                    color: C.gold,
                    border: `1px solid ${C.gold}66`,
                  }}>★ {p.name.split(" ")[0]}'s passion pick</span>
                ))}
              </div>
            )}
            <div style={{ display:"flex", gap:5, flexWrap:"wrap", marginBottom:6 }}>
              {participants.map(p => {
                const v = p.votes?.[movie.id];
                return (
                  <span key={p.id} style={{ fontSize:11, borderRadius:6, padding:"2px 7px", fontWeight:600,
                    background: v === "yes" ? C.greenSoft : C.redSoft,
                    color: v === "yes" ? C.green : C.red,
                    border: `1px solid ${v === "yes" ? C.green : C.red}44`,
                  }}>{p.name.split(" ")[0]} {v === "yes" ? "✓" : "✕"}</span>
                );
              })}
            </div>
            <div style={{ display:"flex", gap:4, flexWrap:"wrap" }}>
              {(tmdbData[movie.id]?.streaming ?? []).map(s => {
                const svc = SERVICES.find(sv => sv.id === s);
                return svc ? <span key={s} style={{ background:`${svc.color}22`, color:svc.color, border:`1px solid ${svc.color}55`, borderRadius:5, padding:"1px 6px", fontSize:10, fontWeight:600 }}>{svc.label}</span> : null;
              })}
            </div>
            {/* "We're watching this" + "Save for Later" — signed-in users only. */}
            {profile?.userKey && (() => {
              const status = watchStatusOf(movie.id);
              const isWatched = status === "watched";
              const saved = isSavedForLater(movie.id);
              return (
                <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginTop:8 }}>
                  <button
                    onClick={() => setWatchStatus(movie.id, isWatched ? "unconfirmed" : "watched")}
                    style={{
                      background: isWatched ? C.greenSoft : "transparent",
                      border: `1px solid ${isWatched ? C.green : C.border}`,
                      color: isWatched ? C.green : C.muted,
                      borderRadius:8,
                      padding:"6px 10px",
                      fontSize:11,
                      fontWeight:700,
                      cursor:"pointer",
                    }}
                  >
                    {isWatched ? "✓ Watching tonight" : "We're watching this →"}
                  </button>
                  <button
                    onClick={() => saved ? removeSavedForLater(movie.id) : saveForLater(movie.id)}
                    style={{
                      background: saved ? C.accentSoft : "transparent",
                      border: `1px solid ${saved ? C.accent : C.border}`,
                      color: saved ? C.accent : C.muted,
                      borderRadius:8,
                      padding:"6px 10px",
                      fontSize:11,
                      fontWeight:700,
                      cursor:"pointer",
                    }}
                  >
                    {saved ? "📌 Saved for later" : "📌 Save for later"}
                  </button>
                </div>
              );
            })()}
          </div>
        </div>
      ))}

      <div style={{ display:"flex", gap:12, marginTop:8 }}>
        <Btn onClick={doNewRound} outline>New Round</Btn>
        <Btn onClick={onHome} outline>New Session</Btn>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// FOOD NIGHT — find a nearby restaurant the group wants to order from. Reuses the
// session/participants/votes KV model and the shared Lobby/Join, with its own
// preferences, card, swiping, and results. Restaurant data comes from the Worker
// /restaurants route (Google Places, cached). See spike/FOOD_FEATURE_PLAN.md.
// ═══════════════════════════════════════════════════════════════════════════

const FOOD_CUISINES = [
  "Pizza", "Sushi", "Thai", "Mexican", "Chinese", "Indian", "Italian",
  "Burgers", "Mediterranean", "Korean", "Vietnamese", "Japanese",
  "BBQ", "Seafood", "Vegan", "Breakfast", "Dessert",
];

const PRICE_LABEL = {
  PRICE_LEVEL_INEXPENSIVE: "$",
  PRICE_LEVEL_MODERATE: "$$",
  PRICE_LEVEL_EXPENSIVE: "$$$",
  PRICE_LEVEL_VERY_EXPENSIVE: "$$$$",
};

// Build the restaurant deck from a full session: the UNION of every participant's
// cuisines (minus any vetoed) plus the admin's location criteria. Mirrors how
// discoverMovies unions everyone's genres. day/minute are the user's LOCAL clock so
// the 45-min "still open" buffer is measured from the moment of generating the deck
// (≈ swipe time) or the scheduled same-day time.
async function discoverRestaurants(session) {
  const participants = session.participants || [];
  const allVetoes = [...new Set(participants.flatMap(p => p.vetoCuisines || []))];
  const vetoSet = new Set(allVetoes);
  // Vetoes win over picks: a cuisine someone vetoed is dropped from the search union.
  const cuisines = [...new Set(participants.flatMap(p => p.cuisines || []))].filter(c => !vetoSet.has(c));
  const searchCuisines = cuisines.length ? cuisines : ["restaurants"];

  const c = session.criteria || {};
  const now = new Date();
  let day = now.getDay();
  let minute = now.getHours() * 60 + now.getMinutes();
  if (c.when && c.when !== "now") {
    const [h, m] = c.when.split(":").map(Number);
    if (Number.isFinite(h) && Number.isFinite(m)) minute = h * 60 + m;
  }
  const params = new URLSearchParams({
    zip: c.zip || "",
    cuisines: searchCuisines.join(","),
    radius: String(Math.round((c.distanceMi || 5) * 1609)),
    mode: c.mode || "takeout",
    day: String(day),
    minute: String(minute),
  });
  if (allVetoes.length) params.set("vetoCuisines", allVetoes.join(","));
  if (c.minRating) params.set("minRating", String(c.minRating));
  // Only constrain price when the admin actually narrowed it (some tiers deselected).
  if (c.allowedPrices && c.allowedPrices.length < 4) params.set("prices", c.allowedPrices.join(","));
  try {
    const res = await fetch(`${TMDB_PROXY}/restaurants?${params}`);
    const data = await res.json();
    if (!res.ok) return { error: data.error || "Search failed", restaurants: [] };
    return data;
  } catch (e) {
    return { error: e.message, restaurants: [] };
  }
}

// ─── Food Night Screen (sub-home: create or join) ─────────────────────────────
function FoodNightScreen({ onCreateSession, onJoinSession, onScanQR }) {
  return (
    <div style={{ paddingTop:24, display:"flex", flexDirection:"column", gap:24, alignItems:"center" }}>
      <div style={{ textAlign:"center" }}>
        <div style={{ fontSize:56, marginBottom:8, lineHeight:1 }}>🍔</div>
        <h2 style={{ margin:0, fontSize:24, fontWeight:900, color:C.text, fontFamily:"Georgia, serif", letterSpacing:-0.5 }}>FoodPix</h2>
        <p style={{ color:C.muted, fontSize:13, margin:"6px 0 0", maxWidth:280, lineHeight:1.5 }}>
          Swipe nearby restaurants with friends and pick where to order from together.
        </p>
      </div>
      <Btn onClick={onCreateSession} big>Create a Session</Btn>
      <div style={{ width:"100%" }}>
        <div style={{ textAlign:"center", color:C.muted, fontSize:13, fontWeight:700, marginBottom:10, letterSpacing:0.5 }}>
          — or join one —
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <Btn onClick={onScanQR} outline flex>📷 Scan QR Code</Btn>
          <Btn onClick={onJoinSession} outline flex>Enter Code</Btn>
        </div>
      </div>
    </div>
  );
}

// ─── Food Preferences ─────────────────────────────────────────────────────────
// Mirrors the movie genre flow: EVERY participant picks up to 3 cuisines + 1 veto;
// the admin additionally sets the shared location criteria (ZIP, distance, rating,
// order type, time). Once everyone's submitted, the admin generates the deck from
// the union of cuisines (vetoes excluded) — one path, so all read the same list.
function FoodPreferencesScreen({ session, userId, profile, setProfile, onReady }) {
  const isAdmin = session.adminId === userId;
  const participantCount = session.participants?.length || 1;
  const maxCuisines = participantCount > 3 ? 2 : 3;

  // Per-participant taste
  const [cuisines, setCuisines] = useState([]);
  const [vetoes, setVetoes] = useState([]); // 1 veto
  // Admin-only shared location criteria
  const [zip, setZip] = useState(profile?.zip || session.criteria?.zip || "");
  const [mode, setMode] = useState(session.criteria?.mode || "delivery");
  const [minRating, setMinRating] = useState(session.criteria?.minRating ?? 4);
  const [distanceMi, setDistanceMi] = useState(session.criteria?.distanceMi || 5);
  const ALL_PRICES = ["$", "$$", "$$$", "$$$$"];
  const [allowedPrices, setAllowedPrices] = useState(session.criteria?.allowedPrices || [...ALL_PRICES]);
  const togglePrice = (p) => setAllowedPrices(prev =>
    prev.includes(p)
      ? prev.length > 1 ? prev.filter(x => x !== p) : prev // keep at least 1
      : [...prev, p]
  );
  const [when, setWhen] = useState("now");
  const [scheduledTime, setScheduledTime] = useState("19:00");

  const [submitted, setSubmitted] = useState(false);
  const submittedRef = useRef(false);
  const submittedDataRef = useRef(null);
  const generatingRef = useRef(false); // prevent concurrent discover calls across adaptive polls
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);
  const [latestSession, setLatestSession] = useState(session);
  const [genError, setGenError] = useState("");

  const MAX_VETOES = 1;
  const toggleCuisine = c => {
    setVetoes(prev => prev.filter(x => x !== c));
    setCuisines(prev => prev.includes(c) ? prev.filter(x => x !== c) : prev.length < maxCuisines ? [...prev, c] : prev);
  };
  const toggleVeto = c => {
    setCuisines(prev => prev.filter(x => x !== c));
    setVetoes(prev => prev.includes(c) ? prev.filter(x => x !== c) : prev.length < MAX_VETOES ? [...prev, c] : prev);
  };

  // Poll for readiness (adaptive cadence); the admin generates the deck once everyone has submitted.
  useAdaptivePoll(session.id, (s) => {
    const generateAndAdvance = (sess) => {
      if (generatingRef.current) return;
      generatingRef.current = true;
      discoverRestaurants(sess).then(data => {
        if (!mountedRef.current) return;
        if (data.error || !data.restaurants?.length) {
          generatingRef.current = false;
          setGenError(data.error
            ? (typeof data.error === "string" ? data.error : "Search failed. Try again.")
            : "No restaurants matched. Try a wider distance, lower rating, or different cuisines/time.");
          return;
        }
        const updated = { ...sess, restaurants: data.restaurants, foodReady: true };
        putSession(updated).then(() => { if (mountedRef.current) onReady(updated); });
      });
    };

    // Self-healing: if our submit was clobbered by a concurrent write, restore it.
    if (submittedRef.current && submittedDataRef.current) {
      const me = s.participants?.find(p => p.id === userId);
      if (me && !me.prefsDone) {
        const ours = submittedDataRef.current.participants?.find(p => p.id === userId);
        s = {
          ...s,
          participants: s.participants.map(p => p.id === userId ? (ours || { ...p, prefsDone: true }) : p),
          ...(isAdmin && { criteria: submittedDataRef.current.criteria }),
        };
        putSession(s);
      }
    }
    setLatestSession(s);
    if (s.restaurants?.length > 0 || s.foodReady) { onReady(s); return; }
    if (s.adminId === userId) {
      const allDone = s.participants.every(p => p.prefsDone);
      if (allDone) generateAndAdvance(s);
    }
  });

  // Admin confirms last (button gated until others are done) so its criteria write
  // always lands on a settled base — same race-avoidance as the movie flow.
  const otherParticipantsDone = latestSession.participants
    ?.filter(p => p.id !== userId).every(p => p.prefsDone) ?? true;

  const submit = () => {
    if (!cuisines.length) return alert("Pick at least one cuisine");
    if (isAdmin && !/^\d{5}$/.test(zip.trim())) return alert("Enter a valid 5-digit ZIP code");
    getSession(session.id).then(s => {
      if (!s) return;
      const criteria = isAdmin
        ? { ...s.criteria, zip: zip.trim(), mode, minRating, distanceMi, allowedPrices, when: when === "now" ? "now" : scheduledTime }
        : s.criteria;
      const updated = {
        ...s,
        participants: s.participants.map(p =>
          p.id === userId ? { ...p, cuisines, vetoCuisines: vetoes, prefsDone: true } : p
        ),
        criteria,
      };
      submittedRef.current = true;
      submittedDataRef.current = updated;
      setSubmitted(true);
      if (isAdmin && profile?.userKey && zip.trim() !== profile.zip) {
        const up = { ...profile, zip: zip.trim() };
        setProfile(up); putProfile(profile.userKey, up);
      }
      putSession(updated).then(() => setLatestSession(updated));
    });
  };

  const allDone = latestSession.participants?.every(p => p.prefsDone);
  const myEntry = latestSession.participants?.find(p => p.id === userId);
  const iAmDone = submitted || myEntry?.prefsDone;

  if (iAmDone) {
    return (
      <div style={{ paddingTop:40, display:"flex", flexDirection:"column", alignItems:"center", gap:16 }}>
        <div style={{ fontSize:44 }}>⏳</div>
        <h2 style={{ margin:0 }}>Waiting for everyone…</h2>
        <div style={{ width:"100%", background:C.card, borderRadius:12, padding:16, border:`1px solid ${C.border}` }}>
          {latestSession.participants?.map(p => (
            <div key={p.id} style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 0", borderBottom:`1px solid ${C.border}` }}>
              <div style={{ width:28, height:28, borderRadius:"50%", background:p.prefsDone ? C.green : C.border, display:"flex", alignItems:"center", justifyContent:"center", fontSize:14 }}>
                {p.prefsDone ? "✓" : "…"}
              </div>
              <span style={{ flex:1 }}>{p.name}</span>
              <span style={{ fontSize:12, color:p.prefsDone ? C.green : C.muted }}>{p.prefsDone ? "Ready" : "Choosing…"}</span>
            </div>
          ))}
        </div>
        {allDone && !genError && <div style={{ color:C.muted, fontSize:13 }}>Finding restaurants…</div>}
        {genError && <div style={{ color:C.red, fontSize:13, background:C.redSoft, borderRadius:8, padding:"10px 14px", textAlign:"center" }}>{genError}</div>}
      </div>
    );
  }

  return (
    <div style={{ paddingTop:16, display:"flex", flexDirection:"column", gap:18, paddingBottom:40 }}>
      <div style={{ textAlign:"center" }}>
        <div style={{ fontSize:40 }}>🍔</div>
        <h2 style={{ margin:"6px 0 0", fontSize:22 }}>What are you craving?</h2>
      </div>

      <Field label={`Cuisines (pick up to ${maxCuisines})`} required>
        <div style={{ display:"flex", flexWrap:"wrap", gap:8 }}>
          {FOOD_CUISINES.map(c => (
            <Chip key={c} active={cuisines.includes(c)} onClick={() => toggleCuisine(c)}>{c}</Chip>
          ))}
        </div>
      </Field>

      <Field label="Veto (1 cuisine)">
        <div style={{ fontSize:12, color:C.muted, marginBottom:6 }}>A vetoed cuisine is excluded even if someone else picked it.</div>
        <div style={{ display:"flex", flexWrap:"wrap", gap:8 }}>
          {FOOD_CUISINES.map(c => (
            <Chip key={c} active={vetoes.includes(c)} onClick={() => toggleVeto(c)} accentColor={C.red}>{c}</Chip>
          ))}
        </div>
      </Field>

      {isAdmin && (
        <>
          <Field label="Delivery ZIP code" required>
            <input value={zip} onChange={e => setZip(e.target.value.replace(/\D/g, "").slice(0, 5))}
              placeholder="e.g. 98103" inputMode="numeric"
              style={{ ...inputStyle, fontFamily:"monospace", fontSize:20, letterSpacing:4, textAlign:"center" }} />
          </Field>

          <Field label="Order type">
            <div style={{ display:"flex", gap:8 }}>
              {[
                { value:"delivery", label:"Delivery + Takeout" },
                { value:"takeout", label:"Takeout only" },
              ].map(opt => (
                <button key={opt.value} onClick={() => setMode(opt.value)}
                  style={{ flex:1, padding:"10px 8px", borderRadius:10, border:`1.5px solid ${mode === opt.value ? C.accent : C.border}`, background:mode === opt.value ? C.accentSoft : "transparent", color:mode === opt.value ? C.accent : C.text, cursor:"pointer", fontSize:13, fontWeight:600 }}>
                  {opt.label}
                </button>
              ))}
            </div>
          </Field>

          <Field label="Minimum Google rating">
            <div style={{ display:"flex", gap:8 }}>
              {[{v:0,l:"Any"},{v:3.5,l:"3.5+"},{v:4,l:"4.0+"},{v:4.5,l:"4.5+"}].map(opt => (
                <button key={opt.v} onClick={() => setMinRating(opt.v)}
                  style={{ flex:1, padding:"10px 8px", borderRadius:10, border:`1.5px solid ${minRating === opt.v ? C.accent : C.border}`, background:minRating === opt.v ? C.accentSoft : "transparent", color:minRating === opt.v ? C.accent : C.text, cursor:"pointer", fontSize:13, fontWeight:600 }}>
                  {opt.l === "Any" ? "Any" : `⭐ ${opt.l}`}
                </button>
              ))}
            </div>
          </Field>

          <Field label="Price range">
            <div style={{ fontSize:12, color:C.muted, marginBottom:6 }}>Deselect price tiers to exclude them</div>
            <div style={{ display:"flex", gap:8 }}>
              {ALL_PRICES.map(p => {
                const active = allowedPrices.includes(p);
                return (
                  <button key={p} onClick={() => togglePrice(p)}
                    style={{ flex:1, padding:"10px 8px", borderRadius:10, border:`1.5px solid ${active ? C.accent : C.border}`, background:active ? C.accentSoft : "transparent", color:active ? C.accent : C.muted, cursor:"pointer", fontSize:14, fontWeight:700 }}>
                    {p}
                  </button>
                );
              })}
            </div>
          </Field>

          <Field label={`Distance: ${distanceMi} mi`}>
            <input type="range" min={1} max={10} step={1} value={distanceMi}
              onChange={e => setDistanceMi(Number(e.target.value))}
              style={{ width:"100%", accentColor:C.accent }} />
            <div style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:C.muted }}>
              <span>1 mi</span><span>10 mi</span>
            </div>
          </Field>

          <Field label="When are you ordering?">
            <div style={{ display:"flex", gap:8, marginBottom: when === "now" ? 0 : 10 }}>
              {[{v:"now",l:"Order now"},{v:"later",l:"Schedule (today)"}].map(opt => (
                <button key={opt.v} onClick={() => setWhen(opt.v === "now" ? "now" : "later")}
                  style={{ flex:1, padding:"10px 8px", borderRadius:10, border:`1.5px solid ${(when==="now") === (opt.v==="now") ? C.accent : C.border}`, background:(when==="now")===(opt.v==="now") ? C.accentSoft : "transparent", color:(when==="now")===(opt.v==="now") ? C.accent : C.text, cursor:"pointer", fontSize:13, fontWeight:600 }}>
                  {opt.l}
                </button>
              ))}
            </div>
            {when !== "now" && (
              <input type="time" value={scheduledTime} onChange={e => setScheduledTime(e.target.value)}
                style={{ ...inputStyle, fontSize:16 }} />
            )}
            <div style={{ fontSize:11, color:C.muted, marginTop:6 }}>
              We only show places that'll still be open at least 45 minutes after your order time.
            </div>
          </Field>
        </>
      )}

      {isAdmin && !otherParticipantsDone && (
        <div style={{ textAlign:"center", fontSize:12, color:C.muted }}>
          Waiting for other participants to pick their cuisines…
        </div>
      )}
      <Btn onClick={submit} big disabled={!cuisines.length || (isAdmin && !otherParticipantsDone)}>Confirm Cuisines →</Btn>
    </div>
  );
}

// ─── Restaurant Card (tap-to-vote, no drag) ───────────────────────────────────
function RestaurantCard({ r, index, total }) {
  const [imgError, setImgError] = useState(false);
  const price = PRICE_LABEL[r.priceLevel];
  return (
    <div style={{ width:"100%", maxWidth:420, margin:"0 auto" }}>
      <div style={{ background:C.card, borderRadius:20, overflow:"hidden", boxShadow:"0 16px 40px rgba(15,23,42,0.12)", border:`1px solid ${C.border}` }}>
        {/* Photo */}
        <div style={{ height:240, position:"relative", background:`linear-gradient(135deg, ${C.accentSoft}, ${C.bg})`, overflow:"hidden" }}>
          {r.photo && !imgError ? (
            <img src={r.photo} alt={r.name} onError={() => setImgError(true)}
              style={{ width:"100%", height:"100%", objectFit:"cover", display:"block" }} />
          ) : (
            <div style={{ width:"100%", height:"100%", display:"flex", alignItems:"center", justifyContent:"center", fontSize:90 }}>🍽️</div>
          )}
          <div style={{ position:"absolute", bottom:0, left:0, right:0, height:70, background:"linear-gradient(transparent, rgba(0,0,0,0.7))" }} />
          {r.openNow != null && (
            <div style={{ position:"absolute", top:12, left:12, background: r.openNow ? "rgba(22,163,74,0.9)" : "rgba(0,0,0,0.75)", borderRadius:8, padding:"4px 10px", fontSize:11, color:"#fff", fontWeight:700, backdropFilter:"blur(4px)" }}>
              {r.openNow ? "● Open now" : "Closed"}
            </div>
          )}
          <div style={{ position:"absolute", bottom:12, left:12, background:"rgba(0,0,0,0.7)", borderRadius:6, padding:"3px 8px", fontSize:11, color:"#fff", fontWeight:700, backdropFilter:"blur(4px)" }}>
            📍 {r.distanceMi} mi
          </div>
        </div>

        {/* Info */}
        <div style={{ padding:"16px 20px 20px" }}>
          <h2 style={{ margin:"0 0 4px", fontSize:21, fontWeight:800, color:C.text, fontFamily:"Georgia, serif", lineHeight:1.2 }}>{r.name}</h2>
          <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap", marginBottom:10 }}>
            <span style={{ color:C.muted, fontSize:13 }}>{r.cuisine}</span>
            {price && <span style={{ color:C.muted, fontSize:13 }}>· {price}</span>}
          </div>

          {r.rating != null && (
            <div style={{ display:"flex", gap:8, marginBottom:12 }}>
              <span style={{ display:"inline-flex", alignItems:"center", gap:4, background:`${C.gold}1a`, border:`1px solid ${C.gold}55`, borderRadius:8, padding:"3px 10px", fontSize:13, color:C.gold, fontWeight:700 }}>
                ⭐ {r.rating}<span style={{ fontSize:10, opacity:0.7, fontWeight:600 }}>Google · {r.reviews}</span>
              </span>
            </div>
          )}

          <div style={{ fontSize:13, color:C.muted, marginBottom:12 }}>{r.address}</div>

          <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginBottom:12 }}>
            {r.delivery && <span style={{ background:C.greenSoft, color:C.green, border:`1px solid ${C.green}55`, borderRadius:6, padding:"2px 8px", fontSize:11, fontWeight:600 }}>🛵 Delivery</span>}
            {r.takeout && <span style={{ background:C.accentSoft, color:C.accent, border:`1px solid ${C.accent}55`, borderRadius:6, padding:"2px 8px", fontSize:11, fontWeight:600 }}>🥡 Takeout</span>}
          </div>

          {r.description && (
            <p style={{ margin:"0 0 12px", color:C.text, fontSize:13.5, lineHeight:1.6, opacity:0.85 }}>{r.description}</p>
          )}

          {r.mapsUri && (
            <a href={r.mapsUri} target="_blank" rel="noopener noreferrer"
              style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:8, padding:"10px 0", borderRadius:10, border:`1.5px solid ${C.border}`, background:"transparent", color:C.text, fontSize:14, fontWeight:700, textDecoration:"none" }}>
              View on Google →
            </a>
          )}
        </div>
      </div>
      <div style={{ textAlign:"center", marginTop:12, color:C.muted, fontSize:13 }}>{index + 1} of {total}</div>
    </div>
  );
}

// ─── Food Swiping (tap Pass / Want it) ────────────────────────────────────────
function FoodSwipingScreen({ session, userId, onDone }) {
  const [idx, setIdx] = useState(0);
  const [votes, setVotes] = useState({});
  const [history, setHistory] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const deck = useRef(session.restaurants || []);
  const restaurants = deck.current;
  const current = restaurants[idx];

  if (!restaurants.length) {
    return <div style={{ padding:40, textAlign:"center", color:C.muted }}>No restaurants found. Go back and adjust your criteria.</div>;
  }

  const vote = (dir) => {
    if (!current) return;
    setVotes(v => ({ ...v, [current.id]: dir }));
    setHistory(h => [...h, idx]);
    if (idx + 1 >= restaurants.length) finish({ ...votes, [current.id]: dir });
    else setIdx(i => i + 1);
  };

  const undo = () => {
    if (!history.length) return;
    const prev = history[history.length - 1];
    setHistory(h => h.slice(0, -1));
    setVotes(v => { const n = { ...v }; delete n[restaurants[prev].id]; return n; });
    setIdx(prev);
  };

  const finish = (finalVotes) => {
    if (submitting) return;
    setSubmitting(true);
    getSession(session.id).then(stored => {
      if (!stored) { setSubmitting(false); return; }
      const me = stored.participants?.find(p => p.id === userId);
      if (me) { me.votes = finalVotes; me.done = true; }
      stored.restaurants = restaurants;
      putSession(stored).then(() => onDone({ ...stored }));
    });
  };

  if (submitting || idx >= restaurants.length) {
    return <div style={{ paddingTop:60, textAlign:"center", color:C.muted }}>Saving your picks…</div>;
  }

  return (
    <div style={{ paddingTop:8, display:"flex", flexDirection:"column", gap:16 }}>
      <RestaurantCard r={current} index={idx} total={restaurants.length} />
      <div style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:16 }}>
        <button onClick={() => vote("no")} aria-label="Pass"
          style={{ width:64, height:64, borderRadius:"50%", border:`2px solid ${C.red}`, background:C.redSoft, color:C.red, fontSize:26, cursor:"pointer" }}>✕</button>
        <button onClick={undo} disabled={!history.length}
          style={{ padding:"10px 18px", borderRadius:24, border:"none", background:history.length ? C.gold : C.border, color:history.length ? "#1a1300" : C.muted, fontSize:13, fontWeight:800, cursor:history.length ? "pointer" : "default" }}>UNDO</button>
        <button onClick={() => vote("yes")} aria-label="Want it"
          style={{ width:64, height:64, borderRadius:"50%", border:`2px solid ${C.green}`, background:C.greenSoft, color:C.green, fontSize:26, cursor:"pointer" }}>❤</button>
      </div>
    </div>
  );
}

// ─── Food Results (tally yes-votes, show winner) ──────────────────────────────
function FoodResultsScreen({ session, userId, onRestart, onRoundReset, onHome }) {
  const [latest, setLatest] = useState(session);
  const navedRef = useRef(false); // ensure we navigate to a new round only once

  // Poll the session (adaptive cadence). We arrive here with foodReady === true; when
  // the host starts a new round they reset foodReady → false, which we detect to pull
  // everyone (including remote participants) back to the preferences screen to re-pick.
  useAdaptivePoll(session.id, (s) => {
    setLatest(s);
    if (s.foodReady === false && !navedRef.current) {
      navedRef.current = true;
      onRoundReset?.(s);
    }
  });

  const participants = latest.participants || [];
  const restaurants = latest.restaurants || [];
  const notDone = participants.filter(p => !p.done);

  if (notDone.length) {
    return (
      <div style={{ paddingTop:40, textAlign:"center", display:"flex", flexDirection:"column", alignItems:"center", gap:16 }}>
        <div style={{ fontSize:50 }}>⏳</div>
        <h2 style={{ margin:0 }}>Waiting for everyone…</h2>
        <p style={{ color:C.muted }}>Still swiping:</p>
        {notDone.map(p => <div key={p.id} style={{ background:C.card, borderRadius:8, padding:"8px 20px", color:C.muted }}>{p.name}</div>)}
      </div>
    );
  }

  // Tally yes votes per restaurant; rank by most yeses, break ties by rating.
  const ranked = restaurants
    .map(r => ({
      r,
      yes: participants.filter(p => p.votes?.[r.id] === "yes").length,
    }))
    .filter(x => x.yes > 0)
    .sort((a, b) => b.yes - a.yes || (b.r.rating || 0) - (a.r.rating || 0));

  if (!ranked.length) {
    return (
      <div style={{ paddingTop:40, textAlign:"center", display:"flex", flexDirection:"column", alignItems:"center", gap:16 }}>
        <div style={{ fontSize:50 }}>😕</div>
        <h2 style={{ margin:0 }}>No matches</h2>
        <p style={{ color:C.muted, maxWidth:300 }}>Nobody agreed on a spot. Try another round with different criteria.</p>
        <div style={{ display:"flex", gap:10, width:"100%", maxWidth:320 }}>
          <Btn onClick={onRestart} flex>Try Again</Btn>
          <Btn onClick={onHome} outline flex>Home</Btn>
        </div>
      </div>
    );
  }

  const winner = ranked[0];
  const runnersUp = ranked.slice(1, 4);
  const everyone = winner.yes === participants.length && participants.length > 1;

  return (
    <div style={{ paddingTop:16, display:"flex", flexDirection:"column", gap:16, paddingBottom:40 }}>
      <div style={{ textAlign:"center" }}>
        <div style={{ fontSize:44 }}>🎉</div>
        <h2 style={{ margin:"6px 0 0" }}>{everyone ? "Unanimous!" : "Tonight's pick"}</h2>
        <p style={{ color:C.muted, margin:"4px 0 0", fontSize:13 }}>
          {winner.yes} of {participants.length} {winner.yes === 1 ? "vote" : "votes"}
        </p>
      </div>

      <div style={{ border:`2px solid ${C.gold}`, borderRadius:20, boxShadow:`0 0 16px ${C.gold}33` }}>
        <RestaurantCard r={winner.r} index={0} total={1} />
      </div>

      {runnersUp.length > 0 && (
        <div>
          <div style={{ fontSize:12, color:C.muted, fontWeight:700, letterSpacing:0.5, margin:"4px 0 8px" }}>RUNNERS-UP</div>
          {runnersUp.map(({ r, yes }) => (
            <a key={r.id} href={r.mapsUri || "#"} target="_blank" rel="noopener noreferrer"
              style={{ display:"flex", alignItems:"center", gap:12, background:C.card, border:`1px solid ${C.border}`, borderRadius:12, padding:10, marginBottom:8, textDecoration:"none" }}>
              <div style={{ width:54, height:54, borderRadius:8, overflow:"hidden", flexShrink:0, background:C.accentSoft, display:"flex", alignItems:"center", justifyContent:"center" }}>
                {r.photo ? <img src={r.photo} alt="" style={{ width:"100%", height:"100%", objectFit:"cover" }} /> : <span style={{ fontSize:24 }}>🍽️</span>}
              </div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontWeight:700, fontSize:14, color:C.text }}>{r.name}</div>
                <div style={{ fontSize:12, color:C.muted }}>⭐ {r.rating} · {r.distanceMi} mi · {yes} {yes === 1 ? "vote" : "votes"}</div>
              </div>
            </a>
          ))}
        </div>
      )}

      <div style={{ display:"flex", gap:10 }}>
        <Btn onClick={onRestart} flex>New Round</Btn>
        <Btn onClick={onHome} outline flex>Home</Btn>
      </div>
    </div>
  );
}

// ─── Shared Components ────────────────────────────────────────────────────────
const inputStyle = {
  width:"100%", background:C.card, border:`1px solid ${C.border}`, borderRadius:10,
  padding:"10px 14px", color:C.text, fontSize:15, outline:"none",
  boxSizing:"border-box",
};

function Field({ label, required, children }) {
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
      <label style={{ fontSize:13, fontWeight:600, color:C.muted, textTransform:"uppercase", letterSpacing:0.8 }}>
        {label}{required && <span style={{ color:C.accent }}> *</span>}
      </label>
      {children}
    </div>
  );
}

function Chip({ children, active, onClick, disabled, accentColor }) {
  const ac = accentColor || C.accent;
  return (
    <button onClick={disabled ? undefined : onClick} style={{
      padding:"6px 14px", borderRadius:20, fontSize:13, fontWeight:600, cursor: disabled ? "not-allowed" : "pointer",
      border: `1px solid ${active ? ac : C.border}`,
      background: active ? `${ac}22` : "transparent",
      color: active ? ac : disabled ? C.border : C.muted,
      transition:"all 0.15s",
    }}>{children}</button>
  );
}

// Big-icon tile used on the home screen to launch an activity (Movie Night,
// Fun Questions, etc.). One full-width row with icon left, title + description
// right, and an arrow on the far right.
function ActivityTile({ icon, title, description, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: "100%",
        background: C.card,
        border: `1.5px solid ${C.accent}`,
        borderRadius: 14,
        padding: "14px 16px",
        display: "flex",
        alignItems: "center",
        gap: 14,
        cursor: "pointer",
        textAlign: "left",
        boxShadow: `0 2px 10px ${C.accent}22`,
        transition: "all 0.15s",
      }}
    >
      <div style={{
        width: 48,
        height: 48,
        borderRadius: 12,
        background: C.accentSoft,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 26,
        flexShrink: 0,
      }}>{icon}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 16, fontWeight: 800, color: C.text }}>{title}</div>
        <div style={{ fontSize: 12, color: C.muted, marginTop: 2, lineHeight: 1.4 }}>{description}</div>
      </div>
      <span style={{ color: C.accent, fontSize: 20, fontWeight: 800, flexShrink: 0 }}>→</span>
    </button>
  );
}

function Btn({ children, onClick, big, outline, disabled, flex }) {
  return (
    <button onClick={disabled ? undefined : onClick} style={{
      width: big ? "100%" : undefined,
      flex: flex ? 1 : undefined,
      padding: big ? "16px 24px" : "10px 20px",
      borderRadius: big ? 14 : 10,
      fontSize: big ? 17 : 14,
      fontWeight: 700,
      cursor: disabled ? "not-allowed" : "pointer",
      border: `1.5px solid ${disabled ? C.border : outline ? C.border : C.accent}`,
      background: disabled ? C.border : outline ? "transparent" : C.accent,
      color: disabled ? C.muted : outline ? C.text : "#fff",
      transition: "all 0.15s",
      opacity: disabled ? 0.5 : 1,
    }}>{children}</button>
  );
}
