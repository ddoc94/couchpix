import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.netpix.app',
  appName: 'CouchPix',

  // webDir is still required by the Capacitor CLI even when we use OTA below.
  // It's used as the *fallback* bundle that ships inside the binary.
  // Run `npm run sync` from this directory to rebuild the web app and refresh
  // the bundled fallback.
  webDir: '../web/dist',

  server: {
    // ──────────────────────────────────────────────────────────────────────
    //  OTA: load the live web app from Vercel on every launch
    // ──────────────────────────────────────────────────────────────────────
    //  This makes the native shell a thin wrapper around the production web
    //  app. Whenever you push to main, Vercel auto-deploys, and the next time
    //  a user opens the iOS/Android app they get the latest bundle — no App
    //  Store review, no app update needed.
    //
    //  Loads the primary custom domain (couchpix.com). The legacy Vercel URL
    //  (netpix-app.vercel.app) still serves the same app, so older installed
    //  binaries that were built before this change keep working.
    //
    //  When this is set, Capacitor loads the URL on every launch and the
    //  bundled `webDir` content is ignored (kept only as a marketing-required
    //  fallback that App Store reviewers see).
    //
    //  Tradeoff: the app requires internet to launch. That's fine for CouchPix
    //  since the worker, TMDB, and KV sessions are all online-only anyway.
    //  If you ever ship offline-capable features, switch to a real bundled
    //  build by commenting out the `url` line below.
    url: 'https://couchpix.com',
    androidScheme: 'https',
  },

  ios: {
    contentInset: 'always', // sane default for notched devices
    // Use the https scheme internally on iOS so localStorage/sessionStorage
    // stays consistent whether the user is on the live Vercel URL or the
    // bundled fallback. Without this, the two contexts can't see each
    // other's profile data.
    scheme: 'https',
  },
};

export default config;
