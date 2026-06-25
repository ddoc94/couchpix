// ─── Activities ────────────────────────────────────────────────────────────────
// NetPix evolves beyond movie picking. Sessions carry an `activity` field that
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

