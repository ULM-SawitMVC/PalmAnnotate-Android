# PalmAnnotate — Agent Guide

Oil-palm fresh-fruit-bunch (FFB) image annotation tool. **Dual-target from one codebase:**
a browser app (File System Access API) and an Android app (Capacitor WebView). The same
copied web assets run unmodified on both; platform differences are isolated behind small
adapters (`Storage`, capture sources, `Detector` runtime).

> This file is the canonical agent guide. `AGENTS.md` points here — keep changes in this file.

## Big picture

- **No build step for app logic.** The app is plain ES5/ES2017 **classic `<script>` files** (no
  bundler, no modules). Each file is an IIFE that attaches its public API to `window.*` and they
  share one global lexical scope (load order in `index.html` matters — see bottom of that file).
- **Source of truth lives at the repo root:** `index.html`, `js/`, `css/`, `assets/`, `models/`.
- `scripts/build-www.mjs` copies those into `www/` (Capacitor's `webDir`) and vendors a **slim**
  subset of `onnxruntime-web` into `www/vendor/onnxruntime/` for **offline** on-device detection.
- `cap sync` then copies `www/` into `android/app/src/main/assets/public/`. **Never hand-edit the
  Android `assets/public/` copy or `www/` — edit the root sources and rebuild.**

```
root (EDIT HERE) ──build-www.mjs──▶ www/ ──cap sync──▶ android/.../assets/public/ (generated)
```

## Commands (npm)

| Command            | What it does                                                        |
| ------------------ | ------------------------------------------------------------------- |
| `npm test`         | Run the Node test suite (`node --test "test/*.mjs"`). **Primary.**  |
| `npm run build:www`| Assemble `www/` from root sources (+ vendor ORT).                   |
| `npm run sync`     | `build:www` then `cap sync` (push web assets into the Android app). |
| `npm run android`  | `sync` then `cap open android` (opens Android Studio).              |
| `npm run serve`    | `build:www` then serve `www/` on :4173 for browser testing.         |

Run from the repo root. There is no separate lint step.

## Toolchain / starter pack (this machine)

The Android build needs a **JDK** and the **Android SDK** — neither is on `PATH` by default here.
Verified working locations on this machine:

| Tool         | Path                                   | Notes                                      |
| ------------ | -------------------------------------- | ------------------------------------------ |
| JDK 17       | `C:\tools\jdk17\jdk-17.0.19+10`        | Set as `JAVA_HOME`. Works with Gradle 8.2.1 / Capacitor 6. |
| Android SDK  | `C:\tools\android-sdk`                 | Already referenced by `android/local.properties` (`sdk.dir=...`). |
| Gradle       | via `android/gradlew.bat` (8.2.1)      | Wrapper — no separate install needed.      |
| Node + npm   | on `PATH`                              | For `npm test` / `build:www` / `cap sync`. |
| adb          | `C:\tools\android-sdk\platform-tools\adb.exe` | For installing the APK to a device. |

`local.properties` is machine-local and git-ignored — recreate it with `sdk.dir=C\:\\tools\\android-sdk`
if it's missing. Install a JDK (17) and the Android SDK (cmdline-tools + `platforms;android-34` +
`build-tools;34.x`) if setting this up on a fresh machine.

## Compile the Android APK

> **STANDING INSTRUCTION — always leave a fresh APK (do this without being asked).**
> Whenever a turn changes anything that ends up in the APK — the root web sources (`index.html`,
> `js/`, `css/`, `assets/`, `models/`) or the `android/` project — finish the turn by rebuilding:
> run `npm test`, then the compile sequence below, then report **BUILD SUCCESSFUL/failed + the APK
> path**. The goal is that the user never has to come back and ask "rebuild it" — the installable
> `app-debug.apk` is always current at end of turn.
>
> - Run it at the **end of the turn**, after all edits for that turn are done (one build per turn, not
>   one per file).
> - **Skip the rebuild only** when the turn changed nothing that affects the APK — i.e. edits limited
>   to docs (`CLAUDE.md`, `AGENTS.md`, `docs/`) or `test/*` files. When skipping, say so in one line
>   ("docs/tests only — APK unchanged, not rebuilt") so it's a deliberate choice, not a forgotten step.
> - If the build **fails**, fix it before ending the turn (a red build is never "done"); if it can't be
>   fixed, surface the error and the last-good APK's status explicitly.
> - Gradle is incremental: if sources are byte-identical the APK legitimately won't change timestamp —
>   that's correct, just note it. Use `clean assembleDebug` only when a from-zero build is actually needed.

`npm run sync` / `cap sync` only copies web assets into the Android project; it does **not** produce
an APK. To compile, set the env vars and run the Gradle wrapper. From **PowerShell** at the repo root:

```powershell
$env:JAVA_HOME      = 'C:\tools\jdk17\jdk-17.0.19+10'
$env:ANDROID_HOME   = 'C:\tools\android-sdk'
$env:PATH           = "$env:JAVA_HOME\bin;$env:PATH"

npm run sync                              # rebuild www/ + push into android/ (do this after any js/css edit)
cd android
.\gradlew.bat assembleDebug --no-daemon   # ~45-60s once dependencies are cached
```

