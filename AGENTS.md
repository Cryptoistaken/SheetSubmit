# SheetSubmit — Agent Rules

## Build (mandatory — Android APK)
- APK builds happen in the GitHub builder (`.github/workflows/build-android.yml`).
  It runs on pushes to `main` that touch `android/**` or the workflow file.
- After pushing Android changes to `main`, check the workflow run status ONCE
  every 30 seconds until it finishes. On failure: read the failing step, fix,
  commit, push again. On success: proceed with download/install per below.
- Website-only changes (js/css/server/index.html) deploy with the site itself
  (Express serves the repo root; no web workflow exists in this repo).
- Local builds are ALLOWED for quick verification (debug only):
  - JDK 17: `C:\Users\Ratul\.jdks\jbr-17.0.14`, SDK: `C:\Users\Ratul\android-sdk`
  - `android\gradlew.bat :app:assembleDebug --no-daemon` (from `android/`)
- Release signing requires GitHub secrets `ANDROID_KEYSTORE_BASE64` +
  `ANDROID_KEYSTORE_PASSWORD` (decoded to `android/android-release.keystore`
  in CI). Without them CI falls back to debug signing. Never rely on a local
  release build — the keystore lives only in GitHub secrets.

### Workflow reference — `.github/workflows/build-android.yml`
- **Name:** `Build Android APK`; **triggers:** `workflow_dispatch` + push to
  `main` with paths `android/**` or the workflow file itself.
- **Permissions:** `contents: read` only.
- **Steps:** checkout → `actions/setup-java@v5` (temurin JDK 17) →
  `gradle/actions/setup-gradle@v6` → decode keystore (if
  `ANDROID_KEYSTORE_BASE64` set: `base64 -d > android/android-release.keystore`,
  exports `KEYSTORE_PASSWORD`) → `./gradlew assembleRelease --no-daemon`
  with env `VERSION_CODE: ${{ github.run_number }}` (workdir `android`) →
  upload artifact `sheetsubmit-apk` from
  `android/app/build/outputs/apk/release/app-release.apk`
  (`if-no-files-found: error`).

## Download & Install
- Download and install **`app-release.apk`** from the `sheetsubmit-apk`
  artifact of the successful run.
- Fresh-download to a clean directory before installing (stale APKs caused
  version/signature mismatch before).
- `versionCode` = CI `GITHUB_RUN_NUMBER` (env `VERSION_CODE`), `versionName "1.0"`.
  Updates are install-overs and PRESERVE all app data — never uninstall just
  to update.

### Install flow
1. Run `adb devices`.
2. If a device is listed (`localhost:5557` shows `device`):
   - Install over the old app WITHOUT uninstalling:
     `adb -s localhost:5557 install -r <apk>`
   - Only uninstall first on:
     - `INSTALL_FAILED_UPDATE_INCOMPATIBLE` / `INSTALL_FAILED_SIGNATURE` → signature differs; uninstall once, then all future updates install over cleanly.
     - `INSTALL_FAILED_VERSION_DOWNGRADE` → installed versionCode is higher; uninstall, or fetch the newer artifact.
   - If not installed, install directly.
   - Verify with `adb -s localhost:5557 shell dumpsys package com.sheetsubmit.app`.
3. If NOT listed: skip the install (the APK is still available from the
   `sheetsubmit-apk` artifact). Do NOT start any emulator/AVD on your own.
   When the user later says to install after starting the device:
   `adb -s localhost:5557 install -r <apk>`.

## Device notes
- App package: `com.sheetsubmit.app`. Device ABI: `arm64-v8a`.
- The app is a single WebView wrapper around `https://sheetsubmit.up.railway.app`
  plus a floating-bubble overlay service.

## State Snapshot & Restore

Before making any major changes (UI redesign, architecture changes, etc.),
always snapshot the current working state so you can restore it later.

### Creating a snapshot
```bash
git tag -a pre-<feature-name> -m "Working state before <feature>"
git push origin pre-<feature-name>
```

