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

### Orbbec USB camera SDK

`OrbbecPlugin.kt` is wired to the Orbbec Android SDK wrapper AAR:

```text
android/app/libs/obsensor_v2.0.6_2026031801_release.aar
```

The AAR came from `OrbbecSDK-Android-Wrapper-2.0.6.zip` and bundles the Java API,
JNI libraries (`libOrbbecSDK.so`, `libobsensor_jni.so`, etc.), and extension
assets. `android/app/build.gradle` includes it with:

```gradle
implementation fileTree(dir: 'libs', include: ['*.aar'])
```

The Orbbec SDK requires **minSdk 24** (`android/variables.gradle`). Current native
methods:

- `isAvailable()` / `listDevices()` — Android USB-host enumeration filtered to
  Orbbec vendor id `0x2BC5`.
- `requestPermission()` — runtime USB permission with a one-shot broadcast
  receiver (`FLAG_MUTABLE`, `RECEIVER_NOT_EXPORTED`).
- `open()` — creates `OBContext`, opens the first SDK-visible device, selects a
  capturable color profile, and starts a `Pipeline` on a single worker thread.
- `capture()` — waits for a color frame and returns base64 JPEG plus dimensions.
  MJPG is passed through; RGB/BGR/RGBA/BGRA/YUYV/UYVY/NV21/NV12/I420 are encoded
  to JPEG in Kotlin.
- `close()` — stops and releases the pipeline, device, and SDK context.

The built-in camera remains PalmAnnotate's safe default capture source. When an
Orbbec USB camera is attached and `Orbbec.isAvailable()` reports a device, the
side-capture panel shows a **Camera** selector with `Device Camera` and
`Orbbec USB camera`; choose Orbbec before tapping **Capture**. Android may show a
USB permission dialog on first use. The selected source is remembered for the
rest of the capture flow, but if the Orbbec is unplugged/unavailable the panel
falls back to the device camera.

Current Orbbec persistence is RGB-only: the plugin captures one color frame,
encodes it as JPEG, and stores it through the normal PalmAnnotate image path
`dataset/images/field/{TREE}_{side}.jpg` plus optional SAF mirror. The app does
**not** currently save a depth frame or `dataset/depth/...` mirror. Depth support
requires an explicit follow-up design because the annotation pipeline and YOLO
labels consume RGB images only today; if enabled later, depth files should use the
same stem as RGB, for example `dataset/depth/field/{TREE}_{side}.png` or `.bin`,
and cleanup must delete them together with RGB/JSON/TXT.

Runtime validation still requires a physical Android device with the Orbbec/Gemini
camera attached.

### Verified Android file lifecycle

Current behavior after device testing:

- Capture writes the reliable app-storage image set and metadata first, then
  mirrors to SAF when configured. If native app-storage image persistence does
  not return an `imageUri`, capture aborts and no tree is recorded.
- Compute / Save Output Again writes `Output JSON/{TREE}.json` and
  `Output TXT/{split}/{TREE}_{side}.txt` to app storage and mirrors both to SAF.
- Delete Tree removes that tree's app-storage images, metadata, Output JSON/TXT,
  in-memory DatasetManager entry, saved output handle, autosave snapshot, captured
  registry entry, and SAF mirror files.
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
   - `ort-wasm-simd-threaded.wasm`
   - `ort-wasm-simd-threaded.mjs`

   This trims roughly **~50MB** versus copying all of `onnxruntime-web/dist`.
   If the detector's execution provider changes (for example WebGPU/JSEP), update
   `ORT_WASM_EP_FILES` in `scripts/build-www.mjs`.

2. **YOLO model weights** — any local `models/*.onnx` is copied into `www/` and
   then into the APK for fully offline detection. The weights stay gitignored.

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
