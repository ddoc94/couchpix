import { test, expect } from '@playwright/test';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const WORKER = 'https://netpix-proxy.netpix2026.workers.dev';

/** Directly PUT a session into KV so tests don't depend on the UI flow for setup */
async function seedSession(request, overrides = {}) {
  const id = 'PW' + Math.random().toString(36).slice(2, 6).toUpperCase();
  const session = {
    id,
    adminId: 'user-admin',
    participants: [
      { id: 'user-admin', name: 'Alice', votes: {}, done: false, genres: [], prefsDone: false },
    ],
    criteria: { services: [], subscriptionOnly: false, duration: null, languages: ['en'] },
    movies: [],
    started: false,
    round: 1,
    ...overrides,
  };
  const res = await request.put(`${WORKER}/session/${id}`, { data: session });
  expect(res.ok()).toBeTruthy();
  return session;
}

/** Seed a session that already has movies + everyone swiped, ready for results */
async function seedCompletedSession(request, movieCount = 4) {
  const movies = Array.from({ length: movieCount }, (_, i) => ({
    id: 1000 + i,
    title: `Test Movie ${i + 1}`,
    year: 2020,
    genres: ['Action'],
    description: 'A test movie.',
    actors: ['Actor One', 'Actor Two'],
    duration: 110,
    imdb: 7.5,
    rt: 80,
    mpaa: 'PG-13',
    director: 'Jane Director',
    awards: null,
    poster: null,
    streaming: [],
    color: '#1a1a24',
  }));

  // Only movie[0] gets unanimous yes — keeps unanimousIds.size = 1 ≤ 2 → straight to final phase
  const aliceVotes = Object.fromEntries(movies.map((m, i) => [m.id, i === 0 ? 'yes' : 'no']));
  const bobVotes   = Object.fromEntries(movies.map((m, i) => [m.id, i === 0 ? 'yes' : 'no']));
  const bob = {
    id: 'user-bob', name: 'Bob', votes: bobVotes,
    done: true, genres: ['Action'], prefsDone: true,
  };

  return seedSession(request, {
    participants: [
      { id: 'user-admin', name: 'Alice', votes: aliceVotes, done: true, genres: ['Action'], prefsDone: true },
      bob,
    ],
    criteria: { services: [], subscriptionOnly: false, duration: null, languages: ['en'] },
    movies,
    started: true,
    moviesGenerated: true,
  });
}

/** Open the app and tap the Movie Night activity tile to reach its sub-home
 *  (where Create a Session / Enter Code live). The home screen now leads with
 *  activity tiles — Movie Night, Food Night, Unhinged Questions — so the
 *  movie-night flow starts one tap deeper than it used to. */
async function gotoMovieNight(page) {
  await page.goto('/');
  await page.getByRole('button', { name: /movie night/i }).click();
}

// ─── Home screen ─────────────────────────────────────────────────────────────

test('home screen renders activity tiles', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'NetPix' })).toBeVisible();
  await expect(page.getByRole('button', { name: /movie night/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /food night/i })).toBeVisible();
  // Demo mode button should be gone
  await expect(page.getByText(/demo mode/i)).not.toBeVisible();
});

test('movie night screen renders create and join options', async ({ page }) => {
  await gotoMovieNight(page);
  await expect(page.getByRole('heading', { name: 'Movie Night' })).toBeVisible();
  await expect(page.getByRole('button', { name: /create a session/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /enter code/i })).toBeVisible();
});

// ─── Setup flow ───────────────────────────────────────────────────────────────

test('organizer can create a session and reach lobby', async ({ page }) => {
  await gotoMovieNight(page);
  await page.getByRole('button', { name: /create a session/i }).click();
  await expect(page.getByText(/your name/i)).toBeVisible();

  await page.getByPlaceholder(/e\.g\. Alex/i).fill('Alice');
  await page.getByRole('button', { name: /create session/i }).click();

  // Should land on the lobby: session code, participant list, and (as admin)
  // the Start Session button.
  await expect(page.getByText(/session code/i)).toBeVisible();
  await expect(page.getByText(/participants/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /start session/i })).toBeVisible();
  const code = await page.locator('[style*="font-family: monospace"]').first().textContent();
  expect(code?.trim()).toMatch(/^[A-Z0-9]{6}$/);
});

test('QR code is visible in lobby', async ({ page }) => {
  await gotoMovieNight(page);
  await page.getByRole('button', { name: /create a session/i }).click();
  await page.getByPlaceholder(/e\.g\. Alex/i).fill('Alice');
  await page.getByRole('button', { name: /create session/i }).click();

  const qr = page.locator('svg[role="img"], canvas, svg').first();
  await expect(qr).toBeVisible();
});

