// ─── Activities ────────────────────────────────────────────────────────────────
// CouchPix evolves beyond movie picking. Sessions carry an `activity` field that
// determines what flow runs after the lobby.
export const ACTIVITIES = {
  MOVIES: "movies",
  FOOD: "food",
  QUESTIONS: "questions",
};

// ─── Fun Questions ────────────────────────────────────────────────────────────
// The question library lives in its own file (src/questions.js) so it's easy to
// edit without touching app logic. Re-exported here for convenience so existing
// imports from "./utils.js" keep working.
export { QUESTIONS, ALL_QUESTIONS, pickRandomQuestion, drawFromBag } from "./questions.js";

// ─── Languages ────────────────────────────────────────────────────────────────
export const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "fr", label: "French" },
  { code: "es", label: "Spanish" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "hi", label: "Hindi" },
  { code: "de", label: "German" },
  { code: "it", label: "Italian" },
  { code: "pt", label: "Portuguese" },
  { code: "zh", label: "Chinese" },
  { code: "ru", label: "Russian" },
];

// ─── Genres ───────────────────────────────────────────────────────────────────
export const GENRES = [
  "Action","Adventure","Animation","Comedy","Crime",
  "Documentary","Drama","Fantasy","Horror","Mystery",
  "Romance","Sci-Fi","Thriller","Western","Family",
];

// ─── Streaming Services ───────────────────────────────────────────────────────
export const SERVICES = [
  { id: "netflix", label: "Netflix", color: "#e50914" },
  { id: "hulu", label: "Hulu", color: "#1ce783" },
  { id: "hbo", label: "HBO Max", color: "#5822b4" },
  { id: "appletv", label: "Apple TV+", color: "#a2aaad" },
  { id: "peacock", label: "Peacock", color: "#0072ce" },
  { id: "disney", label: "Disney+", color: "#0063e5" },
  { id: "amazon", label: "Amazon Prime", color: "#00a8e1" },
];

// ─── TMDB Provider Map ────────────────────────────────────────────────────────
// TMDB provider_id → our internal service id
export const PROVIDER_MAP = {
  8:   "netflix",      // Netflix
  15:  "hulu",         // Hulu
  337: "disney",       // Disney+
  9:   "amazon",       // Amazon Prime Video
  384: "hbo",          // Max (HBO Max)
  386: "peacock",      // Peacock Premium
  387: "peacock",      // Peacock Free (same badge)
  389: "peacock",      // Peacock Premium Plus
  2:   "appletv",      // Apple TV
  350: "appletv",      // Apple TV+
};

// ─── Streaming Filter ─────────────────────────────────────────────────────────
// Stage 2: apply streaming filter once live TMDB data is ready
export function applyStreamingFilter(pool, criteria, tmdbData) {
  if (!criteria.services?.length) return pool.slice(0, 10);
  const filtered = pool.filter(m => {
    const d = tmdbData[m.id];
    if (!d) return true;
    const available = criteria.subscriptionOnly ? d.flatrate : d.streaming;
    return available.some(s => criteria.services.includes(s));
  });
  // If the streaming filter is too aggressive (fewer than 5 matches), fall back to
  // the full pool so users always get a decent-sized swipe deck.
  if (filtered.length < 5) return pool.slice(0, 10);
  return filtered.slice(0, 10);
}

// ─── Ranked-preference scoring (async) ────────────────────────────────────────
// In plan-ahead (async) sessions the deck is defined by the host's picks, and every
// participant RANKS that shared list of genres/cuisines instead of picking their own.
// A participant's ordered picks map to points by position: 1st = 2, 2nd = 1, 3rd = 0.
// (Beyond the third slot everything is 0 — only the top preferences steer the winner.)
export const RANK_POINTS = [2, 1, 0];
export const rankWeight = (idx) => RANK_POINTS[idx] ?? 0;

// Sum, across the given participants, the weight of every pick that matches this
// item's tags. `w(p, tag, idx)` scores a single matched pick (idx = its rank in that
// participant's ordered picks). Shared by the group and host-only preference scores.
function weightedMatch(it, participants, tagsOf, pickedOf, w) {
  const tags = (tagsOf(it) || []).map(t => String(t).toLowerCase());
  if (!tags.length) return 0;
  return participants.reduce((sum, p) => {
    const picked = pickedOf(p) || [];
    return sum + picked.reduce((s2, t, idx) =>
      tags.includes(String(t).toLowerCase()) ? s2 + w(p, t, idx) : s2, 0);
  }, 0);
}

// Deterministic, well-distributed 32-bit hash of a string → used as a STABLE random
// tiebreak (same order every render/device, but arbitrary w.r.t. quality). Salt with
// the session id so different sessions break identical ties differently.
function hashStr(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0);
}