### Listing available snapshots
```bash
git tag -l --sort=-creatordate
```

### Restoring a snapshot
```bash
# Safe — new branch from the tagged state (preserves current work)
git checkout -b restore-from-<tag> <tag>

# Destructive — reset to the tagged state
git reset --hard <tag>

# Cherry-pick specific commits back
git log <tag>..HEAD --oneline
git revert <commit-hash>
```

### Tag naming convention
- `pre-<feature-name>` — before starting a feature (e.g. `pre-bubble`)
- `stable-<date>` — known working release (e.g. `stable-2026-08-10`)
- `post-<feature-name>` — after completing a feature

### Important notes
- Tags are lightweight and don't affect branch history.
- Always push tags to remote so they survive local disasters.
- No snapshots exist yet — create the first `pre-` tag before any redesign.
- `design.md` at the repo root is the design system reference; `prototype/ideas.md`
  documents the floating-bubble design options.

## Filesystem Map & References (KEEP UPDATED)

> **Rule:** Whenever the repo structure changes (files/dirs added, moved,
> renamed, or deleted), update this map in the same commit. Read this section
> first for fast orientation instead of re-scanning the tree.

### Root
| Path | Purpose |
|---|---|
| `AGENTS.md` | This file — agent rules, build/install flow, snapshots, filesystem map |
| `index.html` | The whole SPA shell (topbar, gear/profile menu, home/sheet views, modals, FAB) |
| `design.md` / `PLAN.md` | Design system reference / development plan |
| `prototype/ideas.md` | Floating-bubble design options doc |
| `css/` | base.css (tokens/theme), layout.css (topbar/grid), touch.css, components.css (buttons/modals), dashboard.css (profile panel), bubble.css (mini-window + picker) |
| `js/` | theme.js, types.js, api.js, state.js, home.js, sheet.js, app.js, bubble.js (+ `adapters/`, `filetypes/`) |
| `server/` | Express + ioredis backend (`index.js`, `backup.js`); run via `bun run` |
| `public/` | Logos/favicons |
| `package.json` | `bun run server/index.js` (start), `bun --watch` (dev) |
| `.github/workflows/build-android.yml` | **ONLY** Android APK build (CI; `main` + `android/**`) |
| `android/` | Android app (WebView wrapper + bubble service) |

### `android/app/build.gradle` (app module)
- compileSdk 34, minSdk 26, targetSdk 34; namespace/applicationId `com.sheetsubmit.app`
- `versionCode` from env `VERSION_CODE` (CI run number), default 1; `versionName "1.0"`
- Release signing: `android-release.keystore` + env `KEYSTORE_PASSWORD`, else debug; `minifyEnabled false`
- No dependencies, **no AndroidX** (`android.useAndroidX=false`), Java 11
- Gradle 8.7 wrapper, AGP 8.4.0 (root `build.gradle`)

