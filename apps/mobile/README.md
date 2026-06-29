# netpix-mobile

A Capacitor shell that wraps the **netpix-app** web build as a native iOS/Android app, without duplicating any code. The web app at `../netpix-app/` stays the source of truth — this directory just packages it into a native shell.

## How it's wired (OTA mode)

```
netpix-proxy/
├── netpix-app/              ← your existing React/Vite web app (unchanged)
│   └── dist/                ← bundled FALLBACK only — see "OTA" below
├── netpix-mobile/           ← this directory (Capacitor shell)
│   ├── capacitor.config.ts  ← server.url → Vercel; webDir → fallback
│   ├── ios/                 ← created by `npx cap add ios`
│   └── android/             ← created by `npx cap add android`
└── src/                     ← Cloudflare worker (unchanged)
```

**Default mode is OTA:** `capacitor.config.ts` sets `server.url: 'https://netpix-app.vercel.app'`. The native app launches a webview pointing at the live production URL on Vercel. Whenever you push to `netpix-app/main` → Vercel auto-deploys → the **next mobile app launch gets the latest bundle** with no App Store review, no app update.

The `webDir: '../netpix-app/dist'` is still required by the Capacitor CLI as a fallback bundle that ships inside the binary (App Store reviewers run it offline). To refresh that fallback before submitting a new build, run `npm run sync`.

**Why OTA here?** CouchPix requires internet to function (TMDB, OMDB, Cloudflare Worker for KV sessions). Offline mode wouldn't add value — so we take advantage of the always-online assumption and get instant updates.

## One-time setup

### iOS (macOS only)

1. Install **Xcode** from the App Store.
2. Install Xcode command-line tools: `xcode-select --install`.
3. Install **CocoaPods**:
   ```sh
   sudo gem install cocoapods
   # or, if you use Homebrew:
   brew install cocoapods
   ```
4. From this directory, add the iOS platform:
   ```sh
   npx cap add ios
   ```
   This creates `ios/App/App.xcworkspace`.

### Android

1. Install **Android Studio** from <https://developer.android.com/studio>.
2. During first run, let it download the Android SDK + a recent platform-tools.
3. Set `ANDROID_HOME` in your shell rc (`~/.zshrc` or `~/.bash_profile`):
   ```sh
   export ANDROID_HOME="$HOME/Library/Android/sdk"
   export PATH="$PATH:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator"
   ```
4. From this directory, add the Android platform:
   ```sh
   npx cap add android
   ```
   This creates `android/` with a Gradle project.

## Day-to-day workflow

Edit the web app in `../netpix-app/` as normal. **Once the new code is on Vercel (via push to main), users on iOS and Android already have it — they just need to reopen the app.**

You only need to touch `netpix-mobile/` when you change something native:
- App icon, splash screen, app name, bundle ID
- Add a Capacitor plugin (push notifications, haptics, etc.)
- Refresh the bundled fallback that App Store reviewers see
- Ship a new build to TestFlight / Play Store

```sh
# Build the web app + sync the bundled fallback into iOS/Android shells
npm run sync

# Open Xcode (you can then ⌘R to run in a simulator)
npm run ios

# Open Android Studio
npm run android

# Run on a connected device or simulator without opening the IDE first
npm run ios:run
npm run android:run
```

`npm run sync` runs `cd ../netpix-app && npm run build` followed by `cap sync`. You don't need to run this for ordinary JS changes — those flow through Vercel automatically.

### Turning OTA off

If you ever need to ship an offline-capable build (or pin a specific bundle that doesn't auto-update), comment out the `server.url` line in `capacitor.config.ts` and run `npm run sync`. The app will now load exclusively from the bundled `dist/`. Re-enable later by uncommenting.

## App identity

- **Bundle / app ID:** `com.netpix.app` (edit in `capacitor.config.ts` if you have a conflict)
- **App name:** `CouchPix`
- **Display icon + splash:** placeholders for now. To customize, drop a 1024×1024 PNG at `resources/icon.png` and a 2732×2732 splash at `resources/splash.png`, then install `@capacitor/assets` and run `npx capacitor-assets generate` (one-off command, regenerates all sizes for iOS + Android).

## Don't add Capacitor-specific plugins (yet)

To keep the future React Native migration clean, **avoid pulling in Capacitor plugins for push notifications, file system, camera, etc.** Use plain web APIs (`fetch`, `localStorage`) in the webapp — the React Native rewrite will have direct equivalents. If you absolutely need a native API, document the wrapper in a small file (e.g., `netpix-app/src/native.js`) so it's easy to swap later.

## Shipping

### iOS
1. In Xcode (`npm run ios`), set the team/signing under "Signing & Capabilities".
2. **Test on a device** by plugging in your iPhone, selecting it in Xcode, and hitting ⌘R.
3. **TestFlight:** Archive (Product → Archive) → Distribute App → App Store Connect.
4. **App Store:** submit the build from App Store Connect once TestFlight feedback is in.

### Android
1. In Android Studio (`npm run android`), Build → Generate Signed Bundle/APK.
2. Upload the `.aab` to Google Play Console.

## When you outgrow this

If the webview ceiling starts mattering (swipe physics, push notifications, deep platform features), pivot to React Native + Expo:
- Most of `netpix-app/src/utils.js` and the API wrappers in `netpix-app/src/movie-night.jsx` are portable as-is.
- The Cloudflare worker stays the same — both clients hit the same API.
- The KV-backed sessions are platform-agnostic, so web and native users can join the same movie night.
- See the conversation history with Claude for a full migration plan; expect ~3 weeks of focused work.
