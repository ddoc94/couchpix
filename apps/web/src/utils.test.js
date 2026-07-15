import { describe, it, expect } from 'vitest';
import { applyStreamingFilter, rankFinalists, foodAgreedPool, GENRES, LANGUAGES, SERVICES, PROVIDER_MAP } from './utils.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const makeMovie = (id, overrides = {}) => ({
  id,
  title: `Movie ${id}`,
  genres: [],
  duration: 100,
  ...overrides,
});

const movies = [
  makeMovie(1),
  makeMovie(2),
  makeMovie(3),
  makeMovie(4),
  makeMovie(5),
  makeMovie(6),
  makeMovie(7),
  makeMovie(8),
  makeMovie(9),
  makeMovie(10),
  makeMovie(11),
  makeMovie(12),
];

// tmdbData: { [id]: { streaming: [...], flatrate: [...], rent: [...] } | null }
// Enough matches per service so the "fewer than 5 → full pool" fallback does NOT trigger
// on the strict-filter tests. The fallback behavior is exercised in a separate test.
const tmdbData = {
  1:  { streaming: ['netflix', 'hulu'], flatrate: ['netflix'], rent: ['hulu'] },
  2:  { streaming: ['hbo'],             flatrate: ['hbo'],     rent: [] },
  3:  { streaming: ['disney'],          flatrate: ['disney'],  rent: [] },
  4:  { streaming: ['amazon'],          flatrate: [],          rent: ['amazon'] }, // rent-only
  5:  { streaming: [],                  flatrate: [],          rent: [] },         // nothing
  6:  { streaming: ['netflix'],         flatrate: ['netflix'], rent: [] },
  7:  { streaming: ['netflix', 'hbo', 'amazon'], flatrate: ['netflix', 'hbo', 'amazon'], rent: [] },
  8:  null,  // fetch failed — should pass through
  9:  { streaming: ['netflix', 'hbo', 'amazon'], flatrate: ['netflix', 'hbo', 'amazon'], rent: [] },
  10: { streaming: ['netflix', 'hbo'],  flatrate: ['netflix', 'hbo'], rent: [] },
  11: { streaming: ['amazon', 'hbo'],   flatrate: ['amazon', 'hbo'], rent: [] },
  12: { streaming: ['amazon', 'netflix'], flatrate: ['amazon', 'netflix'], rent: [] },
};

// ─── applyStreamingFilter ────────────────────────────────────────────────────

describe('applyStreamingFilter', () => {
  it('returns first 10 when no services selected', () => {
    const result = applyStreamingFilter(movies, { services: [] }, tmdbData);
    expect(result).toHaveLength(10);
    expect(result.map(m => m.id)).toEqual([1,2,3,4,5,6,7,8,9,10]);
  });

  it('returns first 10 when services array is absent', () => {
    const result = applyStreamingFilter(movies, {}, tmdbData);
    expect(result).toHaveLength(10);
  });

  it('filters to movies on netflix', () => {
    const result = applyStreamingFilter(movies, { services: ['netflix'] }, tmdbData);
    // ids with netflix in streaming: 1, 6, 8 (null → pass through), 10
    const ids = result.map(m => m.id);
    expect(ids).toContain(1);
    expect(ids).toContain(6);
    expect(ids).toContain(8);  // null data passes through
    expect(ids).toContain(10);
    expect(ids).not.toContain(2);  // hbo only
    expect(ids).not.toContain(3);  // disney only
    expect(ids).not.toContain(5);  // nothing
  });

  it('filters to movies on hbo', () => {
    const result = applyStreamingFilter(movies, { services: ['hbo'] }, tmdbData);
    const ids = result.map(m => m.id);
    expect(ids).toContain(2);
    expect(ids).toContain(8);   // null → pass through
    expect(ids).toContain(10);
    expect(ids).not.toContain(1);
    expect(ids).not.toContain(3);
  });

  it('unions multiple services (OR logic)', () => {
    const result = applyStreamingFilter(movies, { services: ['netflix', 'hbo'] }, tmdbData);
    const ids = result.map(m => m.id);
    expect(ids).toContain(1);   // netflix
    expect(ids).toContain(2);   // hbo
    expect(ids).toContain(6);   // netflix
    expect(ids).toContain(10);  // both
  });

  it('subscriptionOnly=true excludes rent-only entries', () => {
    // movie 4: streaming=['amazon'], flatrate=[], rent=['amazon']  → excluded when subscriptionOnly
    const result = applyStreamingFilter(
      movies,
      { services: ['amazon'], subscriptionOnly: true },
      tmdbData
    );
    const ids = result.map(m => m.id);
    expect(ids).not.toContain(4);   // rent-only on amazon
    expect(ids).toContain(11);      // flatrate amazon
    expect(ids).toContain(8);       // null → always passes
  });

  it('subscriptionOnly=false includes rent entries', () => {
    const result = applyStreamingFilter(
      movies,
      { services: ['amazon'], subscriptionOnly: false },
      tmdbData
    );
    const ids = result.map(m => m.id);
    expect(ids).toContain(4);   // rent-only included
    expect(ids).toContain(11);
  });

  it('null tmdbData entry (failed fetch) always passes through', () => {
    const result = applyStreamingFilter(
      movies,
      { services: ['netflix'] },
      tmdbData
    );
    expect(result.map(m => m.id)).toContain(8);
  });

  it('caps result at 10', () => {
    // All movies pass (all have null or netflix in this fixture variant)
    const allNull = Object.fromEntries(movies.map(m => [m.id, null]));
    const result = applyStreamingFilter(movies, { services: ['netflix'] }, allNull);
    expect(result.length).toBeLessThanOrEqual(10);
  });

  it('falls back to the full pool when fewer than 5 movies match the service filter', () => {
    // Disney has only one match (movie 3) — well under the 5-movie threshold.
    // The fallback should return the first 10 from the pool unfiltered so users
    // never end up with a tiny swipe deck.
    const result = applyStreamingFilter(movies, { services: ['disney'] }, tmdbData);
    expect(result.length).toBe(10);
    // The returned set must include movies that don't have Disney — proving the
    // fallback engaged rather than the strict filter
    const ids = result.map(m => m.id);
    expect(ids).toContain(1); // netflix/hulu, no disney
    expect(ids).toContain(2); // hbo only
  });

  it('uses strict filter (not fallback) when 5+ movies match', () => {
    // Netflix has 6+ matches in the fixture — fallback should NOT trigger
    const result = applyStreamingFilter(movies, { services: ['netflix'] }, tmdbData);
    const ids = result.map(m => m.id);
    // Disney-only movie should be excluded
    expect(ids).not.toContain(3);
    // hbo-only movie should be excluded
    expect(ids).not.toContain(2);
  });
});