// ─── Join flow ────────────────────────────────────────────────────────────────

test('second user can join by session code', async ({ page, request }) => {
  const session = await seedSession(request);

  await gotoMovieNight(page);
  await page.getByRole('button', { name: /enter code/i }).click();

  await page.getByPlaceholder(/e\.g\. Jordan/i).fill('Bob');
  await page.locator('input[maxlength="6"]').fill(session.id);
  await page.getByRole('button', { name: /join session/i }).click();

  // Bob lands in the lobby as a non-admin participant
  await expect(page.getByText(/waiting for the organizer/i)).toBeVisible();
  await expect(page.getByText('Bob')).toBeVisible();
});

test('joining a non-existent session shows error', async ({ page }) => {
  await gotoMovieNight(page);
  await page.getByRole('button', { name: /enter code/i }).click();

  await page.getByPlaceholder(/e\.g\. Jordan/i).fill('Bob');
  await page.locator('input[maxlength="6"]').fill('ZZZZZZ');
  await page.getByRole('button', { name: /join session/i }).click();

  await expect(page.getByText(/session not found/i)).toBeVisible();
});

// ─── QR deep-link join ───────────────────────────────────────────────────────

test('visiting the session URL goes straight to join screen', async ({ page, request }) => {
  const session = await seedSession(request);

  await page.goto(`/?session=${session.id}`);
  // Code input should be pre-filled — confirms the app parsed the URL param and loaded the join screen
  const codeInput = page.locator('input[maxlength="6"]');
  await expect(codeInput).toBeVisible();
  await expect(codeInput).toHaveValue(session.id);
});

// ─── Preferences screen ───────────────────────────────────────────────────────