// ─── Results decision logic ───────────────────────────────────────────────────
// Order the agreed finalists for the results screen, picking a single winner.
//
// LIVE sessions: most hearts wins first (hearts are the primary narrowing signal);
// ties break by higher rating, then by how well the item matches user-picked criteria
// (`weightOf` defaults to 1 per match — a plain "how many people picked a matching
// tag" count).
//
// ASYNC sessions (`voteOf` supplied): there is no heart round. Rank by swipe YES-count
// first, then the group's position-weighted preference score (`weightOf` = rankWeight,
// so top-ranked genres/cuisines count most), then the HOST's own ranking as the
// tiebreak (`hostId`), and finally a stable per-session random pick among anything
// still tied (`randSalt`). Rating is deliberately NOT a tiebreak in async.
export function rankFinalists(items, participants, { ratingOf, tagsOf, pickedOf, weightOf, voteOf, hostId, randSalt = "" }) {
  const heartOf = it => participants.filter(p => p.heart === it.id).length;
  const w = weightOf || (() => 1);
  const groupMatch = it => weightedMatch(it, participants, tagsOf, pickedOf, w);
  const hostParts = hostId ? participants.filter(p => p.id === hostId) : [];
  const hostMatch = it => hostParts.length ? weightedMatch(it, hostParts, tagsOf, pickedOf, w) : 0;
  const randOf = it => hashStr(`${randSalt}:${it.id}`);
  return [...items].sort((a, b) => {
    if (voteOf) {
      return (voteOf(b) - voteOf(a)) ||          // swipes
        (groupMatch(b) - groupMatch(a)) ||       // group preference score
        (hostMatch(b) - hostMatch(a)) ||         // host's ranking breaks pref ties
        (randOf(a) - randOf(b));                 // stable random among true ties
    }
    return (heartOf(b) - heartOf(a)) ||
      ((ratingOf(b) || 0) - (ratingOf(a) || 0)) ||
      (groupMatch(b) - groupMatch(a));
  });
}

// Compute the pool of movies the group "agreed" on: prefer unanimous yes, else a
// real majority (more than half, but not everyone) for 3+ people, else a
// passion-pick rescue (someone starred a movie they said yes to). Empty = "no
// match". This is the SINGLE source of truth for the yes-pool — the results screen
// renders it AND the heart-round gate keys off its size, so a majority pool of >2
// triggers hearts just like a unanimous one (otherwise the group is dumped straight
// to a >2 final that nobody got to narrow). Priority mirrors the food pool but adds
// the passion tier. Returned unsorted for the caller to rank.
export function movieAgreedPool(s) {
  const participants = s.participants || [];
  const movies = s.movies || [];
  const totalP = participants.length;
  const voteCounts = {};
  const passionCounts = {};
  movies.forEach(m => {
    voteCounts[m.id] = participants.filter(p => p.votes?.[m.id] === "yes").length;
    passionCounts[m.id] = participants.filter(p => p.passionPick === m.id && p.votes?.[m.id] === "yes").length;
  });
  const scoreOf = id => (voteCounts[id] || 0) + 2 * (passionCounts[id] || 0);
  const unanimousYes = movies.filter(m => totalP > 0 && voteCounts[m.id] === totalP);
  const majorityYes = movies
    .filter(m => voteCounts[m.id] > totalP / 2 && voteCounts[m.id] < totalP)
    .sort((a, b) => scoreOf(b.id) - scoreOf(a.id));
  const isTwo = totalP <= 2;
  const passionMovies = movies
    .filter(m => passionCounts[m.id] > 0)
    .sort((a, b) => scoreOf(b.id) - scoreOf(a.id));
  if (unanimousYes.length > 0) return unanimousYes;
  if (!isTwo && majorityYes.length > 0) return majorityYes;
  if (passionMovies.length > 0) return passionMovies;
  return [];
}

// Compute the pool of restaurants the group "agreed" on, mirroring the movie
// yes-pool logic: prefer unanimous yes, else a real majority (more than half).
// If nobody clears majority, return nothing so FoodResultsScreen shows "No
// matches" — rather than crowning a spot only one person liked (which the old
// "any ≥1 yes" fallback did in 2-person sessions). Ranked yeses-then-rating.
export function foodAgreedPool(s) {
  const participants = s.participants || [];
  const restaurants = s.restaurants || [];
  const totalP = participants.length;
  const yesOf = r => participants.filter(p => p.votes?.[r.id] === "yes").length;
  const rank = (a, b) => (yesOf(b) - yesOf(a)) || ((b.rating || 0) - (a.rating || 0));
  const unanimous = restaurants.filter(r => totalP > 0 && yesOf(r) === totalP);
  if (unanimous.length) return unanimous.sort(rank);
  return restaurants.filter(r => yesOf(r) > totalP / 2 && yesOf(r) < totalP).sort(rank);
}

