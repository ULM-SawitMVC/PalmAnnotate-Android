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

> **READ THIS BEFORE BUILDING — do not search the disk for a JDK.** `JAVA_HOME` is **not** set
> anywhere in the environment (not Machine/User scope, not the PowerShell profile), and there is **no
> Android Studio install**. A bare `gradlew` fails with `JAVA_HOME is not set` (exit 49). The only JDK
> is the unregistered Temurin at `C:\tools\jdk17\jdk-17.0.19+10` — **set it inline every build** (see
> the block below). The locations in this table are the source of truth; trust them instead of probing.

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
> - **Always force a fresh APK timestamp:** use `clean assembleDebug` for the final compile, not plain
>   `assembleDebug`. Gradle's incremental `UP-TO-DATE` build can leave `app-debug.apk` with an old
>   timestamp even after sync, which is confusing when checking whether the APK is new.
> - Run it at the **end of the turn**, after all edits for that turn are done (one build per turn, not
>   one per file).
> - **Skip the rebuild only** when the turn changed nothing that affects the APK — i.e. edits limited
>   to docs (`CLAUDE.md`, `AGENTS.md`, `docs/`) or `test/*` files. When skipping, say so in one line
>   ("docs/tests only — APK unchanged, not rebuilt") so it's a deliberate choice, not a forgotten step.
> - If the build **fails**, fix it before ending the turn (a red build is never "done"); if it can't be
>   fixed, surface the error and the last-good APK's status explicitly.
> - Do not rely on Gradle incremental output for the final agent build. The expected final command is
>   `clean assembleDebug` so the APK file is regenerated and its timestamp updates.

`npm run sync` / `cap sync` only copies web assets into the Android project; it does **not** produce
an APK. To compile, set the env vars and run the Gradle wrapper. From **PowerShell** at the repo root:

```powershell
$env:JAVA_HOME      = 'C:\tools\jdk17\jdk-17.0.19+10'
$env:ANDROID_HOME   = 'C:\tools\android-sdk'
$env:PATH           = "$env:JAVA_HOME\bin;$env:PATH"

npm run sync                                      # rebuild www/ + push into android/ (do this after any js/css edit)
cd android
.\gradlew.bat clean assembleDebug --no-daemon     # force-regenerate app-debug.apk with a fresh timestamp
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

Use `clean assembleDebug` for agent final rebuilds so `app-debug.apk` is physically regenerated with
an updated timestamp. Other Gradle targets: `assembleRelease` (needs a signing config), `clean`,
`installDebug` (build + adb-install in one step). First-ever build downloads dependencies and is slower.

> Capture GPS prompts for the Location permission on first launch — granting it is what makes the
> in-app GPS work (the permission must also be declared in `AndroidManifest.xml`, which it is).

## On-device testing & verification (adb + DevTools)

**Read this instead of searching — the device, paths, and CDP flow are fixed and known.** Everything
below was reconstructed from scratch once; it should never need rediscovering.

- **Repo root (absolute):** `C:\Users\Zainal\Desktop\PalmAnnotate-Android`. The agent's reported cwd
  may be `...\PalmAnnotate` (no `-Android`) — Glob/PowerShell default-dir searches miss the project;
  **always pass the full path.**
- **adb:** `C:\tools\android-sdk\platform-tools\adb.exe` (not on `PATH`).
- **Device:** Xiaomi Pad 6 (`model:23043RP34G`, `device:pipa`), USB. Get the serial from `adb devices`
  (was `5aa23bd6` — re-check, serials can change). The Orbbec **Gemini 335L** attaches via a **powered
  USB hub**; `Orbbec.isAvailable()` returns `{available:false}` when it's unplugged.
- **JDK / build:** see "Toolchain" + "Compile the Android APK" above (`C:\tools\jdk17\jdk-17.0.19+10`).

Install the fresh APK and relaunch — **a running app keeps the OLD code until restarted**:

```powershell
$adb = 'C:\tools\android-sdk\platform-tools\adb.exe'
$apk = 'C:\Users\Zainal\Desktop\PalmAnnotate-Android\android\app\build\outputs\apk\debug\app-debug.apk'
& $adb install -r $apk
& $adb shell am force-stop dev.sawitulm.palmannotate
& $adb shell monkey -p dev.sawitulm.palmannotate -c android.intent.category.LAUNCHER 1
```

Screenshot (cheapest visual check; pull-to-file avoids PowerShell binary-stdout mangling):

```powershell
& $adb shell screencap -p /sdcard/pa.png ; & $adb pull /sdcard/pa.png "$env:TEMP\pa.png"   # then Read the PNG
```

Inspect the live WebView from the host via Chrome DevTools Protocol — confirms JS modules / native
plugin methods are loaded and lets you `Runtime.evaluate` arbitrary expressions:

```powershell
$procId = (& $adb shell pidof dev.sawitulm.palmannotate).Trim()
& $adb forward tcp:9222 localabstract:webview_devtools_remote_$procId
# GET http://localhost:9222/json/list  -> take .webSocketDebuggerUrl, open it (Node global WebSocket),
#   send {id,method:'Runtime.evaluate',params:{expression:'...',returnByValue:true}}
& $adb forward --remove tcp:9222   # cleanup when done
```

The **live Orbbec depth stream + camera switch only render on the capture screen with the Orbbec
source selected** (built-in camera is the default). Driving that whole flow over CDP is fragile —
for a visual check, have the operator open the capture screen on Orbbec, then take one screenshot.

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
- `storage/` — `storage-adapter.js` (`Storage.active()` facade) + `fsa-adapter.js` (web File System Access) + `capacitor-adapter.js` (native Filesystem) + `saf-store.js` (optional SAF "export folder" — native only, mirrors captures to a user-picked public folder; see Android specifics). `persist/session-store.js` = autosave.
- `project.js` / `fs-output.js` — thin facades over the active storage adapter.

## Platform detection (used everywhere)

```js
const native = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
```
Web uses object URLs (`blob:`, revocable); native uses `Capacitor.convertFileSrc(...)` URLs (NOT revocable — never call `URL.revokeObjectURL` on them, see `session.js#loadTree`).

