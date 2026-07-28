# CouchPix — Roadmap

High-level features to tackle over time, organized by perceived importance.
This is a living list — priorities and scope will evolve.

## P1

- **Improved recommendations (NetPix + FoodPix)** — recommendation quality
  still feels low at times. Covers movie discovery (TMDB + OMDb) and restaurant
  discovery relevance, plus how finalists are ranked.
- **Asynchronous sessions** — let a group decide ahead of time, separately and
  on their own schedule (e.g. "what should we do for dinner Thursday?"), instead
  of everyone swiping live at the same moment. *(v1 shipped: "Plan ahead" mode —
  headcount roster, 7-day sessions, any-device deck generation. Still open:
  notifications, late-flake escape hatches beyond "start now".)*

## P2

- **Account setup + true authentication** — there is no auth today; anyone with
  a session code or profile hash can read or overwrite it. Real accounts also
  unlock personalization and per-user analytics.
- **Onboarding flow** — gather basic personalization up front to improve
  suggestions from the first session.
- **iOS app** — currently a Capacitor shell that OTA-loads the live web app; not
  yet published to the App Store.

## P3

- **Deeper analytics** — understand user flow, behavior, successful sessions vs.
  abandons. (GA4 is now live as a starting point.)
- **Continued design updates** — building on the current "Matinee" visual theme.
