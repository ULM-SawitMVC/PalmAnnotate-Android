# Android build guide

PalmAnnotate ships as a native Android app via **Capacitor 6**, wrapping the same
vanilla-JS web app in a WebView. This guide covers prerequisites, debug and
release builds, signing, APK size, SAF export, and Orbbec SDK integration.

For the high-level field flow and dev loop, see the
[README "Android app (Capacitor)" section](../README.md#android-app-capacitor).

## Prerequisites

- **Node.js** 18+ (LTS) and npm — runs `scripts/build-www.mjs` and the Capacitor CLI.
- **Android Studio** (Hedgehog or newer) with the Android SDK + platform-tools.
  Easiest way to get a matching SDK, build-tools, and an emulator/device bridge.
- **JDK 17** — the Capacitor 6 Android Gradle plugin and this project's
  `kotlinOptions.jvmTarget = "17"` require JDK 17. Android Studio bundles a
  compatible JBR; for CLI builds set `JAVA_HOME` to a JDK 17 install.
- **Android minSdk 24** — required by the vendored Orbbec SDK wrapper.

One-time setup:

```bash
npm install        # installs @capacitor/* + onnxruntime-web
npm run sync       # build:www (slim ORT vendor) + cap sync -> android/
```

`npm run sync` runs `scripts/build-www.mjs` (assembles `www/` and vendors the
slim onnxruntime-web wasm runtime) and then `cap sync` (copies `www/` into
`android/app/src/main/assets/public` and updates native plugins). **Re-run it
after any change to `js/`, `index.html`, `css/`, `assets/`, or `models/`.**

## Build from a fresh clone (everything is bundled)

A clean `git clone` contains **everything needed to build a working, fully
offline app** — no extra asset downloads:

- **Detection model** — `models/ffb-detector.onnx` (~38 MB, Ultralytics YOLO26s,
  classes B1–B4) is committed. The APK builds without it (detection just reports
  "unavailable"), but it is included so detection works out of the box.
- **ONNX runtime** — fetched by `npm install` (`onnxruntime-web` dependency);
  `scripts/build-www.mjs` vendors the wasm files into `www/vendor/onnxruntime/`.
- **Orbbec USB camera SDK** — the wrapper AAR is vendored at
  `android/app/libs/obsensor_v2.0.6_2026031801_release.aar` (committed). The
  `OrbbecSDK-Android-Wrapper-*.zip` it was extracted from is **not** needed to
  build and is git-ignored.

End-to-end from nothing:

```bash
git clone https://github.com/ULM-SawitMVC/PalmAnnotate-Android.git
cd PalmAnnotate-Android

# Toolchain (once): JDK 17 + Android SDK (platform-android-34, build-tools 34,
# platform-tools). Point Gradle at the SDK:
#   echo "sdk.dir=/path/to/android-sdk" > android/local.properties
# and export JAVA_HOME to a JDK 17 install.

npm install                 # @capacitor/* + onnxruntime-web
npm test                    # optional: Node test suite (should be all green)
npm run sync                # build:www (vendors ORT) + cap sync -> android/

cd android
./gradlew assembleDebug     # Windows: gradlew.bat assembleDebug
# APK -> android/app/build/outputs/apk/debug/app-debug.apk
```

> **Heads-up — wasm execution provider:** onnxruntime-web 1.19's `ort.min.js`
> loads the **JSEP** wasm variant for the wasm EP, the WebView is not
> cross-origin isolated (no `SharedArrayBuffer`), and ORT loads its wasm proxy
> via dynamic `import()` (which rejects bare relative paths). The detector and
> `build-www.mjs` already account for all three (jsep files vendored,
> `numThreads = 1`, absolute `wasmPaths`). See "APK size notes" below before
> changing the vendored file list.

## Build a debug APK

In Android Studio: open the `android/` folder, let Gradle sync, then **Run** on a
connected device/emulator, or **Build > Build APK(s)**.

From the CLI:

```bash
cd android
./gradlew assembleDebug          # Windows: gradlew.bat assembleDebug
# Output: android/app/build/outputs/apk/debug/app-debug.apk
```

The debug build is signed with the auto-generated Android debug key — fine for
sideloading onto a test tablet, not for distribution.

## Build a release APK / AAB

A release build is **unsigned by default** in this project (the signing config is
a commented template — see below). Once signing is enabled:

```bash
cd android
./gradlew assembleRelease        # APK -> app/build/outputs/apk/release/
./gradlew bundleRelease          # AAB -> app/build/outputs/bundle/release/ (Play)
```

## Generate a keystore and enable signing

`android/app/build.gradle` contains a **commented** `signingConfigs { release { … } }`
template plus a commented `signingConfig signingConfigs.release` line inside
`buildTypes.release`. The template reads credentials from environment variables so
**no secrets are committed**.

### 1. Generate a keystore

Use the JDK's `keytool` (RSA 2048, 10000-day validity). Keep the keystore file
**out of git** and back it up securely — losing it means you can't ship updates
under the same signature.

```bash
keytool -genkeypair -v \
  -keystore release.keystore \
  -alias palmannotate \
  -keyalg RSA -keysize 2048 \
  -validity 10000
```

`keytool` prompts for the store password, a distinguished name, and (optionally)
a separate key password.

### 2. Set the environment variables

The template expects these (names match the comments in `build.gradle`):

| Variable           | Meaning                                               |
|--------------------|-------------------------------------------------------|
| `PA_KEYSTORE`      | Absolute path to the `.keystore`/`.jks`. Defaults to `android/app/release.keystore` when unset. |
| `PA_KEYSTORE_PASS` | Keystore (store) password.                            |
| `PA_KEY_ALIAS`     | Key alias (e.g. `palmannotate`).                      |
| `PA_KEY_PASS`      | Key password (often the same as the store password).  |

macOS / Linux:

```bash
export PA_KEYSTORE="$PWD/android/app/release.keystore"
export PA_KEYSTORE_PASS="********"
export PA_KEY_ALIAS="palmannotate"
export PA_KEY_PASS="********"
```

Windows PowerShell:

```powershell
$env:PA_KEYSTORE      = "$PWD\android\app\release.keystore"
$env:PA_KEYSTORE_PASS = "********"
$env:PA_KEY_ALIAS     = "palmannotate"
$env:PA_KEY_PASS      = "********"
```

### 3. Uncomment the signing config

In `android/app/build.gradle`, uncomment:

1. the entire `signingConfigs { release { … } }` block (above `buildTypes`), and
2. the `signingConfig signingConfigs.release` line inside `buildTypes.release`.

Then `./gradlew assembleRelease` produces a signed APK. Verify with:

```bash
$ANDROID_HOME/build-tools/<version>/apksigner verify --print-certs \
  android/app/build/outputs/apk/release/app-release.apk
```

## Current Android native integrations

### Working storage + SAF export folder

The app's reliable working store is **app-specific external storage** through the
Capacitor Filesystem plugin (`Directory.External`):

```text
/Android/data/dev.sawitulm.palmannotate/files/PalmAnnotate/
  dataset/
  Output JSON/
  Output TXT/
```

This avoids scoped-storage failures that occurred when writing captured photos to
public `Documents` on target SDK 34. Files can still be retrieved through USB/adb
or the in-app **Download Session** export.

For user-browsable copies, `SafPlugin.kt` implements a native
`ACTION_OPEN_DOCUMENT_TREE` folder picker and persists the grant with
`takePersistableUriPermission`. The Sessions home **Export folder** row stores
that tree URI in `SessionStore`; captures, Compute output, and Save Output Again
are mirrored (best-effort) under:

```text
<chosen folder>/PalmAnnotate/
  dataset/images/field/{TREE}_{side}.jpg
  dataset/metadata/{TREE}.json
  Output JSON/{TREE}.json
  Output TXT/field/{TREE}_{side}.txt
```

SAF is additive: failure to mirror into the public folder must not break the
primary app-storage capture flow. The native plugin also exposes `deletePath()`;
`SafStore.deleteDatasetTree()` uses it so Delete Tree/Delete Session removes the
public mirror as well as app-storage files.

### In-app camera capture (WebView getUserMedia)

The capture flow streams the camera **inside the app** — a live `<video>`
preview embedded in the page, not the OS camera activity. This needs
`android.permission.CAMERA` in `AndroidManifest.xml`: Capacitor 6's
`BridgeWebChromeClient.onPermissionRequest` only grants the WebView's
`getUserMedia` request once that runtime permission is declared and allowed
(camera hardware itself is an optional `uses-feature`, so camera-less devices
still install).

Capture is **popup-free**: the operator taps the capture button once per side
(positioned on the right in landscape/tablet, along the bottom in
portrait/phone) and the surface advances to the next side with no per-shot
review. After the last side, a single swipe review allows per-side retake before
**Save**. The implementation lives in `js/capture/capture-source.js`
(`supportsLivePreview()` / `openPreview()` / `grab()`) and
`js/capture/capture-flow.js` (the embedded surface + review). If `getUserMedia`
is unavailable or denied, capture falls back to the one-shot `capture()` path
(file picker on web, Capacitor Camera plugin on native) so it never breaks.

### Orbbec USB camera SDK

`OrbbecPlugin.kt` is wired to the Orbbec Android SDK wrapper AAR:

```text
android/app/libs/obsensor_v2.0.6_2026031801_release.aar
```

The AAR came from `OrbbecSDK-Android-Wrapper-2.0.6.zip` (downloadable from
Orbbec's developer site / GitHub releases) and bundles the Java API, JNI
libraries (`libOrbbecSDK.so`, `libobsensor_jni.so`, etc.), and extension assets.
**The AAR is committed**, so the source zip is *not* required to build — it stays
git-ignored. To update the SDK, drop a new wrapper AAR into `android/app/libs/`.
`android/app/build.gradle` includes it with:

```gradle
implementation fileTree(dir: 'libs', include: ['*.aar'])
```

The Orbbec SDK requires **minSdk 24** (`android/variables.gradle`). Current native methods:

- `isAvailable()` / `listDevices()` — Android USB-host enumeration filtered to
  Orbbec vendor id `0x2BC5`.
- `requestPermission()` — runtime USB permission with a one-shot broadcast
  receiver (`FLAG_MUTABLE`, `RECEIVER_NOT_EXPORTED`).
- `open()` — creates `OBContext`, opens the first SDK-visible device, selects
  color/depth profiles, and starts a `Pipeline` on a single worker thread.
- `startPreview()` — starts a dedicated preview pump that is the only pipeline
  reader while live preview is running. It emits throttled RGB frames plus a
  colorized depth PiP through Capacitor listener events.
- `capture()` — returns a full-resolution color frame as base64 JPEG plus
  dimensions and, when available, the synchronized depth sidecar. While preview
  is running, capture is fulfilled by the pump instead of reading the pipeline
  from a second thread. MJPG is passed through; RGB/BGR/RGBA/BGRA/YUYV/UYVY/
  NV21/NV12/I420 are encoded to JPEG in Kotlin.
- `stopPreview()` / `refresh()` / `close()` — stop and join the preview pump
  before releasing or restarting SDK objects. This ordering is intentional: USB-C
  PD role changes can detach the camera while `waitForFrameSet()` is blocked,
  and closing the SDK underneath that reader can crash the vendor native layer.

The built-in camera remains PalmAnnotate's safe default capture source and gets
the embedded live preview described above. When an Orbbec USB camera is attached
and `Orbbec.isAvailable()` reports a device, the embedded capture surface shows
an inline **Camera** selector (`Device Camera` / `Orbbec USB camera`). Selecting
Orbbec renders the native RGB preview with a tappable colorized-depth PiP; the
same **Capture** button grabs one full-resolution RGB(+depth) frame per side via
`OrbbecSource.grab()`. The rest of the flow (side-to-side advance,
end-of-capture review, Save) is identical. Android may show a USB permission
dialog on first use. The selected source is remembered for the rest of the
capture flow, but if the Orbbec is unplugged/unavailable the surface falls back
to the device camera.

Current Orbbec persistence keeps the annotation pipeline RGB, but saves depth as
a sidecar with the same tree/side stem for later RGB-D / 4-channel YOLO training:

```text
PalmAnnotate/dataset/images/field/{TREE}_{side}.jpg
PalmAnnotate/dataset/depth/field/{TREE}_{side}.raw
PalmAnnotate/dataset/depth/field/{TREE}_{side}.json
```

The `.raw` file is the SDK depth plane bytes (`uint16le` when the camera reports
Y16/Y10/Y11/Y12 unpacked depth). The per-side depth JSON records width, height,
format, value scale, unit, RGB filename, and alignment note. SAF mirrors the same
files when an export folder is selected. Delete Tree/Delete Session delete depth
sidecars together with RGB/JSON/TXT.

Runtime validation requires a physical Android device with the Orbbec/Gemini
camera attached. A field-tested failure mode is USB-C PD pass-through on hubs:
when the tablet switches from host mode to charging/device mode, Android detaches
the Orbbec immediately. On Xiaomi Pad 6 this shows as `power_role=sink` and
`data_role=device` in `adb shell dumpsys usb`; the required Orbbec mode is host
data. Use wireless ADB for debugging, avoid plugging the tablet into a PC while
capturing, and only use charge-through hubs/tablets that preserve `data_role=host`
while sinking power. The app should survive the detach and show/fall back from
Orbbec, but software cannot keep the camera connected after Android drops host
role.

### Verified Android file lifecycle

Current behavior after device testing:

- Capture writes the reliable app-storage RGB image set, Orbbec depth sidecars
  when present, and metadata first, then mirrors to SAF when configured. If
  native app-storage image persistence does not return an `imageUri`, capture
  aborts and no tree is recorded.
- Compute / Save Output Again writes `Output JSON/{TREE}.json` and
  `Output TXT/{split}/{TREE}_{side}.txt` to app storage and mirrors both to SAF.
- Delete Tree removes that tree's app-storage images, depth sidecars, metadata,
  Output JSON/TXT, in-memory DatasetManager entry, saved output handle, autosave
  snapshot, captured registry entry, and SAF mirror files.
- Delete Session runs the same cleanup for every tree, then removes the session.
- Reusing the same variety/block/tree id is safe: stale files are pre-deleted and
  native image URLs include a cache-busting query string to avoid WebView file
  cache reuse.
- A representative debug export (`PalmAnnotate-Debug.zip`) contains the expected
  folders: `dataset/images/field`, `dataset/metadata`, `Output JSON`, and
  `Output TXT/field`.

## APK size notes

The APK now contains three sizeable offline/runtime payloads when present:

1. **onnxruntime-web wasm** — the detector uses onnxruntime-web's `wasm`
   execution provider only (`executionProviders: ['wasm']` in
   `js/detect/detector.js`). `scripts/build-www.mjs` vendors only:
   - `ort.min.js`
   - `ort-wasm-simd-threaded.jsep.wasm` (~25 MB)
   - `ort-wasm-simd-threaded.jsep.mjs`

   This trims roughly **~40MB** versus copying all of `onnxruntime-web/dist`.
   **It must be the `.jsep.*` pair**, not the plain `ort-wasm-simd-threaded.*`:
   onnxruntime-web 1.19's `ort.min.js` dynamically imports the jsep proxy for the
   wasm EP, so vendoring the non-jsep files made the runtime fail with "no
   available backend found" and silently disabled detection. If you change the
   ORT version or execution provider, re-confirm which wasm files `ort.min.js`
   actually requests (watch the WebView console / DevTools) and update
   `ORT_WASM_EP_FILES` in `scripts/build-www.mjs` accordingly. The detector also
   sets `ort.env.wasm.numThreads = 1` (no SharedArrayBuffer in the WebView) and
   an absolute `ort.env.wasm.wasmPaths` (dynamic `import()` rejects bare paths).

2. **YOLO model weights** — `models/ffb-detector.onnx` (~38 MB) is **committed**
   (see `.gitignore`: `models/*.onnx` is ignored except this canonical file) so a
   fresh clone builds a working offline detector. `scripts/build-www.mjs` copies
   `models/` into `www/`, and `cap sync` bundles it into the APK. Swap models by
   replacing that file (keep the name) and re-running `npm run sync`.

3. **Orbbec SDK AAR** — `obsensor_v2.0.6_2026031801_release.aar` contributes the
   Orbbec Java API, native `.so` files, and SDK assets.

## Deferred work

### Offline fonts

The web app may reference system/CDN fonts. For a guaranteed-offline field
device, **self-host** the fonts:

1. Add the font files (e.g. `.woff2`) under `assets/fonts/` — that folder is
   already copied verbatim into `www/` by `scripts/build-www.mjs`.
2. Declare them with `@font-face` in the CSS (`src: url('assets/fonts/...')`)
   and remove any external font `<link>`/`@import` so nothing reaches a CDN.
3. Re-run `npm run sync` to bundle them into the APK.

This keeps typography consistent on devices with no network and avoids the brief
fallback-font flash on cold start.