Output APK (debug-signed, directly installable):

```
android\app\build\outputs\apk\debug\app-debug.apk
```

Install to a connected device (USB debugging on):

```powershell
C:\tools\android-sdk\platform-tools\adb.exe install -r `
  "android\app\build\outputs\apk\debug\app-debug.apk"
```

Other Gradle targets: `assembleRelease` (needs a signing config), `clean`, `installDebug`
(build + adb-install in one step). First-ever build downloads dependencies and is slower.

> Capture GPS prompts for the Location permission on first launch — granting it is what makes the
> in-app GPS work (the permission must also be declared in `AndroidManifest.xml`, which it is).

## Module map (`js/`)

- `app.js` — top-level UI controller: tabs, tree navigation, keyboard shortcuts, operation queue.
- `yolo-io.js` — `CLASS_MAP`/`VALID_CLASS_IDS` (Damimas 4-class B1–B4) + YOLO parse/serialize.
- `dataset.js` — `DatasetManager`: groups image/label files into per-tree side objects (web + native).
- `session.js` — `ActiveSession`: in-memory tree state, bbox CRUD, confirmed/suggested links, union-find clusters, serialization.
- `dedup-utils.js` — pure geometry `suggestPairs()` cross-side duplicate suggester + `createUnionFind()`.
- `results.js` — counting (`compute`), result tables, YOLO/JSON/CSV/identity exports.
- `output-schema.js` — `OutputSchema`: canonical per-tree output JSON ⇄ session JSON.
- `bbox-editor.js` / `dedup-ui.js` / `carousel/carousel-ui.js` — the three annotation surfaces (editor, dedup compare, touch carousel).
- `canvas.js` — `CanvasRenderer`: class colours + detection drawing.
- `capture/` — capture-first flow: `capture-flow.js` (metadata form, per-side capture, **GPS**),
  `capture-source.js` (device camera, native + web), `orbbec-source.js` (Orbbec USB source).
- `detect/detector.js` — on-device YOLO via onnxruntime-web (lazy-loaded; offline on Android).
- `storage/` — `storage-adapter.js` (`Storage.active()` facade) + `fsa-adapter.js` (web File System Access) + `capacitor-adapter.js` (native Filesystem). `persist/session-store.js` = autosave.
- `project.js` / `fs-output.js` — thin facades over the active storage adapter.

## Platform detection (used everywhere)

```js
const native = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
```
Web uses object URLs (`blob:`, revocable); native uses `Capacitor.convertFileSrc(...)` URLs (NOT revocable — never call `URL.revokeObjectURL` on them, see `session.js#loadTree`).

## Android specifics

- `android/app/src/main/java/dev/sawitulm/palmannotate/` — `MainActivity.java` (registers
  `OrbbecPlugin`), `OrbbecPlugin.kt` (USB-host enumeration is real; SDK frame capture is stubbed
  with `TODO(OrbbecSDK)`).
- App id / namespace: `dev.sawitulm.palmannotate`. SDK: min 22, target/compile 34.
- `AndroidManifest.xml` permissions: `INTERNET` + `ACCESS_COARSE/FINE_LOCATION` (for capture GPS).
  **Any runtime permission the WebView requests must be declared here or Android auto-denies it.**
- Installed Capacitor plugins (`capacitor.plugins.json`): filesystem, camera, preferences.
  The Geolocation plugin is NOT installed — capture GPS uses the WebView's `navigator.geolocation`.

## Testing conventions (`test/`)

- Runner: built-in `node:test` + `node:assert`. Files are `*.test.mjs`.
- `test/_harness.mjs` `loadModule(paths, {globals, epilogue})` runs the classic `<script>` sources
  in a `node:vm` context where **`window === globalThis`** (like a browser). Pass co-dependent files
  as an array to concatenate them into one lexical scope (e.g. `['js/yolo-io.js', 'js/results.js']`).
- Modules that attach to `window` are read off the returned context (`ctx.Results`). Modules whose
  functions live at **top level only** (e.g. `dedup-utils.js`) are captured with an `epilogue`:
  `epilogue: 'window.__du = { suggestPairs, createUnionFind };'`.
- `test/dom-stub.mjs` provides a full fake DOM (`makeDom`, `findByText`, `getByText`, `waitFor`) for
  UI-driving tests (see `capture-flow*.test.mjs`).
- Some suites use non-strict `assert` deliberately — cross-realm vm objects fail `deepStrictEqual`.

When you change behaviour, add/adjust a `test/*.test.mjs`; when you touch `index.html`/CSS responsive
breakpoints or the Android manifest, the guard tests are `ui-shell.test.mjs` and `android-config.test.mjs`.

## Gotchas

- Respect the `<script>` load order in `index.html`; a new module that depends on `CLASS_MAP`,
  `createUnionFind`, etc. must load after its dependency.
- The detector assumes a single-class YOLOv8-style export (`[1, 4+nc, N]`) and is **detect-only**
  (every box defaults to class B2 for the expert to relabel). It never throws — failures return `[]`.
- All capture/detector/storage public methods are intentionally non-throwing / degrade gracefully;
  preserve that contract.