## Android specifics

- `android/app/src/main/java/dev/sawitulm/palmannotate/` — `MainActivity.java` (registers
  `OrbbecPlugin` + `SafPlugin`), `OrbbecPlugin.kt` (Android USB-host enumeration/permission +
  Orbbec SDK color-frame JPEG capture), `SafPlugin.kt` (Storage Access Framework folder picker +
  `DocumentFile` writes).
- App id / namespace: `dev.sawitulm.palmannotate`. SDK: min 24 (required by Orbbec SDK), target/compile 34.
- **Orbbec SDK:** `android/app/libs/obsensor_v2.0.6_2026031801_release.aar` is vendored from
  `OrbbecSDK-Android-Wrapper-2.0.6.zip` and included with `implementation fileTree(dir: 'libs',
  include: ['*.aar'])`. The plugin's `open()` creates `OBContext`/`Pipeline`, `capture()` returns a
  base64 JPEG color frame, and `close()` releases SDK resources. Built-in camera remains the fallback;
  when Orbbec is attached/available, the side-capture panel shows a Camera selector. Annotation still
  uses RGB, but Orbbec persistence also writes the synchronized depth sidecar with the same stem:
  `dataset/images/field/{TREE}_{side}.jpg`, `dataset/depth/field/{TREE}_{side}.raw`, and
  `dataset/depth/field/{TREE}_{side}.json` plus optional SAF mirror. Orbbec runtime still needs
  real-device + camera validation.
- **Storage root = `Directory.External`** (`capacitor-adapter.js`): all dataset images/labels,
  metadata, Output JSON/TXT and session downloads live under
  `/Android/data/dev.sawitulm.palmannotate/files/PalmAnnotate/…`. This is the only location that,
  on every supported Android version, the app can both write **and** read back through the WebView
  (`convertFileSrc`) without a runtime permission. `Directory.Documents` was used first but fails
  under scoped storage on target SDK 34 (Android 13/14) — captured photos landed nowhere and showed
  "Image unavailable". Files are retrievable via USB/`adb` or the in-app **Download Session** export.
  Delete Tree/Delete Session now removes app-storage images, Orbbec depth sidecars, metadata, Output JSON/TXT, snapshots,
  registry entries, saved handles, in-memory tree refs, and SAF mirror files; native image URLs carry
  a `cacheBust` query so reusing the same variety/block/id cannot show a stale WebView-cached photo.
- **Export folder (SAF):** `SafPlugin.kt` + `js/storage/saf-store.js` let the operator pick a public,
  browsable folder (Documents / SD card / USB-OTG) via the system picker. When set, captures and
  saves are **mirrored** into `<chosen>/PalmAnnotate/…` (best-effort, on top of the reliable
  app-external working store — never replaces it): `dataset/images/field/`, `dataset/metadata/`,
  `Output JSON/`, and `Output TXT/field/`. The chosen tree URI is remembered in SessionStore settings
  (`safFolderUri`/`safFolderName`) and re-verified each use; the picker UI is the "Export folder" row
  on the Sessions home (native only). `deletePath()` + `SafStore.deleteDatasetTree()` remove mirrored
  files during Delete Tree/Delete Session.
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