test('preferences screen shows genre picker', async ({ page, request }) => {
  // Seed a started session and land Alice directly on prefs
  const session = await seedSession(request, { started: true });

  // Load the app with the session pre-loaded via sessionStorage
  await page.goto('/');
  await page.evaluate((s) => {
    sessionStorage.setItem('mn_screen', JSON.stringify('prefs'));
    sessionStorage.setItem('mn_session', JSON.stringify(s));
    sessionStorage.setItem('mn_userid', JSON.stringify(s.adminId));
  }, session);
  await page.reload();

  // Genre chips should be visible (Action, Comedy etc.)
  await expect(page.getByRole('button', { name: 'Action' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Comedy' }).first()).toBeVisible();
});

test('organizer sees streaming and duration fields', async ({ page, request }) => {
  const session = await seedSession(request, { started: true });

  await page.goto('/');
  await page.evaluate((s) => {
    sessionStorage.setItem('mn_screen', JSON.stringify('prefs'));
    sessionStorage.setItem('mn_session', JSON.stringify(s));
    sessionStorage.setItem('mn_userid', JSON.stringify(s.adminId));
  }, session);
  await page.reload();

  await expect(page.getByText(/streaming services/i)).toBeVisible();
  await expect(page.getByText(/movie length/i)).toBeVisible();
  await expect(page.getByText(/audio language/i)).toBeVisible();
  await expect(page.getByText('English')).toBeVisible();
});

test('non-admin does not see streaming/duration/language fields', async ({ page, request }) => {
  const session = await seedSession(request, {
    started: true,
    participants: [
      { id: 'user-admin', name: 'Alice', votes: {}, done: false, genres: [], prefsDone: false },
      { id: 'user-bob',   name: 'Bob',   votes: {}, done: false, genres: [], prefsDone: false },
    ],
  });

  await page.goto('/');
  await page.evaluate((s) => {
    sessionStorage.setItem('mn_screen', JSON.stringify('prefs'));
    sessionStorage.setItem('mn_session', JSON.stringify(s));
    sessionStorage.setItem('mn_userid', JSON.stringify('user-bob'));
  }, session);
  await page.reload();

  await expect(page.getByRole('button', { name: 'Action' }).first()).toBeVisible();
  await expect(page.getByText(/streaming services/i)).not.toBeVisible();
  await expect(page.getByText(/audio language/i)).not.toBeVisible();
});

test('genre limit enforced (max 3 for small group)', async ({ page, request }) => {
  const session = await seedSession(request, { started: true });

  await page.goto('/');
  await page.evaluate((s) => {
    sessionStorage.setItem('mn_screen', JSON.stringify('prefs'));
    sessionStorage.setItem('mn_session', JSON.stringify(s));
    sessionStorage.setItem('mn_userid', JSON.stringify(s.adminId));
  }, session);
  await page.reload();

  // Click 4 genres — 4th should be ignored (button stays inactive).
  // Use .first() to target the Genres section (Vetoes section has duplicate chips).
  const genreButtons = ['Action', 'Comedy', 'Horror', 'Drama'];
  for (const g of genreButtons) {
    await page.getByRole('button', { name: new RegExp(`^${g}$`) }).first().click();
  }

  // Expect counter to show 3/3, not 4/3
  await expect(page.getByText(/3\/3 selected/i)).toBeVisible();
});

// ─── Swiping screen ───────────────────────────────────────────────────────────

test('swiping screen shows movie cards', async ({ page, request }) => {
  const session = await seedCompletedSession(request);
  // Reset votes so Alice hasn't swiped yet
  const fresh = {
    ...session,
    participants: session.participants.map(p =>
      p.id === 'user-admin' ? { ...p, votes: {}, done: false } : p
    ),
  };
  const res = await request.put(`${WORKER}/session/${session.id}`, { data: fresh });
  expect(res.ok()).toBeTruthy();

  await page.goto('/');
  await page.evaluate((s) => {
    sessionStorage.setItem('mn_screen', JSON.stringify('swiping'));
    sessionStorage.setItem('mn_session', JSON.stringify(s));
    sessionStorage.setItem('mn_userid', JSON.stringify('user-admin'));
  }, fresh);
  await page.reload();

  await expect(page.getByText('Test Movie 1')).toBeVisible();
  // Skip and watch buttons
  await expect(page.getByRole('button', { name: '✕' })).toBeVisible();
  await expect(page.getByRole('button', { name: '♥' })).toBeVisible();
});

test('clicking skip advances to next movie', async ({ page, request }) => {
  const session = await seedCompletedSession(request);
  const fresh = {
    ...session,
    participants: session.participants.map(p =>
      p.id === 'user-admin' ? { ...p, votes: {}, done: false } : p
    ),
  };
  await request.put(`${WORKER}/session/${session.id}`, { data: fresh });

  await page.goto('/');
  await page.evaluate((s) => {
    sessionStorage.setItem('mn_screen', JSON.stringify('swiping'));
    sessionStorage.setItem('mn_session', JSON.stringify(s));
    sessionStorage.setItem('mn_userid', JSON.stringify('user-admin'));
  }, fresh);
  await page.reload();

  await expect(page.getByText('Test Movie 1')).toBeVisible();
  await page.getByRole('button', { name: '✕' }).click();
  await expect(page.getByText('Test Movie 2')).toBeVisible({ timeout: 2000 });
});

// ─── Results screen ───────────────────────────────────────────────────────────

test('results screen shows matched movies', async ({ page, request }) => {
  const session = await seedCompletedSession(request);

  await page.goto('/');
  await page.evaluate((s) => {
    sessionStorage.setItem('mn_screen', JSON.stringify('results'));
    sessionStorage.setItem('mn_session', JSON.stringify(s));
    sessionStorage.setItem('mn_userid', JSON.stringify('user-admin'));
  }, session);
  await page.reload();

  // Should skip waiting phase (all done) and show results
  await expect(page.getByText(/tonight you're watching|top picks/i)).toBeVisible({ timeout: 10_000 });
});

test('results screen has new round and new session buttons', async ({ page, request }) => {
  const session = await seedCompletedSession(request);

  await page.goto('/');
  await page.evaluate((s) => {
    sessionStorage.setItem('mn_screen', JSON.stringify('results'));
    sessionStorage.setItem('mn_session', JSON.stringify(s));
    sessionStorage.setItem('mn_userid', JSON.stringify('user-admin'));
  }, session);
  await page.reload();

  await expect(page.getByRole('button', { name: /new round/i })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: /new session/i })).toBeVisible({ timeout: 10_000 });
});

// ─── Reset / header ───────────────────────────────────────────────────────────

test('reset button returns to home', async ({ page }) => {
  await gotoMovieNight(page);
  await page.getByRole('button', { name: /create a session/i }).click();
  await page.getByPlaceholder(/e\.g\. Alex/i).fill('Alice');
  await page.getByRole('button', { name: /create session/i }).click();

  await expect(page.getByText(/session code/i)).toBeVisible();
  await page.getByRole('button', { name: /reset/i }).click();

  await expect(page.getByRole('heading', { name: 'NetPix' })).toBeVisible();
});

// ─── Mobile viewport smoke test ──────────────────────────────────────────────

test('home screen fits mobile viewport without horizontal scroll', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); // iPhone 14
  await page.goto('/');

  const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
  const viewportWidth = await page.evaluate(() => window.innerWidth);
  expect(bodyWidth).toBeLessThanOrEqual(viewportWidth);
});