// ─── GENRES constant ─────────────────────────────────────────────────────────

describe('GENRES', () => {
  it('contains expected genres', () => {
    expect(GENRES).toContain('Action');
    expect(GENRES).toContain('Comedy');
    expect(GENRES).toContain('Sci-Fi');
    expect(GENRES).toContain('Horror');
  });

  it('has 15 entries', () => {
    expect(GENRES).toHaveLength(15);
  });

  it('has no duplicates', () => {
    expect(new Set(GENRES).size).toBe(GENRES.length);
  });
});

// ─── LANGUAGES constant ───────────────────────────────────────────────────────

describe('LANGUAGES', () => {
  it('has English as first entry', () => {
    expect(LANGUAGES[0].code).toBe('en');
    expect(LANGUAGES[0].label).toBe('English');
  });

  it('has 11 entries (English + 10 others)', () => {
    expect(LANGUAGES).toHaveLength(11);
  });

  it('all entries have code and label', () => {
    LANGUAGES.forEach(lang => {
      expect(lang.code).toBeTruthy();
      expect(lang.label).toBeTruthy();
    });
  });

  it('codes are unique', () => {
    const codes = LANGUAGES.map(l => l.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('includes top languages', () => {
    const codes = LANGUAGES.map(l => l.code);
    ['fr', 'es', 'ja', 'ko', 'hi', 'de'].forEach(c => expect(codes).toContain(c));
  });
});

// ─── SERVICES constant ────────────────────────────────────────────────────────

describe('SERVICES', () => {
  it('each service has id, label, color', () => {
    SERVICES.forEach(s => {
      expect(s.id).toBeTruthy();
      expect(s.label).toBeTruthy();
      expect(s.color).toMatch(/^#/);
    });
  });

  it('ids are unique', () => {
    const ids = SERVICES.map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ─── PROVIDER_MAP ────────────────────────────────────────────────────────────

describe('PROVIDER_MAP', () => {
  it('maps known TMDB provider IDs to service IDs', () => {
    expect(PROVIDER_MAP[8]).toBe('netflix');
    expect(PROVIDER_MAP[15]).toBe('hulu');
    expect(PROVIDER_MAP[337]).toBe('disney');
    expect(PROVIDER_MAP[384]).toBe('hbo');
    expect(PROVIDER_MAP[9]).toBe('amazon');
    expect(PROVIDER_MAP[350]).toBe('appletv');
  });

  it('all mapped service IDs exist in SERVICES', () => {
    const serviceIds = new Set(SERVICES.map(s => s.id));
    Object.values(PROVIDER_MAP).forEach(sid => {
      expect(serviceIds.has(sid)).toBe(true);
    });
  });
});

// ─── rankFinalists ─────────────────────────────────────────────────────────────

describe('rankFinalists', () => {
  const opts = { ratingOf: m => m.imdb, tagsOf: m => m.genres, pickedOf: p => p.picks };

  it('ranks most-hearted first, regardless of rating', () => {
    const items = [{ id: 'a', imdb: 9, genres: [] }, { id: 'b', imdb: 5, genres: [] }];
    const parts = [{ id: 'p1', heart: 'b' }, { id: 'p2', heart: 'b' }, { id: 'p3', heart: 'a' }];
    expect(rankFinalists(items, parts, opts)[0].id).toBe('b'); // 2 hearts beats higher-rated a (1 heart)
  });

  it('breaks heart ties by higher rating', () => {
    const items = [{ id: 'a', imdb: 7, genres: [] }, { id: 'b', imdb: 8, genres: [] }];
    const parts = [{ id: 'p1', heart: 'a' }, { id: 'p2', heart: 'b' }]; // 1 heart each
    expect(rankFinalists(items, parts, opts)[0].id).toBe('b');
  });

  it('breaks heart+rating ties by most matched criteria (the movie example)', () => {
    const items = [
      { id: 'm1', imdb: 7, genres: ['Thriller', 'Drama', 'Horror'] },
      { id: 'm2', imdb: 7, genres: ['Thriller', 'Fantasy', 'Adventure'] },
    ];
    const parts = [
      { id: 'p1', picks: ['Thriller', 'Drama', 'Comedy'] },
      { id: 'p2', picks: ['Thriller', 'Horror', 'Action'] },
    ];
    // m1 matches 4 (Thriller+Drama, Thriller+Horror); m2 matches 2 (Thriller, Thriller)
    expect(rankFinalists(items, parts, opts)[0].id).toBe('m1');
  });

  it('matches criteria case-insensitively', () => {
    const items = [{ id: 'a', imdb: 7, genres: ['thriller'] }, { id: 'b', imdb: 7, genres: ['comedy'] }];
    const parts = [{ id: 'p1', picks: ['THRILLER'] }];
    expect(rankFinalists(items, parts, opts)[0].id).toBe('a');
  });

  it('does not mutate the input array', () => {
    const items = [{ id: 'a', imdb: 5, genres: [] }, { id: 'b', imdb: 9, genres: [] }];
    const copy = [...items];
    rankFinalists(items, [], opts);
    expect(items).toEqual(copy);
  });

  it('handles null rating and missing tags without throwing', () => {
    const items = [{ id: 'a', imdb: null, genres: null }, { id: 'b', imdb: undefined, genres: [] }];
    expect(() => rankFinalists(items, [{ id: 'p' }], opts)).not.toThrow();
  });
});

// ─── foodAgreedPool ────────────────────────────────────────────────────────────

describe('foodAgreedPool', () => {
  const R = (id, rating = 4) => ({ id, rating });
  const voter = (id, votes) => ({ id, votes });

  it('returns unanimous picks (everyone said yes)', () => {
    const s = {
      participants: [voter('p1', { r1: 'yes', r2: 'no' }), voter('p2', { r1: 'yes', r2: 'yes' })],
      restaurants: [R('r1'), R('r2')],
    };
    expect(foodAgreedPool(s).map(r => r.id)).toEqual(['r1']); // r1 unanimous, r2 only 1/2
  });

  it('2-person session with no unanimous returns empty (no false winner)', () => {
    const s = {
      participants: [voter('p1', { r1: 'yes', r2: 'no' }), voter('p2', { r1: 'no', r2: 'yes' })],
      restaurants: [R('r1'), R('r2')],
    };
    expect(foodAgreedPool(s)).toEqual([]); // the #5 fix — was crowning a 1-yes spot
  });

  it('prefers unanimous over mere majority', () => {
    const s = {
      participants: [
        voter('p1', { r1: 'yes', r2: 'yes' }),
        voter('p2', { r1: 'yes', r2: 'yes' }),
        voter('p3', { r1: 'yes', r2: 'no' }),
      ],
      restaurants: [R('r1'), R('r2')],
    };
    expect(foodAgreedPool(s).map(r => r.id)).toEqual(['r1']); // r1 unanimous(3), r2 majority(2) excluded
  });

  it('3-person: 2 of 3 is a majority, 1 of 3 is not', () => {
    const s = {
      participants: [voter('p1', { a: 'yes', b: 'yes' }), voter('p2', { a: 'yes', b: 'no' }), voter('p3', { a: 'no', b: 'no' })],
      restaurants: [R('a'), R('b')],
    };
    expect(foodAgreedPool(s).map(r => r.id)).toEqual(['a']); // a=2/3 majority; b=1/3 excluded
  });

  it('ranks multiple majority picks by yes-count then rating', () => {
    const parts = [0, 1, 2, 3, 4].map(i => ({
      id: 'p' + i,
      votes: { r1: i < 4 ? 'yes' : 'no', r2: i < 3 ? 'yes' : 'no', r3: i < 3 ? 'yes' : 'no' },
    }));
    const s = { participants: parts, restaurants: [R('r3', 4), R('r2', 5), R('r1', 3)] };
    // majority (>2.5): r1=4, r2=3, r3=3; sort by yes then rating → r1, r2(5), r3(4)
    expect(foodAgreedPool(s).map(r => r.id)).toEqual(['r1', 'r2', 'r3']);
  });

  it('solo session counts the single player as unanimous', () => {
    const s = { participants: [voter('p1', { r1: 'yes', r2: 'no' })], restaurants: [R('r1'), R('r2')] };
    expect(foodAgreedPool(s).map(r => r.id)).toEqual(['r1']);
  });

  it('handles missing participants/restaurants', () => {
    expect(foodAgreedPool({})).toEqual([]);
  });
});