### Java source — `android/app/src/main/java/com/sheetsubmit/app/`
| File | Responsibility |
|---|---|
| `MainActivity.java` | WebView host; loads `HOME_URL`; JS bridge `Android` (`readClipboard`, `writeClipboard`, `isBubbleEnabled`, `enableBubble`, `disableBubble`); device-login polling (`/api/auth/device` → session cookie via CookieManager); URL routing (tg:// and t.me open externally with device token, APP_HOST loads in-app) |
| `FloatingBubbleService.java` | **Bubble** — 60dp draggable overlay (TYPE_APPLICATION_OVERLAY, display context), tap opens ~240×300dp mini panel with a WebView loading `HOME_URL/?bubble=1&file=<id>`; foreground service (specialUse), `START_STICKY`; file id from prefs key `bubble_file` |

### Manifest — `android/app/src/main/AndroidManifest.xml`
- Permissions: INTERNET, VIBRATE, WRITE_EXTERNAL_STORAGE (maxSdk 28), SYSTEM_ALERT_WINDOW, FOREGROUND_SERVICE, FOREGROUND_SERVICE_SPECIAL_USE, POST_NOTIFICATIONS
- `MainActivity`: exported=true, launcher, configChanges
- `FloatingBubbleService`: exported=false, foregroundServiceType `specialUse` + `PROPERTY_SPECIAL_USE_FGS_SUBTYPE`

### Resources — `android/app/src/main/res/`
- `drawable/ic_launcher_foreground.xml`, `mipmap-anydpi-v26/` adaptive icons, `values/` (colors, strings, themes — black NoActionBar)

### Website — `js/`
| File | Responsibility |
|---|---|
| `api.js` | fetch wrapper for `/api/*` (files, rows, persist, sync, checks, versions, admin) |
| `types.js` | File types: `ig_cookie`, `fb_cookie` (columns: cookies/twofakey/uid) |
| `state.js` | DOM refs (`__ss.dom`), shared state, toasts, helpers (`esc`, `genId`, tap-hold) |
| `home.js` | Home grid, FAB create-file menu, xlsx import, archive |
| `sheet.js` | Sheet engine: `openFile`, `renderSheet` (grid HTML), cell editing, check/sync, undo/redo, versions; `__ss.refreshSheet` (lightweight re-render) |
| `app.js` | Auth check, gear/profile panel, health polling, deep-link restore |
| `bubble.js` | **Bubble feature (Android-only)** — gear menu row (`#bubbleMenuRow`), FB Cookie file picker modal, `enableBubble` bridge calls; mini-window mode `?bubble=1&file=<id>`: sets `__ss.bubbleRowLimit = 10`, 6s auto-refresh (no file-name strip) |
| `filetypes/` | `fbcookie.js` (cookie/2FA validation, TOTP SHA-1 30s 6-digit), `igcookie.js`, index |
| `adapters/` | xlsx import adapters |

### Website — `server/index.js` (key endpoints)
- `GET /api/auth/me` · `GET/POST /api/auth/device` (device login) · `GET /api/bot/info`
- `GET/POST /api/files`, `GET/PUT/DELETE /api/files/:id`, `GET /api/files/:id/rows`, `PUT /api/files/:id/persist`, `PUT /cell`, `GET /logs`, `GET /undo`
- `POST /fb/wa-check`, `GET /wa/cache`, history/versions, admin twin endpoints
- Static: `express.static(ROOT)` + SPA fallback → `index.html`

### Design system (design.md)
- Geist/Vercel tokens, light+dark via `[data-theme="dark"]`, z-index ladder
  (popups 600, modals 700, gear panel 800, toast 9999)
- Reuse existing classes: `.btn*`, `.modal-overlay/.modal-box`, `.home-fab-item`,
  `.file-type-badge.t-fb`, `.gear-toggle-row`, `.toggle-switch`, grid cells `.rh/.ch/.dc/.row-dot`

## Floating bubble feature notes (do not regress)
- Menu row only appears inside the Android app — gate is `window.Android`
  (bridge registered by `MainActivity`; `nativeClipboardReady` is injected too
  late for deferred scripts).
- The mini WebView registers the SAME `Android` bridge (`isApp`,
  `readClipboard`, `writeClipboard`) via `addJavascriptInterface`, so
  `BUBBLE_MODE` activates in the mini window too.
- The mini window reuses the real site renderer: `?bubble=1&file=<id>` → `bubble.js` calls the existing `__ss.openFile`, CSS (`body.bubble-mode` in `bubble.css`) compacts it; only 10 rows shown; the whole page is zoomed `0.7` to fit.
- The popup has NO header and NO file-name strip — the panel is closed only by tapping the scrim around the card.
- A compact topbar stays visible in the mini window: only undo/redo/check/⋮ (`#sheetBtns`); logo, title, back, sheet name, conn status, profile, gear panel, and sync group are hidden.
- Session cookie is shared automatically via `CookieManager` — no separate login in the mini WebView.
- Engine-adjacent code to treat carefully: `sheet.js` rendering/persist logic and `server/` persistence — the mini window depends on both.
